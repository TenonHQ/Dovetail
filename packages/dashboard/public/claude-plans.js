/* /claude-plans page logic.
 * - Fetches initial state from REST.
 * - Subscribes to /api/claude-plans/stream (SSE) for live updates.
 * - Renders markdown via marked + DOMPurify, Mermaid via mermaid.run().
 */

(function () {
  "use strict";

  if (window.mermaid && typeof window.mermaid.initialize === "function") {
    window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });
  }
  if (window.marked && typeof window.marked.setOptions === "function") {
    window.marked.setOptions({ breaks: true, gfm: true });
  }

  var state = {
    plans: new Map(),       // slug -> plan
    artifacts: new Map(),   // slug -> Map<artifactSlug, artifact>
    selectedSlug: null,
    activeTab: "plan"
  };

  var els = {
    storage: document.getElementById("cp-storage"),
    list: document.getElementById("cp-list"),
    count: document.getElementById("cp-count"),
    railEmpty: document.getElementById("cp-rail-empty"),
    detailEmpty: document.getElementById("cp-detail-empty"),
    detailBody: document.getElementById("cp-detail-body"),
    detailTitle: document.getElementById("cp-detail-title"),
    detailStatus: document.getElementById("cp-detail-status"),
    detailStamp: document.getElementById("cp-detail-stamp"),
    artifactCount: document.getElementById("cp-artifact-count"),
    planPanel: document.getElementById("cp-tab-plan"),
    artifactsPanel: document.getElementById("cp-tab-artifacts"),
    tabs: document.querySelectorAll(".cp-tab")
  };

  function sortedPlans() {
    return Array.from(state.plans.values()).sort(function (a, b) {
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });
  }

  function sortedArtifacts(slug) {
    var map = state.artifacts.get(slug);
    if (!map) return [];
    return Array.from(map.values()).sort(function (a, b) {
      return (a.created_at || "").localeCompare(b.created_at || "");
    });
  }

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  function showError(msg) {
    var el = document.createElement("div");
    el.style.cssText = "position:fixed;bottom:16px;right:16px;background:var(--danger);color:#fff;padding:8px 14px;border-radius:4px;font-size:13px;z-index:9999";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function renderMarkdown(md, target) {
    if (!window.marked || !window.DOMPurify) {
      target.textContent = md;
      return;
    }
    var html = window.marked.parse(md || "");
    target.innerHTML = window.DOMPurify.sanitize(html);
  }

  function renderMermaid(source, target) {
    target.classList.add("cp-mermaid");
    target.textContent = "";
    if (!window.mermaid || typeof window.mermaid.render !== "function") {
      target.textContent = source;
      return;
    }
    var id = "mmd-" + Math.random().toString(36).slice(2, 10);
    try {
      window.mermaid.render(id, source).then(
        function (out) { target.innerHTML = out.svg; },
        function (err) {
          target.classList.remove("cp-mermaid");
          target.classList.add("cp-mermaid-error");
          target.textContent = "mermaid error: " + (err && err.message ? err.message : String(err));
        }
      );
    } catch (err) {
      target.classList.remove("cp-mermaid");
      target.classList.add("cp-mermaid-error");
      target.textContent = "mermaid error: " + err.message;
    }
  }

  /* ─── Copy helpers ─────────────────────────────────────────────────────────── */

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    ta.remove();
  }

  function makeCopyBtn(label, getText) {
    var btn = document.createElement("button");
    btn.className = "cp-copy-btn";
    btn.textContent = label;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var text = getText();
      var flash = function () {
        btn.textContent = "Copied!";
        btn.classList.add("cp-copy-btn--copied");
        setTimeout(function () {
          btn.textContent = label;
          btn.classList.remove("cp-copy-btn--copied");
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(flash).catch(function () {
          fallbackCopy(text);
          flash();
        });
      } else {
        fallbackCopy(text);
        flash();
      }
    });
    return btn;
  }

  function addTabsCopyAll(plan, artifacts) {
    var existing = document.getElementById("cp-tabs-copy-all");
    if (existing) existing.remove();

    var btn = makeCopyBtn("Copy All", function () {
      if (state.activeTab === "artifacts") {
        return artifacts.map(function (a) {
          return "# " + a.title + "\n\n" + a.content;
        }).join("\n\n---\n\n");
      }
      return plan.content_md && plan.content_md.trim()
        ? plan.content_md
        : els.planPanel.innerText.trim();
    });
    btn.id = "cp-tabs-copy-all";
    btn.style.marginLeft = "auto";
    var tabsEl = document.querySelector(".cp-tabs");
    if (tabsEl) tabsEl.appendChild(btn);
  }

  function addPlanSectionCopyBtns() {
    var structured = els.planPanel.querySelector(".cp-structured");
    if (!structured) return;
    var children = Array.from(structured.children);
    children.forEach(function (child) {
      child.classList.add("cp-c-copy-wrap");
      var group = document.createElement("div");
      group.className = "cp-copy-btn-group";
      var btn = makeCopyBtn("Copy", (function (el) {
        return function () { return el.innerText.trim(); };
      })(child));
      group.appendChild(btn);
      child.appendChild(group);
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────── */

  function renderRail() {
    var plans = sortedPlans();
    els.count.textContent = String(plans.length);
    if (plans.length === 0) {
      els.railEmpty.style.display = "block";
      els.list.innerHTML = "";
      return;
    }
    els.railEmpty.style.display = "none";
    els.list.innerHTML = "";
    plans.forEach(function (plan) {
      var artifactCount = (state.artifacts.get(plan.slug) || new Map()).size;
      var li = document.createElement("li");
      li.className = "cp-list-item" + (plan.slug === state.selectedSlug ? " active" : "");
      li.tabIndex = 0;
      li.dataset.slug = plan.slug;
      li.innerHTML =
        '<div class="cp-list-row">' +
        '  <span class="cp-list-title"></span>' +
        '  <span class="cp-status-pill cp-status-' + plan.status + '">' + plan.status + '</span>' +
        '</div>' +
        '<div class="cp-list-meta">' +
        '  <span class="cp-list-meta-slug"></span>' +
        '  <span class="cp-artifact-badge">' + artifactCount + ' artifact' + (artifactCount === 1 ? '' : 's') + '</span>' +
        '</div>';
      li.querySelector(".cp-list-title").textContent = plan.title;
      li.querySelector(".cp-list-meta-slug").textContent = plan.slug;
      li.addEventListener("click", function () { selectPlan(plan.slug); });
      li.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectPlan(plan.slug); }
      });
      var delBtn = document.createElement("button");
      delBtn.className = "cp-list-delete";
      delBtn.title = "Delete plan";
      delBtn.textContent = "×";
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!delBtn.dataset.confirm) {
          delBtn.dataset.confirm = "1";
          delBtn.textContent = "?";
          setTimeout(function () {
            delBtn.textContent = "×";
            delete delBtn.dataset.confirm;
          }, 2000);
          return;
        }
        fetch("/api/claude-plans/" + encodeURIComponent(plan.slug), { method: "DELETE" })
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            removePlan(plan.slug);
          })
          .catch(function () {
            delBtn.textContent = "×";
            delete delBtn.dataset.confirm;
            showError("Failed to delete plan. Try again.");
          });
      });
      li.querySelector(".cp-list-row").appendChild(delBtn);
      els.list.appendChild(li);
    });
  }

  function renderDetail() {
    if (!state.selectedSlug || !state.plans.has(state.selectedSlug)) {
      els.detailEmpty.style.display = "block";
      els.detailBody.hidden = true;
      var orphan = document.getElementById("cp-tabs-copy-all");
      if (orphan) orphan.remove();
      return;
    }
    var plan = state.plans.get(state.selectedSlug);
    var artifacts = sortedArtifacts(state.selectedSlug);

    els.detailEmpty.style.display = "none";
    els.detailBody.hidden = false;
    els.detailTitle.textContent = plan.title;
    els.detailStatus.textContent = plan.status;
    els.detailStatus.className = "cp-status-pill cp-status-" + plan.status;
    els.detailStamp.textContent = "updated " + fmtTime(plan.updated_at);
    els.artifactCount.textContent = String(artifacts.length);

    var existingPrBadge = document.getElementById("cp-pr-badge");
    if (existingPrBadge) existingPrBadge.remove();
    if (plan.pr_url) {
      var prBadge = document.createElement("a");
      prBadge.id = "cp-pr-badge";
      prBadge.className = "cp-pr-badge";
      prBadge.href = plan.pr_url;
      prBadge.target = "_blank";
      prBadge.rel = "noopener noreferrer";
      prBadge.textContent = plan.pr_title
        ? "PR #" + plan.pr_number + " — " + plan.pr_title
        : "PR #" + (plan.pr_number || "");
      els.detailStamp.insertAdjacentElement("afterend", prBadge);
    }

    if (plan.content_html) {
      els.planPanel.innerHTML = window.DOMPurify
        ? window.DOMPurify.sanitize(plan.content_html)
        : plan.content_html;
    } else {
      renderMarkdown(plan.content_md, els.planPanel);
    }

    addPlanSectionCopyBtns();
    addTabsCopyAll(plan, artifacts);

    els.artifactsPanel.innerHTML = "";
    if (artifacts.length === 0) {
      var empty = document.createElement("div");
      empty.className = "cp-detail-empty";
      empty.style.padding = "40px 0";
      empty.textContent = "No artifacts yet. Call push_artifact or push_diagram from Claude.";
      els.artifactsPanel.appendChild(empty);
    } else {
      artifacts.forEach(function (artifact) {
        var card = document.createElement("div");
        card.className = "cp-artifact-card";
        var head = document.createElement("div");
        head.className = "cp-artifact-head";
        var title = document.createElement("span");
        title.className = "cp-artifact-title";
        title.textContent = artifact.title;
        var kind = document.createElement("span");
        kind.className = "cp-kind-pill";
        kind.textContent = artifact.kind;
        head.appendChild(title);
        head.appendChild(kind);

        var copyGroup = document.createElement("div");
        copyGroup.className = "cp-copy-btn-group cp-copy-btn-group--artifact";
        copyGroup.appendChild(makeCopyBtn("Copy", (function (content) {
          return function () { return content; };
        })(artifact.content)));
        head.appendChild(copyGroup);

        card.appendChild(head);

        var body = document.createElement("div");
        if (artifact.kind === "mermaid") renderMermaid(artifact.content, body);
        else renderMarkdown(artifact.content, body);
        card.appendChild(body);
        els.artifactsPanel.appendChild(card);
      });
    }
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    els.tabs.forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    els.planPanel.hidden = tab !== "plan";
    els.artifactsPanel.hidden = tab !== "artifacts";
  }

  function selectPlan(slug) {
    state.selectedSlug = slug;
    renderRail();
    renderDetail();
  }

  els.tabs.forEach(function (btn) {
    btn.addEventListener("click", function () { setActiveTab(btn.dataset.tab); });
  });

  function upsertPlan(plan) {
    state.plans.set(plan.slug, plan);
    renderRail();
    if (state.selectedSlug === plan.slug) renderDetail();
  }

  function removePlan(slug) {
    state.plans.delete(slug);
    state.artifacts.delete(slug);
    if (state.selectedSlug === slug) state.selectedSlug = null;
    renderRail();
    renderDetail();
  }

  function upsertArtifact(artifact) {
    var bucket = state.artifacts.get(artifact.plan_slug);
    if (!bucket) {
      bucket = new Map();
      state.artifacts.set(artifact.plan_slug, bucket);
    }
    bucket.set(artifact.slug, artifact);
    renderRail();
    if (state.selectedSlug === artifact.plan_slug) renderDetail();
  }

  function removeArtifact(planSlug, slug) {
    var bucket = state.artifacts.get(planSlug);
    if (!bucket) return;
    bucket.delete(slug);
    renderRail();
    if (state.selectedSlug === planSlug) renderDetail();
  }

  async function loadInitial() {
    try {
      var res = await fetch("/api/claude-plans");
      var data = await res.json();
      if (data && Array.isArray(data.plans)) {
        data.plans.forEach(function (p) { state.plans.set(p.slug, p); });
      }
      if (data && data.storage) els.storage.textContent = data.storage;
    } catch (err) {
      console.warn("[claude-plans] failed to load initial state:", err);
    }
    // Preload artifacts for visible plans
    var slugs = Array.from(state.plans.keys());
    await Promise.all(slugs.map(function (slug) {
      return fetch("/api/claude-plans/" + encodeURIComponent(slug))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && Array.isArray(data.artifacts)) {
            var bucket = new Map();
            data.artifacts.forEach(function (a) { bucket.set(a.slug, a); });
            state.artifacts.set(slug, bucket);
          }
        })
        .catch(function () { /* ignore */ });
    }));
    renderRail();
    if (!state.selectedSlug) {
      var sorted = sortedPlans();
      if (sorted.length > 0) selectPlan(sorted[0].slug);
    }
  }

  function startStream() {
    var es = new EventSource("/api/claude-plans/stream");
    es.addEventListener("plan:upsert", function (e) {
      try { upsertPlan(JSON.parse(e.data).plan); } catch (_) {}
    });
    es.addEventListener("plan:delete", function (e) {
      try { removePlan(JSON.parse(e.data).slug); } catch (_) {}
    });
    es.addEventListener("artifact:upsert", function (e) {
      try { upsertArtifact(JSON.parse(e.data).artifact); } catch (_) {}
    });
    es.addEventListener("artifact:delete", function (e) {
      try {
        var payload = JSON.parse(e.data);
        removeArtifact(payload.plan_slug, payload.slug);
      } catch (_) {}
    });
    es.addEventListener("plan:focus", function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.slug) {
          selectPlan(data.slug);
          var item = els.list.querySelector("[data-slug=\"" + data.slug + "\"]");
          if (item) item.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      } catch (_) {}
    });
    es.onerror = function () { /* EventSource auto-reconnects */ };
  }

  document.addEventListener("DOMContentLoaded", function () {
    setActiveTab("plan");
    loadInitial().then(startStream);
  });
})();
