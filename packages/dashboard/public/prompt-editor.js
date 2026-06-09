/* Dovetail Prompt Editor — multi-tab HTML prompt drafts.
 *
 * Drafts persist to the claude-plans store via /api/prompt-drafts. The tab you
 * have open is the "active" draft a Claude Code session reads with
 * get_active_prompt_draft; when the session writes an enhanced prompt back with
 * update_prompt_draft, the file changes, the server emits a draft:upsert SSE
 * frame, and we merge it into the matching tab live. */
(function () {
  "use strict";

  var state = {
    drafts: [],        // [{id,title,content,updated_at,...}]
    activeId: null,    // server-side active pointer (the Claude-referenced tab)
    openId: null,      // tab currently shown in the editor (mirrors activeId)
    dirty: false,      // unsaved local edits in the source textarea
    pendingUpsert: null, // a draft:upsert for the open tab deferred while typing
    view: "split"      // edit | split | preview
  };

  var els = {
    tabs: document.getElementById("pe-tabs"),
    editrow: document.getElementById("pe-editrow"),
    title: document.getElementById("pe-title"),
    saveState: document.getElementById("pe-save-state"),
    source: document.getElementById("pe-source"),
    preview: document.getElementById("pe-preview"),
    paneSource: document.getElementById("pe-pane-source"),
    panePreview: document.getElementById("pe-pane-preview"),
    main: document.getElementById("pe-main"),
    viewEdit: document.getElementById("pe-view-edit"),
    viewSplit: document.getElementById("pe-view-split"),
    viewPreview: document.getElementById("pe-view-preview"),
    toast: document.getElementById("pe-toast"),
    toastMsg: document.getElementById("pe-toast-msg"),
    toastLoad: document.getElementById("pe-toast-load"),
    themeToggle: document.getElementById("cp-theme-toggle")
  };

  // ---- API helpers ---------------------------------------------------------

  function api(method, url, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (e) {
          throw new Error(e.error || e.message || ("HTTP " + res.status));
        });
      }
      return res.status === 204 ? null : res.json();
    });
  }

  function loadAll() {
    return api("GET", "/api/prompt-drafts").then(function (data) {
      state.drafts = (data && data.drafts) || [];
      state.activeId = data ? data.active_id : null;
      if (!state.drafts.length) {
        return createDraft();
      }
      // Open the server-active tab, else the first.
      var openTarget = state.activeId && findDraft(state.activeId) ? state.activeId : state.drafts[0].id;
      openDraft(openTarget, true);
      renderTabs();
    });
  }

  function findDraft(id) {
    for (var i = 0; i < state.drafts.length; i++) if (state.drafts[i].id === id) return state.drafts[i];
    return null;
  }

  // ---- Rendering -----------------------------------------------------------

  function renderTabs() {
    els.tabs.textContent = "";
    state.drafts.forEach(function (d) {
      var tab = document.createElement("div");
      tab.className = "pe-tab";
      if (d.id === state.openId) tab.classList.add("is-open");
      if (d.id === state.activeId) tab.classList.add("is-active");
      tab.setAttribute("role", "button");
      tab.title = d.id === state.activeId ? "Active — Claude edits this tab" : "Open tab";

      var dot = document.createElement("span");
      dot.className = "pe-tab-dot";
      dot.title = "Active for Claude";
      tab.appendChild(dot);

      var title = document.createElement("span");
      title.className = "pe-tab-title";
      title.textContent = d.title || "Untitled prompt";
      tab.appendChild(title);

      var close = document.createElement("button");
      close.className = "pe-tab-close";
      close.type = "button";
      close.textContent = "×";
      close.title = "Close tab";
      close.setAttribute("aria-label", "Close " + (d.title || "tab"));
      close.addEventListener("click", function (ev) {
        ev.stopPropagation();
        deleteDraft(d.id);
      });

      tab.addEventListener("click", function () { openDraft(d.id); });
      tab.appendChild(close);
      els.tabs.appendChild(tab);
    });

    var add = document.createElement("button");
    add.className = "pe-newtab";
    add.type = "button";
    add.textContent = "＋";
    add.title = "New prompt tab";
    add.setAttribute("aria-label", "New prompt tab");
    add.addEventListener("click", function () { createDraft(); });
    els.tabs.appendChild(add);
  }

  function renderEditor() {
    var d = findDraft(state.openId);
    if (!d) {
      els.editrow.hidden = true;
      els.main.style.display = "none";
      return;
    }
    els.editrow.hidden = false;
    els.main.style.display = "flex";
    els.title.value = d.title || "";
    els.source.value = d.content || "";
    state.dirty = false;
    setSaveState("saved");
    renderPreview();
  }

  function renderPreview() {
    var raw = els.source.value || "";
    var clean = window.DOMPurify ? window.DOMPurify.sanitize(raw) : escapeHtml(raw);
    els.preview.innerHTML = clean ||
      '<div class="pe-empty">Nothing to preview yet.</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function setSaveState(s) {
    if (s === "saving") els.saveState.textContent = "Saving…";
    else if (s === "saved") els.saveState.textContent = "Saved";
    else if (s === "error") els.saveState.textContent = "Save failed";
    else els.saveState.textContent = "";
  }

  // ---- Mutations -----------------------------------------------------------

  function createDraft() {
    return api("POST", "/api/prompt-drafts", { title: "Untitled prompt", content: "" }).then(function (d) {
      state.drafts.push(d);
      openDraft(d.id);
      renderTabs();
      els.title.focus();
      els.title.select();
    });
  }

  function openDraft(id, skipActivate) {
    if (!findDraft(id)) return;
    state.openId = id;
    state.pendingUpsert = null;
    hideToast();
    renderEditor();
    renderTabs();
    // Opening a tab makes it the Claude-referenced active draft.
    if (!skipActivate && id !== state.activeId) {
      api("POST", "/api/prompt-drafts/active", { id: id }).then(function (r) {
        state.activeId = r.active_id;
        renderTabs();
      }).catch(function () {});
    } else if (skipActivate) {
      state.activeId = state.activeId || id;
    }
  }

  function deleteDraft(id) {
    var d = findDraft(id);
    var label = d && d.title ? d.title : "this prompt";
    if (!window.confirm("Close and delete “" + label + "”?")) return;
    api("DELETE", "/api/prompt-drafts/" + id).then(function (r) {
      state.drafts = state.drafts.filter(function (x) { return x.id !== id; });
      state.activeId = r.active_id;
      if (state.openId === id) {
        if (r.active_id && findDraft(r.active_id)) openDraft(r.active_id, true);
        else if (state.drafts.length) openDraft(state.drafts[0].id, true);
        else { state.openId = null; renderEditor(); }
      }
      renderTabs();
    }).catch(function (e) { window.alert("Delete failed: " + e.message); });
  }

  var saveTimer = null;
  function scheduleSave() {
    state.dirty = true;
    setSaveState("saving");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 600);
  }

  function flushSave() {
    var id = state.openId;
    if (!id) return;
    var body = { title: els.title.value, content: els.source.value };
    api("PUT", "/api/prompt-drafts/" + id, body).then(function (d) {
      var local = findDraft(id);
      if (local) { local.title = d.title; local.content = d.content; local.updated_at = d.updated_at; }
      state.dirty = false;
      setSaveState("saved");
      renderTabs(); // reflect a renamed title in its tab
    }).catch(function () { setSaveState("error"); });
  }

  // ---- SSE live-reload -----------------------------------------------------

  function connectStream() {
    var es = new EventSource("/api/claude-plans/stream");
    es.addEventListener("draft:upsert", function (ev) {
      var d = JSON.parse(ev.data).draft;
      if (!d) return;
      var local = findDraft(d.id);
      if (local) { local.title = d.title; local.updated_at = d.updated_at; }
      else { state.drafts.push(d); }
      renderTabs();

      if (d.id === state.openId) {
        // Same content we already show (our own autosave echo) — ignore.
        if (d.content === els.source.value) { if (local) local.content = d.content; return; }
        if (state.dirty || document.activeElement === els.source) {
          // Don't clobber in-progress typing — offer to load instead.
          state.pendingUpsert = d;
          showToast("Claude updated this prompt");
        } else {
          if (local) local.content = d.content;
          els.source.value = d.content || "";
          renderPreview();
          flashToast("Claude enhanced this prompt");
        }
      } else if (local) {
        local.content = d.content;
      }
    });
    es.addEventListener("draft:delete", function (ev) {
      var id = JSON.parse(ev.data).id;
      state.drafts = state.drafts.filter(function (x) { return x.id !== id; });
      if (state.openId === id) {
        state.openId = state.drafts.length ? state.drafts[0].id : null;
        if (state.openId) openDraft(state.openId, true); else renderEditor();
      }
      renderTabs();
    });
    es.addEventListener("draft:active", function (ev) {
      state.activeId = JSON.parse(ev.data).active_id;
      renderTabs();
    });
    es.onerror = function () { /* EventSource auto-reconnects */ };
  }

  // ---- Toast ---------------------------------------------------------------

  var toastTimer = null;
  function showToast(msg) {
    els.toastMsg.textContent = msg;
    els.toastLoad.hidden = false;
    els.toast.classList.add("is-show");
  }
  function flashToast(msg) {
    els.toastMsg.textContent = msg;
    els.toastLoad.hidden = true;
    els.toast.classList.add("is-show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 2600);
  }
  function hideToast() { els.toast.classList.remove("is-show"); }

  // ---- View toggle ---------------------------------------------------------

  function setView(v) {
    state.view = v;
    els.paneSource.classList.toggle("is-hidden", v === "preview");
    els.panePreview.classList.toggle("is-hidden", v === "edit");
    els.viewEdit.classList.toggle("is-on", v === "edit");
    els.viewSplit.classList.toggle("is-on", v === "split");
    els.viewPreview.classList.toggle("is-on", v === "preview");
    if (v !== "edit") renderPreview();
  }

  // ---- Theme toggle (shared cp-theme key) ----------------------------------

  function initTheme() {
    if (!els.themeToggle) return;
    els.themeToggle.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("cp-theme", next); } catch (e) {}
    });
  }

  // ---- Wire up -------------------------------------------------------------

  els.source.addEventListener("input", function () { scheduleSave(); renderPreview(); });
  els.title.addEventListener("input", function () { scheduleSave(); });
  els.viewEdit.addEventListener("click", function () { setView("edit"); });
  els.viewSplit.addEventListener("click", function () { setView("split"); });
  els.viewPreview.addEventListener("click", function () { setView("preview"); });
  els.toastLoad.addEventListener("click", function () {
    if (state.pendingUpsert) {
      var d = state.pendingUpsert;
      var local = findDraft(d.id);
      if (local) local.content = d.content;
      els.source.value = d.content || "";
      state.dirty = false;
      setSaveState("saved");
      renderPreview();
      state.pendingUpsert = null;
    }
    hideToast();
  });
  // Save immediately if the user navigates away mid-edit.
  window.addEventListener("beforeunload", function () { if (state.dirty) flushSave(); });

  initTheme();
  setView("split");
  loadAll().catch(function (e) {
    els.tabs.innerHTML = '<div class="pe-empty">Could not load drafts: ' + escapeHtml(e.message) + "</div>";
  });
  connectStream();
})();
