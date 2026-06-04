/* promotion-gap-refresh.js — refresh button, freshness indicator, pull state */
/* global window */
(function () {
  var STALE_MINUTES = 60;
  var RATE_LIMIT_MS = 30000;
  var _onRefreshDone = null;

  function elById(id) { return document.getElementById(id); }

  function relativeTime(isoStr) {
    if (!isoStr || isoStr === "absent") return "unknown";
    var diff = Date.now() - new Date(isoStr).getTime();
    var mins = Math.round(diff / 60000);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 minute ago";
    if (mins < 60) return mins + " minutes ago";
    var hrs = Math.round(mins / 60);
    if (hrs === 1) return "1 hour ago";
    return hrs + " hours ago";
  }

  function ageMinutes(isoStr) {
    if (!isoStr || isoStr === "absent") return Infinity;
    return (Date.now() - new Date(isoStr).getTime()) / 60000;
  }

  function updateFreshnessUI(generatedAt) {
    var updatedEl = elById("pg-updated");
    var staleBanner = elById("pg-stale-banner");
    var staleAge = elById("pg-stale-age");

    if (updatedEl) {
      updatedEl.textContent = generatedAt ? ("Last updated: " + relativeTime(generatedAt)) : "";
    }

    if (staleBanner && staleAge) {
      var mins = ageMinutes(generatedAt);
      if (mins > STALE_MINUTES) {
        staleAge.textContent = relativeTime(generatedAt);
        staleBanner.hidden = false;
      } else {
        staleBanner.hidden = true;
      }
    }
  }

  function setRefreshState(busy) {
    var btn = elById("pg-refresh-btn");
    var pullingBanner = elById("pg-pulling-banner");
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? "Pulling…" : "Run Fresh Pull";
    }
    if (pullingBanner) {
      pullingBanner.hidden = !busy;
    }
  }

  function showToast(msg, isError) {
    var container = elById("toast-container");
    if (!container) return;
    var toast = document.createElement("div");
    toast.className = "toast" + (isError ? " toast-error" : "");
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(function () {
      toast.classList.add("toast-fade");
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 400);
    }, 4000);
  }

  function triggerRefresh() {
    setRefreshState(true);
    var btn = elById("pg-refresh-btn");
    if (btn) btn.disabled = true;

    fetch("/api/promotion-gap/refresh", { method: "POST" })
      .then(function (resp) { return resp.json(); })
      .then(function (data) {
        setRefreshState(false);
        if (data.ok) {
          showToast("Pull complete. Reloading data…");
          if (_onRefreshDone) _onRefreshDone();
        } else {
          showToast("Pull failed: " + (data.error || "unknown error"), true);
        }
        setTimeout(function () {
          if (btn) btn.disabled = false;
        }, RATE_LIMIT_MS);
      })
      .catch(function (err) {
        setRefreshState(false);
        showToast("Refresh request failed: " + err.message, true);
        setTimeout(function () {
          if (btn) btn.disabled = false;
        }, RATE_LIMIT_MS);
      });
  }

  function init(opts) {
    _onRefreshDone = (opts && opts.onDone) || null;
    var btn = elById("pg-refresh-btn");
    if (btn) {
      btn.disabled = false;
      btn.addEventListener("click", triggerRefresh);
    }
  }

  window.pgRefresh = {
    init: init,
    updateFreshnessUI: updateFreshnessUI
  };
}());
