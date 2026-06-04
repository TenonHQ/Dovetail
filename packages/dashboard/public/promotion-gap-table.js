/* promotion-gap-table.js — gap matrix render, sort, filter, search */
/* global window */
(function () {
  var state = {
    records: [],
    filter: "all",
    search: "",
    sortKey: "name",
    sortDir: 1
  };

  var RUNGS = ["studio", "yard", "mill", "shop"];

  function isPresent(rec, rung) {
    if (rec.missingFrom && rec.missingFrom.indexOf(rung) >= 0) return false;
    return true;
  }

  function hasGap(rec) {
    return rec.missingFrom && rec.missingFrom.length > 0;
  }

  function missingShop(rec) {
    return rec.missingFrom && rec.missingFrom.indexOf("shop") >= 0;
  }

  function fullyPromoted(rec) {
    return !rec.missingFrom || rec.missingFrom.length === 0;
  }

  function matchesFilter(rec) {
    if (state.filter === "gap") return hasGap(rec);
    if (state.filter === "missing-shop") return missingShop(rec);
    if (state.filter === "promoted") return fullyPromoted(rec);
    return true;
  }

  function matchesSearch(rec) {
    if (!state.search) return true;
    var q = state.search.toLowerCase();
    var name = (rec.name || "").toLowerCase();
    var scope = (rec.scope || "").toLowerCase();
    return name.indexOf(q) >= 0 || scope.indexOf(q) >= 0;
  }

  function rungSortVal(rec, rung) {
    return isPresent(rec, rung) ? 0 : 1;
  }

  function getVal(rec, key) {
    if (key === "name") return (rec.name || "").toLowerCase();
    if (key === "scope") return (rec.scope || "").toLowerCase();
    if (key === "status") return (rec.status || "").toLowerCase();
    if (RUNGS.indexOf(key) >= 0) return rungSortVal(rec, key);
    return "";
  }

  function sortedFiltered() {
    var rows = state.records.filter(function (r) {
      return matchesFilter(r) && matchesSearch(r);
    });
    rows.sort(function (a, b) {
      var av = getVal(a, state.sortKey);
      var bv = getVal(b, state.sortKey);
      if (av < bv) return -state.sortDir;
      if (av > bv) return state.sortDir;
      return 0;
    });
    return rows;
  }

  function dot(present) {
    var el = document.createElement("span");
    el.className = present ? "pg-dot-yes" : "pg-dot-no";
    el.title = present ? "Present" : "Absent";
    return el;
  }

  function statusPill(status) {
    var span = document.createElement("span");
    span.className = "pg-status-pill";
    if (status === "NEW") span.classList.add("pg-status-new");
    else if (status === "CHANGED") span.classList.add("pg-status-changed");
    else if (status === "GONE-UPSTREAM") span.classList.add("pg-status-gone");
    span.textContent = status || "—";
    return span;
  }

  function buildRow(rec) {
    var tr = document.createElement("tr");
    if (rec.status === "GONE-UPSTREAM") tr.classList.add("pg-gone-row");

    var tdName = document.createElement("td");
    var nameDiv = document.createElement("div");
    nameDiv.className = "pg-rec-name";
    nameDiv.textContent = rec.name || rec.key || "—";
    tdName.appendChild(nameDiv);
    tr.appendChild(tdName);

    var tdScope = document.createElement("td");
    tdScope.className = "pg-rec-scope";
    tdScope.textContent = rec.scope || "—";
    tr.appendChild(tdScope);

    var tdStatus = document.createElement("td");
    tdStatus.appendChild(statusPill(rec.status));
    tr.appendChild(tdStatus);

    RUNGS.forEach(function (rung) {
      var td = document.createElement("td");
      td.className = "pg-rung-cell";
      td.appendChild(dot(isPresent(rec, rung)));
      tr.appendChild(td);
    });

    return tr;
  }

  function skelRow() {
    var tr = document.createElement("tr");
    var widths = ["60%", "30%", "50%", "10px", "10px", "10px", "10px"];
    widths.forEach(function (w) {
      var td = document.createElement("td");
      var bar = document.createElement("div");
      bar.className = "pg-skel-bar";
      bar.style.width = w;
      td.appendChild(bar);
      tr.appendChild(td);
    });
    return tr;
  }

  function renderSkeleton() {
    var tbody = document.getElementById("pg-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    for (var i = 0; i < 6; i++) {
      tbody.appendChild(skelRow());
    }
  }

  function render() {
    var tbody = document.getElementById("pg-tbody");
    var countEl = document.getElementById("pg-row-count");
    if (!tbody) return;

    var rows = sortedFiltered();
    tbody.innerHTML = "";

    if (rows.length === 0) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 7;
      td.innerHTML = "<div class=\"pg-empty\"><div class=\"pg-empty-icon\">&#9709;</div>No records match the current filter.</div>";
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      rows.forEach(function (rec) {
        tbody.appendChild(buildRow(rec));
      });
    }

    if (countEl) {
      countEl.textContent = rows.length + " of " + state.records.length + " record(s)";
    }

    RUNGS.concat(["name", "scope", "status"]).forEach(function (k) {
      var arrow = document.getElementById("sa-" + k);
      if (!arrow) return;
      var th = arrow.parentElement;
      if (state.sortKey === k) {
        th.classList.add("sorted");
        arrow.innerHTML = state.sortDir === 1 ? "&#8595;" : "&#8593;";
      } else {
        th.classList.remove("sorted");
        arrow.innerHTML = "&#8597;";
      }
    });
  }

  function setData(records) {
    state.records = records || [];
    render();
  }

  function showEmpty() {
    var tbody = document.getElementById("pg-tbody");
    var countEl = document.getElementById("pg-row-count");
    if (!tbody) return;
    tbody.innerHTML = "<tr><td colspan=\"7\"><div class=\"pg-empty\"><div class=\"pg-empty-icon\">&#9709;</div>No data yet — click <strong>Run Fresh Pull</strong> to run the first pull.</div></td></tr>";
    if (countEl) countEl.textContent = "—";
  }

  function bindControls() {
    document.querySelectorAll(".pg-filter").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".pg-filter").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        state.filter = btn.getAttribute("data-filter") || "all";
        render();
      });
    });

    var search = document.getElementById("pg-search");
    if (search) {
      search.addEventListener("input", function () {
        state.search = search.value;
        render();
      });
    }

    document.querySelectorAll(".pg-table th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () {
        var k = th.getAttribute("data-sort");
        if (state.sortKey === k) {
          state.sortDir = -state.sortDir;
        } else {
          state.sortKey = k;
          state.sortDir = 1;
        }
        render();
      });
    });
  }

  window.pgTable = {
    init: bindControls,
    setData: setData,
    showEmpty: showEmpty,
    renderSkeleton: renderSkeleton
  };
}());
