/* Standalone Prompt Lints page. Loads the global lint-event log and live-updates
 * via the shared /api/claude-plans/stream SSE feed (lint:upsert / lint:delete).
 * ES5-style to match the dashboard's other public scripts. */
(function () {
  "use strict";

  var events = new Map(); // id -> event

  var els = {
    tbody: document.getElementById("pl-tbody"),
    table: document.getElementById("pl-table"),
    empty: document.getElementById("pl-empty"),
    summary: document.getElementById("pl-summary"),
    storage: document.getElementById("cp-storage")
  };

  function fmtTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  function scoreClass(score) {
    if (typeof score !== "number") return "";
    if (score < 40) return "pl-score-low";
    if (score < 70) return "pl-score-mid";
    return "pl-score-high";
  }

  function sorted() {
    return Array.from(events.values()).sort(function (a, b) {
      return (b.timestamp || "").localeCompare(a.timestamp || "");
    });
  }

  function renderTagCells(missing) {
    var td = document.createElement("td");
    td.className = "pl-missing";
    if (!missing || !missing.length) {
      td.textContent = "—";
      return td;
    }
    for (var i = 0; i < missing.length; i++) {
      var span = document.createElement("span");
      span.className = "pl-tag";
      span.textContent = missing[i];
      td.appendChild(span);
    }
    return td;
  }

  function rowFor(e, isNew) {
    var tr = document.createElement("tr");
    if (isNew) tr.className = "pl-row-new";

    var when = document.createElement("td");
    when.className = "pl-when";
    when.textContent = fmtTime(e.timestamp);
    tr.appendChild(when);

    var score = document.createElement("td");
    score.className = "pl-score " + scoreClass(e.score);
    score.textContent = (typeof e.score === "number" ? e.score : "?") + "%";
    if (typeof e.threshold === "number") score.title = "threshold " + e.threshold + "%";
    tr.appendChild(score);

    tr.appendChild(renderTagCells(e.missing));

    var source = document.createElement("td");
    source.className = "pl-source";
    source.textContent = e.source || "—";
    tr.appendChild(source);

    var excerpt = document.createElement("td");
    excerpt.className = "pl-excerpt";
    excerpt.textContent = e.prompt_excerpt || "—";
    if (e.prompt_excerpt) excerpt.title = e.prompt_excerpt;
    tr.appendChild(excerpt);

    return tr;
  }

  function render(newId) {
    var list = sorted();
    els.tbody.innerHTML = "";
    if (!list.length) {
      els.empty.hidden = false;
      els.table.hidden = true;
      els.summary.textContent = "";
      return;
    }
    els.empty.hidden = true;
    els.table.hidden = false;
    for (var i = 0; i < list.length; i++) {
      els.tbody.appendChild(rowFor(list[i], list[i].id === newId));
    }
    els.summary.textContent = list.length + (list.length === 1 ? " event" : " events");
  }

  function loadInitial() {
    return fetch("/api/prompt-lints")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        (data.events || []).forEach(function (e) {
          if (e && e.id) events.set(e.id, e);
        });
        if (els.storage && data.storage) els.storage.textContent = data.storage;
        render(null);
      })
      .catch(function () { render(null); });
  }

  function startStream() {
    var es = new EventSource("/api/claude-plans/stream");
    es.addEventListener("lint:upsert", function (msg) {
      try {
        var data = JSON.parse(msg.data);
        if (data && data.lint && data.lint.id) {
          events.set(data.lint.id, data.lint);
          render(data.lint.id);
        }
      } catch (_) {}
    });
    es.addEventListener("lint:delete", function (msg) {
      try {
        var data = JSON.parse(msg.data);
        if (data && data.id) {
          events.delete(data.id);
          render(null);
        }
      } catch (_) {}
    });
    es.onerror = function () { /* EventSource auto-reconnects */ };
  }

  /* Theme toggle — mirrors claude-plans.js */
  function currentTheme() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    try {
      var saved = localStorage.getItem("cp-theme");
      if (saved === "dark" || saved === "light") return saved;
    } catch (_) {}
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("cp-theme", theme); } catch (_) {}
    var btn = document.getElementById("cp-theme-toggle");
    if (btn) {
      btn.textContent = theme === "dark" ? "☀︎" : "☾";
      btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    }
  }

  function setupTheme() {
    applyTheme(currentTheme());
    var btn = document.getElementById("cp-theme-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        applyTheme(currentTheme() === "dark" ? "light" : "dark");
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    setupTheme();
    loadInitial().then(startStream);
  });
})();
