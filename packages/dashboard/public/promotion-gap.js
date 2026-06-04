/* promotion-gap.js — init: wires pgTable + pgRefresh + pgGantt, loads matrix on page load */
/* global window, pgTable, pgRefresh, pgGantt */
(function () {
  var RUNGS = ["studio", "yard", "mill", "shop"];
  var _records = [];

  function elById(id) { return document.getElementById(id); }

  function fillSummary(data) {
    var s = (data && data.summary) || {};
    var millNotShop = (s.millNotShop && s.millNotShop.total) || 0;
    var yardNotMill = (s.yardNotMill && s.yardNotMill.total) || 0;
    var studioNotYard = (s.studioNotYard && s.studioNotYard.total) || 0;
    var total = (data && data.records && data.records.length) || 0;
    var maxGap = Math.max(millNotShop, yardNotMill, studioNotYard, 1);

    var ids = {
      "sum-studio-not-yard": studioNotYard,
      "sum-yard-not-mill": yardNotMill,
      "sum-mill-not-shop": millNotShop,
      "sum-total": total
    };
    Object.keys(ids).forEach(function (id) {
      var el = elById(id);
      if (el) el.textContent = ids[id];
    });

    function setBar(id, val) {
      var el = elById(id);
      if (el) el.style.width = Math.round((val / maxGap) * 100) + "%";
    }
    setBar("bar-studio", studioNotYard);
    setBar("bar-yard", yardNotMill);
    setBar("bar-mill", millNotShop);

    var summaryEl = elById("pg-summary");
    if (summaryEl) summaryEl.hidden = false;
  }

  function fillPipeline(data) {
    var ages = (data && data.snapshotAges) || {};
    var records = (data && data.records) || [];
    var s = (data && data.summary) || {};

    var snapStudio = elById("snap-studio");
    if (snapStudio) snapStudio.textContent = records.length;

    function gapCount(key) {
      return (s[key] && s[key].total) || 0;
    }

    function setBadge(id, count) {
      var el = elById(id);
      if (!el) return;
      el.innerHTML = "";
      var badge = document.createElement("span");
      var cls = count === 0 ? "ok" : (count < 10 ? "warn" : "danger");
      badge.className = "pg-stage-badge " + cls;
      badge.textContent = count === 0 ? ("" + count + " gap") : ("" + count + " gap" + (count === 1 ? "" : "s"));
      el.appendChild(badge);
    }

    var gapYard = elById("gap-yard");
    var gapMill = elById("gap-mill");
    var gapShop = elById("gap-shop");
    if (gapYard) gapYard.textContent = gapCount("studioNotYard");
    if (gapMill) gapMill.textContent = gapCount("yardNotMill");
    if (gapShop) gapShop.textContent = gapCount("millNotShop");

    setBadge("badge-yard", gapCount("studioNotYard"));
    setBadge("badge-mill", gapCount("yardNotMill"));
    setBadge("badge-shop", gapCount("millNotShop"));

    var pipelineEl = elById("pg-pipeline");
    if (pipelineEl) pipelineEl.hidden = false;

    // Update stage URLs from snapshot ages tooltip
    RUNGS.forEach(function (rung) {
      var age = ages[rung];
      if (!age || age === "absent") return;
    });
  }

  function loadMatrix() {
    pgTable.renderSkeleton();

    fetch("/api/promotion-gap/matrix")
      .then(function (resp) {
        if (resp.status === 404) return null;
        return resp.json();
      })
      .then(function (data) {
        if (!data) {
          pgTable.showEmpty();
          return;
        }
        _records = data.records || [];
        fillSummary(data);
        fillPipeline(data);
        pgTable.setData(_records);
        pgGantt.render(_records);
        pgRefresh.updateFreshnessUI(data.generatedAt);
      })
      .catch(function () {
        pgTable.showEmpty();
      });
  }

  function initThemeToggle() {
    var btn = document.getElementById("cp-theme-toggle");
    if (!btn) return;
    function applyTheme(t) {
      document.documentElement.setAttribute("data-theme", t);
      try { localStorage.setItem("cp-theme", t); } catch (e) {}
    }
    btn.addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme") || "light";
      applyTheme(current === "dark" ? "light" : "dark");
    });
  }

  function bindViewToggle() {
    var ganttWrap = document.getElementById("pg-gantt-wrap");
    var tableWrap = document.querySelector(".pg-table-wrap");
    var tableFooter = document.querySelector(".pg-table-footer");
    var controls = document.querySelector(".pg-controls");

    document.querySelectorAll(".pg-view-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var view = btn.getAttribute("data-view");
        document.querySelectorAll(".pg-view-btn").forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
        var isGantt = view === "gantt";
        if (ganttWrap) ganttWrap.hidden = !isGantt;
        if (tableWrap) tableWrap.hidden = isGantt;
        if (tableFooter) tableFooter.hidden = isGantt;
        var filterBtns = controls && controls.querySelectorAll(".pg-filter");
        var searchWrap = controls && controls.querySelector(".pg-search-wrap");
        if (filterBtns) filterBtns.forEach(function (b) { b.hidden = isGantt; });
        if (searchWrap) searchWrap.hidden = isGantt;
        if (isGantt) pgGantt.render(_records);
      });
    });
  }

  function init() {
    pgTable.init();
    pgRefresh.init({ onDone: loadMatrix });
    initThemeToggle();
    bindViewToggle();
    loadMatrix();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}());
