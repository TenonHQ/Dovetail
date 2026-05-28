/* Standalone Prompt Lints page. Loads the global lint-event log and live-updates
 * via the shared /api/claude-plans/stream SSE feed (lint:upsert / lint:delete).
 * ES5-style to match the dashboard's other public scripts. */
(function () {
  "use strict";

  var events = new Map(); // id -> event

  // Active filters. status: "all" | "needs-improvement" | "good".
  // buckets: map of "low"/"mid"/"high" -> true (multi-select, empty = all).
  // source: a single source string, or null = all. query: lowercased substring.
  var filters = { status: "all", buckets: {}, source: null, query: "" };

  var els = {
    tbody: document.getElementById("pl-tbody"),
    table: document.getElementById("pl-table"),
    empty: document.getElementById("pl-empty"),
    noMatch: document.getElementById("pl-no-match"),
    summary: document.getElementById("pl-summary"),
    storage: document.getElementById("cp-storage"),
    filters: document.getElementById("pl-filters"),
    sources: document.getElementById("pl-sources"),
    searchInput: document.getElementById("pl-search-input"),
    searchClear: document.getElementById("pl-search-clear")
  };

  // Bound the initial load — the global lint log is append-only and can grow
  // large. Live SSE events keep the in-memory view current beyond this window.
  var PAGE_LIMIT = 200;

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

  function scoreBucket(score) {
    if (typeof score !== "number") return null;
    if (score < 40) return "low";
    if (score < 70) return "mid";
    return "high";
  }

  // Classify an event as "needs-improvement" / "good" / "unknown". Prefer the
  // hook's outcome ("nag" = under-specified, "format" = strong); fall back to
  // score-vs-threshold for legacy events recorded before outcome existed.
  function lintStatus(e) {
    if (e.outcome === "nag") return "needs-improvement";
    if (e.outcome === "format") return "good";
    if (typeof e.score !== "number") return "unknown";
    var threshold = typeof e.threshold === "number" ? e.threshold : 50;
    if (e.score < threshold) return "needs-improvement";
    if (e.score >= 70) return "good";
    return "unknown";
  }

  function matchesFilters(e) {
    if (filters.status !== "all" && lintStatus(e) !== filters.status) return false;
    var activeBuckets = Object.keys(filters.buckets);
    if (activeBuckets.length && filters.buckets[scoreBucket(e.score)] !== true) return false;
    if (filters.source !== null && (e.source || "") !== filters.source) return false;
    if (filters.query) {
      var hay = ((e.prompt_excerpt || "") + " " + (e.missing || []).join(" ")).toLowerCase();
      if (hay.indexOf(filters.query) === -1) return false;
    }
    return true;
  }

  function sorted() {
    return Array.from(events.values()).sort(function (a, b) {
      var c = (b.timestamp || "").localeCompare(a.timestamp || "");
      if (c !== 0) return c;
      return (b.id || "").localeCompare(a.id || "");
    });
  }

  function filtered() {
    return sorted().filter(matchesFilters);
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

    var statusCell = document.createElement("td");
    var status = lintStatus(e);
    if (status === "needs-improvement") {
      statusCell.innerHTML = '<span class="pl-status pl-status--needs">Needs work</span>';
    } else if (status === "good") {
      statusCell.innerHTML = '<span class="pl-status pl-status--good">Good</span>';
    } else {
      statusCell.textContent = "—";
    }
    tr.appendChild(statusCell);

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

  function isFiltering() {
    return (
      filters.status !== "all" ||
      Object.keys(filters.buckets).length > 0 ||
      filters.source !== null ||
      !!filters.query
    );
  }

  function render(newId) {
    var total = events.size;
    var list = filtered();
    els.tbody.innerHTML = "";

    if (!total) {
      els.empty.hidden = false;
      els.noMatch.hidden = true;
      els.table.hidden = true;
      els.summary.textContent = "";
      return;
    }

    els.empty.hidden = true;

    if (!list.length) {
      els.noMatch.hidden = false;
      els.table.hidden = true;
      els.summary.textContent = "0 of " + total + (total === 1 ? " event" : " events");
      return;
    }

    els.noMatch.hidden = true;
    els.table.hidden = false;
    for (var i = 0; i < list.length; i++) {
      els.tbody.appendChild(rowFor(list[i], list[i].id === newId));
    }

    var noun = total === 1 ? " event" : " events";
    if (isFiltering()) {
      els.summary.textContent = list.length + " of " + total + noun;
    } else {
      els.summary.textContent =
        total + noun + (total >= PAGE_LIMIT ? " (latest " + PAGE_LIMIT + ")" : "");
    }
  }

  /* ─── Filter UI ─────────────────────────────────────────────────────────── */

  function renderSources() {
    if (!els.sources) return;
    var counts = {};
    events.forEach(function (e) {
      var s = e.source || "—";
      counts[s] = (counts[s] || 0) + 1;
    });
    var labels = Object.keys(counts).sort();
    els.sources.innerHTML = "";
    // A lone source carries no signal — hide the group until there's a choice.
    if (labels.length < 2) return;
    for (var i = 0; i < labels.length; i++) {
      els.sources.appendChild(sourceChip(labels[i], counts[labels[i]]));
    }
  }

  function sourceChip(label, count) {
    var value = label === "—" ? "" : label;
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "pl-chip" + (filters.source === value ? " pl-chip--active" : "");
    chip.appendChild(document.createTextNode(label + " "));
    var c = document.createElement("span");
    c.className = "pl-chip-count";
    c.textContent = String(count);
    chip.appendChild(c);
    chip.addEventListener("click", function () {
      filters.source = filters.source === value ? null : value;
      renderSources();
      render(null);
    });
    return chip;
  }

  function setupFilters() {
    var segs = els.filters ? els.filters.querySelectorAll(".pl-seg") : [];
    for (var i = 0; i < segs.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          filters.status = btn.getAttribute("data-status");
          for (var j = 0; j < segs.length; j++) {
            segs[j].classList.toggle("pl-seg--active", segs[j] === btn);
          }
          render(null);
        });
      })(segs[i]);
    }

    var buckets = els.filters ? els.filters.querySelectorAll(".pl-chip[data-bucket]") : [];
    for (var k = 0; k < buckets.length; k++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          var key = btn.getAttribute("data-bucket");
          if (filters.buckets[key]) delete filters.buckets[key];
          else filters.buckets[key] = true;
          btn.classList.toggle("pl-chip--active", !!filters.buckets[key]);
          render(null);
        });
      })(buckets[k]);
    }

    if (els.searchInput) {
      els.searchInput.addEventListener("input", function () {
        filters.query = els.searchInput.value.trim().toLowerCase();
        if (els.searchClear) els.searchClear.hidden = !els.searchInput.value;
        render(null);
      });
    }
    if (els.searchClear) {
      els.searchClear.addEventListener("click", function () {
        els.searchInput.value = "";
        filters.query = "";
        els.searchClear.hidden = true;
        render(null);
        els.searchInput.focus();
      });
    }
  }

  function loadInitial() {
    return fetch("/api/prompt-lints?limit=" + PAGE_LIMIT)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        (data.events || []).forEach(function (e) {
          if (e && e.id) events.set(e.id, e);
        });
        if (els.storage && data.storage) els.storage.textContent = data.storage;
        renderSources();
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
          renderSources();
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
    setupFilters();
    loadInitial().then(startStream);
  });
})();
