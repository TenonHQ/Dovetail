/* promotion-gap-gantt.js — Gantt-style pipeline progress chart */
/* global window */
(function () {
  var RUNGS = ["studio", "yard", "mill", "shop"];
  var RUNG_WIDTH = { studio: 25, yard: 50, mill: 75, shop: 100 };
  var RUNG_LABEL = { studio: "Studio", yard: "Yard", mill: "Mill", shop: "Shop" };
  var GROUP_ORDER = ["mill", "yard", "studio"];
  var GROUP_DESC = {
    mill: "In Mill — one promotion from release",
    yard: "In Yard — two promotions from release",
    studio: "In Studio — three promotions from release"
  };

  function makeNameCell(rec) {
    var cell = document.createElement("div");
    cell.className = "pg-gantt-name";
    var n = document.createElement("div");
    n.className = "pg-rec-name";
    n.textContent = rec.name || rec.key || "—";
    var s = document.createElement("div");
    s.className = "pg-rec-scope";
    s.textContent = rec.scope || "";
    cell.appendChild(n);
    cell.appendChild(s);
    return cell;
  }

  function makeTrack(rec) {
    var track = document.createElement("div");
    track.className = "pg-gantt-track";

    // Background grid — 4 equal stage columns
    var grid = document.createElement("div");
    grid.className = "pg-gantt-grid";
    RUNGS.forEach(function () { grid.appendChild(document.createElement("div")); });
    track.appendChild(grid);

    var w = RUNG_WIDTH[rec.furthestRung] || 0;

    // Filled bar: how far the record has progressed
    if (w > 0) {
      var bar = document.createElement("div");
      bar.className = "pg-gantt-bar " + (rec.furthestRung || "");
      bar.style.width = w + "%";
      track.appendChild(bar);
    }

    // Hatched gap: stages still missing
    if (w < 100) {
      var gap = document.createElement("div");
      gap.className = "pg-gantt-gap";
      gap.style.left = w + "%";
      gap.style.width = (100 - w) + "%";
      track.appendChild(gap);
    }

    return track;
  }

  function makeRow(rec) {
    var row = document.createElement("div");
    row.className = "pg-gantt-row" + (rec.status === "GONE-UPSTREAM" ? " pg-gone-row" : "");
    row.appendChild(makeNameCell(rec));
    row.appendChild(makeTrack(rec));
    return row;
  }

  function makeGroupHeader(rung, count) {
    var hdr = document.createElement("div");
    hdr.className = "pg-gantt-group-hdr";
    var label = document.createElement("span");
    label.className = "pg-gantt-group-label " + rung;
    label.textContent = GROUP_DESC[rung];
    var badge = document.createElement("span");
    badge.className = "pg-gantt-group-count";
    badge.textContent = count + " record" + (count === 1 ? "" : "s");
    hdr.appendChild(label);
    hdr.appendChild(badge);
    return hdr;
  }

  function render(records) {
    var wrap = document.getElementById("pg-gantt-wrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    if (!records || records.length === 0) {
      var empty = document.createElement("div");
      empty.className = "pg-empty";
      empty.innerHTML = "<div class=\"pg-empty-icon\">&#9709;</div>No records to display.";
      wrap.appendChild(empty);
      return;
    }

    // Column header
    var hdr = document.createElement("div");
    hdr.className = "pg-gantt-header";
    var nameHdr = document.createElement("div");
    nameHdr.className = "pg-gantt-name pg-gantt-name-hdr";
    nameHdr.textContent = "Record";
    hdr.appendChild(nameHdr);
    var colsHdr = document.createElement("div");
    colsHdr.className = "pg-gantt-cols-hdr";
    RUNGS.forEach(function (r) {
      var c = document.createElement("div");
      c.className = "pg-gantt-col-hdr " + r;
      c.textContent = RUNG_LABEL[r];
      colsHdr.appendChild(c);
    });
    hdr.appendChild(colsHdr);
    wrap.appendChild(hdr);

    // Group records by furthestRung, closest to release first
    var groups = {};
    GROUP_ORDER.forEach(function (r) { groups[r] = []; });
    records.forEach(function (rec) {
      var rung = rec.furthestRung || "studio";
      if (groups[rung]) groups[rung].push(rec);
    });

    GROUP_ORDER.forEach(function (rung) {
      var recs = groups[rung];
      if (!recs.length) return;
      wrap.appendChild(makeGroupHeader(rung, recs.length));
      recs.forEach(function (rec) { wrap.appendChild(makeRow(rec)); });
    });
  }

  window.pgGantt = { render: render };
}());
