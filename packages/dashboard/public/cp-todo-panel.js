/* Claude Plans — embedded TODO side panel.
 * A self-contained port of todos.js scoped to the drawer on the claude-plans
 * page: open/close toggle (persisted), priority list with add/toggle/edit/
 * remove/drag-reorder over the same /api/todos REST surface, live SSE refresh,
 * and a header badge of the open (not-done) count. It deliberately does NOT
 * touch the theme toggle — claude-plans.js already owns that.
 */
(function () {
  "use strict";

  var drawer = document.getElementById("cp-todo-drawer");
  var toggleBtn = document.getElementById("cp-todo-toggle");
  var closeBtn = document.getElementById("cp-todo-close");
  var badge = document.getElementById("cp-todo-badge");
  if (!drawer || !toggleBtn) return;

  var listEl = document.getElementById("cpt-list");
  var emptyEl = document.getElementById("cpt-empty");
  var summaryEl = document.getElementById("cpt-summary");
  var form = document.getElementById("cpt-add-form");
  var input = document.getElementById("cpt-input");
  var addBtn = document.getElementById("cpt-add-btn");
  var hideDoneEl = document.getElementById("cpt-hide-done");
  var clearDoneBtn = document.getElementById("cpt-clear-done");

  var OPEN_KEY = "cp-todo-open";
  var items = [];          // current ordered items from the server
  var dragId = null;       // id of the row being dragged
  var isEditing = false;   // suppress SSE re-render while editing text

  // ── Open/close ─────────────────────────────────────────────────────────────
  function isOpen() { return drawer.classList.contains("cp-todo-open"); }
  // `silent` skips focus moves — used on the initial persisted-open restore so a
  // page load doesn't yank focus into the panel (and hijack the "/" shortcut).
  function setOpen(open, silent) {
    var wasOpen = isOpen();
    drawer.classList.toggle("cp-todo-open", open);
    drawer.setAttribute("aria-hidden", open ? "false" : "true");
    toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch (e) {}
    if (silent) return;
    if (open) {
      if (input) input.focus();
    } else if (wasOpen && drawer.contains(document.activeElement)) {
      // Don't strand keyboard focus inside the now-aria-hidden subtree.
      toggleBtn.focus();
    }
  }
  toggleBtn.addEventListener("click", function () { setOpen(!isOpen()); });
  if (closeBtn) closeBtn.addEventListener("click", function () { setOpen(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen() && !isEditing) setOpen(false);
  });

  function toast(message, kind) {
    var c = document.getElementById("toast-container");
    if (!c) { if (kind === "error") console.warn(message); return; }
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
    if (hideDoneEl && hideDoneEl.checked) {
      return items.filter(function (it) { return !it.done; });
    }
    return items;
  }

  function updateBadge() {
    if (!badge) return;
    var open = items.filter(function (it) { return !it.done; }).length;
    badge.textContent = String(open);
    badge.hidden = open === 0;
  }

  function render() {
    updateBadge();
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

  if (hideDoneEl) hideDoneEl.addEventListener("change", render);
  if (clearDoneBtn) {
    clearDoneBtn.addEventListener("click", function () {
      api("POST", "/api/todos/clear-done")
        .then(function (r) { applyList(r.list); toast("Cleared " + r.removed + " completed", "success"); })
        .catch(function (e) { toast(e.message, "error"); });
    });
  }

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
    } catch (e) { /* SSE unsupported — panel still works via manual actions */ }
  }

  // Restore persisted open state (default closed). Silent: no focus steal.
  var saved = "0";
  try { saved = localStorage.getItem(OPEN_KEY) || "0"; } catch (e) {}
  setOpen(saved === "1", true);

  load();
  connectStream();
})();
