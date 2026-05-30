/* Dovetail TODO panel client.
 * Renders the priority list, drives add/toggle/edit/remove/reorder via REST,
 * and live-refreshes from the server's SSE stream. List order = priority
 * (index 0 is the top). Reorder is drag-the-handle; on drop we POST the full
 * id order so the server persists one consistent ordering.
 */
(function () {
  "use strict";

  var listEl = document.getElementById("td-list");
  var emptyEl = document.getElementById("td-empty");
  var summaryEl = document.getElementById("td-summary");
  var form = document.getElementById("td-add-form");
  var input = document.getElementById("td-input");
  var addBtn = document.getElementById("td-add-btn");
  var hideDoneEl = document.getElementById("td-hide-done");
  var clearDoneBtn = document.getElementById("td-clear-done");

  var items = [];          // current ordered items from the server
  var dragId = null;       // id of the row being dragged
  var isEditing = false;   // suppress SSE re-render while editing text

  // ── Theme toggle (mirrors the other dashboard pages) ──────────────────────
  (function initTheme() {
    var btn = document.getElementById("cp-theme-toggle");
    if (!btn) return;
    function current() {
      return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    }
    function paint() { btn.textContent = current() === "dark" ? "☀" : "☾"; }
    paint();
    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("cp-theme", next); } catch (e) {}
      paint();
    });
  })();

  function toast(message, kind) {
    var c = document.getElementById("toast-container");
    if (!c) return;
    var t = document.createElement("div");
    t.className = "toast" + (kind ? " toast-" + kind : "");
    t.textContent = message;
    c.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  function api(method, url, body) {
    var opts = { method: method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
        return data;
      });
    });
  }

  function visibleItems() {
    if (hideDoneEl.checked) {
      return items.filter(function (it) { return !it.done; });
    }
    return items;
  }

  function render() {
    if (isEditing) return;
    listEl.innerHTML = "";
    var shown = visibleItems();
    var doneCount = items.filter(function (it) { return it.done; }).length;
    summaryEl.textContent =
      items.length === 0
        ? "No items"
        : items.length + " item" + (items.length === 1 ? "" : "s") + " · " + doneCount + " done";
    emptyEl.style.display = items.length === 0 ? "block" : "none";

    shown.forEach(function (it, idx) {
      listEl.appendChild(renderItem(it, idx));
    });
  }

  function renderItem(it, idx) {
    var li = document.createElement("li");
    li.className = "td-item" + (it.done ? " td-done" : "");
    li.setAttribute("data-id", it.id);

    var handle = document.createElement("span");
    handle.className = "td-handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reprioritize";
    handle.setAttribute("draggable", "true");
    wireDrag(handle, li, it);
    li.appendChild(handle);

    var rank = document.createElement("span");
    rank.className = "td-rank";
    rank.textContent = String(idx + 1);
    li.appendChild(rank);

    var check = document.createElement("input");
    check.type = "checkbox";
    check.className = "td-check";
    check.checked = it.done;
    check.title = it.done ? "Mark not done" : "Mark done";
    check.addEventListener("change", function () {
      api("PATCH", "/api/todos/" + encodeURIComponent(it.id), { done: check.checked })
        .then(function (r) { applyList(r.list); })
        .catch(function (e) { toast(e.message, "error"); check.checked = it.done; });
    });
    li.appendChild(check);

    var text = document.createElement("span");
    text.className = "td-text";
    text.textContent = it.text;
    text.title = "Double-click to edit";
    text.addEventListener("dblclick", function () { beginEdit(li, text, it); });
    li.appendChild(text);

    var del = document.createElement("button");
    del.className = "td-del";
    del.type = "button";
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", function () {
      api("DELETE", "/api/todos/" + encodeURIComponent(it.id))
        .then(function (r) { applyList(r.list); })
        .catch(function (e) { toast(e.message, "error"); });
    });
    li.appendChild(del);

    return li;
  }

  function beginEdit(li, text, it) {
    isEditing = true;
    var editor = document.createElement("input");
    editor.type = "text";
    editor.className = "td-text-edit";
    editor.maxLength = 280;
    editor.value = it.text;
    li.replaceChild(editor, text);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);

    function commit() {
      var next = editor.value.trim();
      isEditing = false;
      if (!next || next === it.text) { render(); return; }
      api("PATCH", "/api/todos/" + encodeURIComponent(it.id), { text: next })
        .then(function (r) { applyList(r.list); })
        .catch(function (e) { toast(e.message, "error"); render(); });
    }
    function cancel() { isEditing = false; render(); }

    editor.addEventListener("blur", commit);
    editor.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); editor.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); editor.removeEventListener("blur", commit); cancel(); }
    });
  }

  // ── Drag-and-drop reorder ─────────────────────────────────────────────────
  function wireDrag(handle, li, it) {
    handle.addEventListener("dragstart", function (e) {
      dragId = it.id;
      li.classList.add("td-dragging");
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.id); }
    });
    handle.addEventListener("dragend", function () {
      dragId = null;
      li.classList.remove("td-dragging");
      Array.prototype.forEach.call(listEl.children, function (c) { c.classList.remove("td-drop-target"); });
    });
    li.addEventListener("dragover", function (e) {
      if (dragId === null || dragId === it.id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      li.classList.add("td-drop-target");
    });
    li.addEventListener("dragleave", function () { li.classList.remove("td-drop-target"); });
    li.addEventListener("drop", function (e) {
      e.preventDefault();
      li.classList.remove("td-drop-target");
      if (dragId === null || dragId === it.id) return;
      reorder(dragId, it.id);
    });
  }

  // Move dragged id to the slot occupied by targetId, then persist full order.
  function reorder(sourceId, targetId) {
    var order = items.map(function (i) { return i.id; });
    var from = order.indexOf(sourceId);
    var to = order.indexOf(targetId);
    if (from === -1 || to === -1) return;
    order.splice(from, 1);
    order.splice(to, 0, sourceId);
    // Optimistic: reorder local items immediately for snappy UX.
    var byId = {};
    items.forEach(function (i) { byId[i.id] = i; });
    items = order.map(function (id) { return byId[id]; });
    render();
    api("POST", "/api/todos/reorder", { ids: order })
      .then(function (r) { applyList(r.list); })
      .catch(function (e) { toast(e.message, "error"); load(); });
  }

  function applyList(list) {
    if (list && Array.isArray(list.items)) {
      items = list.items;
      render();
    }
  }

  // ── Add ───────────────────────────────────────────────────────────────────
  form.addEventListener("submit", function (e) { e.preventDefault(); submitAdd("bottom"); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); submitAdd("top"); }
  });

  function submitAdd(position) {
    var text = input.value.trim();
    if (!text) return;
    addBtn.disabled = true;
    api("POST", "/api/todos", { text: text, position: position })
      .then(function (r) { input.value = ""; applyList(r.list); })
      .catch(function (e) { toast(e.message, "error"); })
      .then(function () { addBtn.disabled = false; input.focus(); });
  }

  hideDoneEl.addEventListener("change", render);
  clearDoneBtn.addEventListener("click", function () {
    api("POST", "/api/todos/clear-done")
      .then(function (r) { applyList(r.list); toast("Cleared " + r.removed + " completed", "success"); })
      .catch(function (e) { toast(e.message, "error"); });
  });

  // ── Load + live updates ─────────────────────────────────────────────────────
  function load() {
    api("GET", "/api/todos")
      .then(function (r) { items = (r.list && r.list.items) || []; render(); })
      .catch(function (e) { toast(e.message, "error"); });
  }

  function connectStream() {
    try {
      var es = new EventSource("/api/todos/stream");
      es.addEventListener("todos:update", function (ev) {
        try {
          var data = JSON.parse(ev.data);
          if (data && data.list) applyList(data.list);
        } catch (e) {}
      });
      es.onerror = function () { /* browser auto-reconnects */ };
    } catch (e) { /* SSE unsupported — page still works via manual actions */ }
  }

  load();
  connectStream();
})();
