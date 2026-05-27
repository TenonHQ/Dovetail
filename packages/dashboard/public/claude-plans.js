/* /claude-plans page logic.
 * - Fetches initial state from REST.
 * - Subscribes to /api/claude-plans/stream (SSE) for live updates.
 * - Renders markdown via marked + DOMPurify, Mermaid via mermaid.parse()/render()
 *   with a graceful raw-source fallback when a diagram fails to parse.
 */

(function () {
  "use strict";

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function initMermaid() {
    if (window.mermaid && typeof window.mermaid.initialize === "function") {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: currentTheme() === "dark" ? "dark" : "default",
        securityLevel: "strict",
        // Never inject mermaid's "Syntax error in text" bomb SVG into the page.
        // Bad sources are handled by renderMermaid's graceful fallback instead.
        suppressErrorRendering: true
      });
    }
  }
  initMermaid();

  if (window.marked && typeof window.marked.setOptions === "function") {
    window.marked.setOptions({ breaks: true, gfm: true });
  }

  var state = {
    plans: new Map(),       // slug -> plan
    artifacts: new Map(),   // slug -> Map<artifactSlug, artifact>
    prompts: new Map(),     // slug -> Map<promptSlug, prompt>
    selectedSlug: null,
    activeTab: "plan",
    query: "",              // lowercased search query; "" means show all
    topicFilter: null       // active topic label, null = no topic filter
  };

  var els = {
    storage: document.getElementById("cp-storage"),
    lintsBadge: document.getElementById("cp-lints-badge"),
    list: document.getElementById("cp-list"),
    count: document.getElementById("cp-count"),
    railEmpty: document.getElementById("cp-rail-empty"),
    railNoMatch: document.getElementById("cp-rail-no-match"),
    railNoMatchQ: document.getElementById("cp-rail-no-match-q"),
    searchInput: document.getElementById("cp-search-input"),
    searchClear: document.getElementById("cp-search-clear"),
    detailEmpty: document.getElementById("cp-detail-empty"),
    detailBody: document.getElementById("cp-detail-body"),
    detailTitle: document.getElementById("cp-detail-title"),
    detailStatus: document.getElementById("cp-detail-status"),
    detailStamp: document.getElementById("cp-detail-stamp"),
    artifactCount: document.getElementById("cp-artifact-count"),
    promptCount: document.getElementById("cp-prompt-count"),
    planPanel: document.getElementById("cp-tab-plan"),
    artifactsPanel: document.getElementById("cp-tab-artifacts"),
    promptsPanel: document.getElementById("cp-tab-prompts"),
    questionsPanel: document.getElementById("cp-tab-questions"),
    questionCount: document.getElementById("cp-question-count"),
    stageMap: document.getElementById("cp-stage-map"),
    tabs: document.querySelectorAll(".cp-tab"),
    topics: document.getElementById("cp-topics"),
    topicsCloud: document.getElementById("cp-topics-cloud"),
    topicsCount: document.getElementById("cp-topics-count"),
    topicsEmpty: document.getElementById("cp-topics-empty"),
    topicsClear: document.getElementById("cp-topics-clear")
  };

  function planMatchesTopic(plan, topic) {
    if (!topic) return true;
    var cats = plan.categories;
    if (!cats || !cats.length) return false;
    for (var i = 0; i < cats.length; i++) {
      if (cats[i] === topic) return true;
    }
    return false;
  }

  // True when plan matches q across title, slug, status, plan markdown/html,
  // pr title, and every artifact title + content. Lets you find a plan by any
  // snippet that appears anywhere in or attached to it.
  function planMatchesQuery(plan, q) {
    if (!q) return true;
    var haystacks = [
      plan.title,
      plan.slug,
      plan.status,
      plan.pr_title,
      plan.content_md,
      plan.content_html
    ];
    var bucket = state.artifacts.get(plan.slug);
    if (bucket) {
      bucket.forEach(function (a) {
        haystacks.push(a.title);
        haystacks.push(a.content);
      });
    }
    for (var i = 0; i < haystacks.length; i++) {
      var h = haystacks[i];
      if (h && String(h).toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  }

  function allPlansSorted() {
    return Array.from(state.plans.values()).sort(function (a, b) {
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });
  }

  function sortedPlans() {
    var q = state.query;
    var topic = state.topicFilter;
    var all = allPlansSorted();
    if (!q && !topic) return all;
    return all.filter(function (p) {
      return planMatchesQuery(p, q) && planMatchesTopic(p, topic);
    });
  }

  /* ─── Topics aggregation + render ──────────────────────────────────────────
   * Counts topic occurrences across all plans (not just filtered ones) so the
   * cloud reflects the full corpus. Click a chip to filter the rail by that
   * topic; click the active chip again to clear.
   *
   * Counts are computed client-side from plan.categories arrays — no new
   * server endpoint or SSE event. The existing plan:upsert stream rerenders
   * the cloud automatically because renderRail() now also calls renderTopics().
   */
  function aggregateTopics() {
    var counts = new Map();
    state.plans.forEach(function (plan) {
      var cats = plan.categories;
      if (!cats || !cats.length) return;
      for (var i = 0; i < cats.length; i++) {
        var label = cats[i];
        counts.set(label, (counts.get(label) || 0) + 1);
      }
    });
    var rows = [];
    counts.forEach(function (count, label) {
      rows.push({ label: label, count: count });
    });
    rows.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    });
    return rows;
  }

  // sqrt compression keeps a 30-count topic from dwarfing a 2-count one.
  function topicFontSize(count, max) {
    if (max <= 1) return 14;
    var ratio = Math.sqrt(count) / Math.sqrt(max);
    return Math.round(12 + ratio * 12);
  }

  function renderTopics() {
    if (!els.topicsCloud) return;
    var rows = aggregateTopics();
    if (els.topicsCount) els.topicsCount.textContent = String(rows.length);
    if (els.topicsClear) els.topicsClear.hidden = !state.topicFilter;
    if (rows.length === 0) {
      els.topicsCloud.innerHTML = "";
      if (els.topicsEmpty) {
        els.topicsCloud.appendChild(els.topicsEmpty);
        els.topicsEmpty.style.display = "inline";
      }
      return;
    }
    if (els.topicsEmpty) els.topicsEmpty.style.display = "none";
    els.topicsCloud.innerHTML = "";
    var max = rows[0].count;
    rows.forEach(function (row) {
      var chip = document.createElement("button");
      chip.type = "button";
      var isActive = state.topicFilter === row.label;
      chip.className = "cp-topic-chip" + (isActive ? " cp-topic-chip--active" : "");
      chip.style.fontSize = topicFontSize(row.count, max) + "px";
      chip.setAttribute("aria-pressed", isActive ? "true" : "false");
      chip.title = row.count + " plan" + (row.count === 1 ? "" : "s");
      var labelEl = document.createElement("span");
      labelEl.className = "cp-topic-chip-label";
      labelEl.textContent = row.label;
      var countEl = document.createElement("span");
      countEl.className = "cp-topic-chip-count";
      countEl.textContent = String(row.count);
      chip.appendChild(labelEl);
      chip.appendChild(countEl);
      chip.addEventListener("click", function () {
        applyTopicFilter(state.topicFilter === row.label ? null : row.label);
      });
      els.topicsCloud.appendChild(chip);
    });
  }

  function applyTopicFilter(label) {
    state.topicFilter = label;
    renderTopics();
    renderRail();
    if (label) {
      var visible = sortedPlans();
      var stillVisible = state.selectedSlug &&
        visible.some(function (p) { return p.slug === state.selectedSlug; });
      if (!stillVisible && visible.length > 0) selectPlan(visible[0].slug);
    }
  }

  function setupTopics() {
    if (els.topicsClear) {
      els.topicsClear.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        applyTopicFilter(null);
      });
    }
    if (els.topics) {
      try {
        var stored = localStorage.getItem("cp-topics-collapsed");
        els.topics.open = stored === "0";
      } catch (_) {}
      els.topics.addEventListener("toggle", function () {
        try {
          localStorage.setItem("cp-topics-collapsed", els.topics.open ? "0" : "1");
        } catch (_) {}
      });
    }
  }

  function sortedArtifacts(slug) {
    var map = state.artifacts.get(slug);
    if (!map) return [];
    return Array.from(map.values()).sort(function (a, b) {
      return (a.created_at || "").localeCompare(b.created_at || "");
    });
  }

  function sortedPrompts(slug) {
    var map = state.prompts.get(slug);
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
    el.style.cssText = "position:fixed;bottom:16px;right:16px;background:var(--surface-raised);color:var(--fg);border:1px solid var(--border);border-left:3px solid var(--danger);box-shadow:var(--shadow-2);padding:10px 16px;border-radius:var(--radius-md);font-size:13px;z-index:9999";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function showToast(msg) {
    var el = document.createElement("div");
    el.className = "cp-toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add("cp-toast--visible"); }, 10);
    setTimeout(function () {
      el.classList.remove("cp-toast--visible");
      setTimeout(function () { el.remove(); }, 300);
    }, 2200);
  }

  function renderMarkdown(md, target) {
    if (!window.marked || !window.DOMPurify) {
      target.textContent = md;
      return;
    }
    var html = window.marked.parse(md || "");
    target.innerHTML = window.DOMPurify.sanitize(html);
  }

  // Strip a wrapping markdown code fence and normalize whitespace/line endings.
  // LLM-authored sources often arrive fenced (```mermaid … ```) or with CRLF/BOM,
  // which the parser rejects on line 1.
  function preprocessMermaid(src) {
    var s = src == null ? "" : String(src);
    s = s.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
    s = s.replace(/^\s*```[^\n]*\n/, "").replace(/\n```\s*$/, "");
    return s.trim();
  }

  // Graceful fallback: show the raw source instead of mermaid's "Syntax error"
  // bomb so one bad diagram never poisons the page.
  function renderMermaidFallback(source, target) {
    target.classList.remove("cp-mermaid");
    target.classList.add("cp-mermaid-fallback");
    target.textContent = "";
    var note = document.createElement("div");
    note.className = "cp-mermaid-fallback-note";
    note.textContent = "⚠ Diagram failed to render — showing source";
    var pre = document.createElement("pre");
    var code = document.createElement("code");
    code.textContent = source;
    pre.appendChild(code);
    target.appendChild(note);
    target.appendChild(pre);
  }

  function renderMermaid(source, target) {
    target.classList.remove("cp-mermaid-fallback", "cp-mermaid-error");
    target.classList.add("cp-mermaid");
    target.textContent = "";
    if (!window.mermaid || typeof window.mermaid.render !== "function") {
      renderMermaidFallback(source, target);
      return;
    }
    var clean = preprocessMermaid(source);
    var id = "mmd-" + Math.random().toString(36).slice(2, 10);
    var doRender = function () {
      window.mermaid.render(id, clean).then(
        function (out) { target.innerHTML = out.svg; },
        function () { renderMermaidFallback(source, target); }
      );
    };
    try {
      // Validate before rendering. suppressErrors makes parse resolve false
      // (instead of throwing) on bad source, so we can fall back cleanly.
      if (typeof window.mermaid.parse === "function") {
        window.mermaid.parse(clean, { suppressErrors: true }).then(
          function (ok) { if (ok) { doRender(); } else { renderMermaidFallback(source, target); } },
          function () { renderMermaidFallback(source, target); }
        );
      } else {
        doRender();
      }
    } catch (err) {
      renderMermaidFallback(source, target);
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

  function addTabsCopyAll(plan, artifacts, prompts) {
    var existing = document.getElementById("cp-tabs-copy-all");
    if (existing) existing.remove();

    var btn = makeCopyBtn("Copy All", function () {
      if (state.activeTab === "artifacts") {
        return artifacts.map(function (a) {
          return "# " + a.title + "\n\n" + a.content;
        }).join("\n\n---\n\n");
      }
      if (state.activeTab === "prompts") {
        return prompts.map(function (p) {
          return "# " + p.title + "\n\n" + p.content;
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
    renderTopics();
    var plans = sortedPlans();
    var totalPlans = state.plans.size;
    var isFiltering = !!state.query || !!state.topicFilter;
    els.count.textContent = isFiltering
      ? plans.length + " / " + totalPlans
      : String(totalPlans);
    if (plans.length === 0) {
      els.list.innerHTML = "";
      if (isFiltering && totalPlans > 0) {
        els.railEmpty.style.display = "none";
        els.railNoMatch.hidden = false;
        if (els.railNoMatchQ) {
          var pieces = [];
          if (state.query) pieces.push('"' + state.query + '"');
          if (state.topicFilter) pieces.push("topic “" + state.topicFilter + "”");
          els.railNoMatchQ.textContent = pieces.join(" + ");
        }
      } else {
        els.railEmpty.style.display = "block";
        els.railNoMatch.hidden = true;
      }
      return;
    }
    els.railEmpty.style.display = "none";
    els.railNoMatch.hidden = true;
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
    var prompts = sortedPrompts(state.selectedSlug);

    els.detailEmpty.style.display = "none";
    els.detailBody.hidden = false;
    els.detailTitle.textContent = plan.title;
    els.detailStatus.textContent = plan.status;
    els.detailStatus.className = "cp-status-pill cp-status-" + plan.status;
    els.detailStamp.textContent = "updated " + fmtTime(plan.updated_at);
    els.artifactCount.textContent = String(artifacts.length);
    if (els.promptCount) els.promptCount.textContent = String(prompts.length);

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

    var existingResumeBtn = document.getElementById("cp-resume-btn");
    if (existingResumeBtn) existingResumeBtn.remove();
    var resumeBtn = document.createElement("button");
    resumeBtn.id = "cp-resume-btn";
    resumeBtn.className = "cp-resume-btn";
    resumeBtn.textContent = "Resume";
    resumeBtn.title = "Copy /resume-claude-plans command to clipboard";
    resumeBtn.addEventListener("click", function () {
      var cmd = "/resume-claude-plans " + plan.slug;
      var finish = function () { showToast("Copied! Paste into Claude."); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(finish).catch(function () {
          fallbackCopy(cmd);
          finish();
        });
      } else {
        fallbackCopy(cmd);
        finish();
      }
    });
    els.detailStatus.insertAdjacentElement("afterend", resumeBtn);

    var existingPromptBtn = document.getElementById("cp-gen-prompt-btn");
    if (existingPromptBtn) existingPromptBtn.remove();
    var genPromptBtn = document.createElement("button");
    genPromptBtn.id = "cp-gen-prompt-btn";
    genPromptBtn.className = "cp-resume-btn";
    genPromptBtn.textContent = "Generate Prompt";
    genPromptBtn.title = "Copy /improve-prompt --from-plan <slug> to clipboard";
    genPromptBtn.addEventListener("click", function () {
      var cmd = "/improve-prompt --from-plan " + plan.slug;
      var finish = function () { showToast("Copied — paste into Claude Code."); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(finish).catch(function () {
          fallbackCopy(cmd);
          finish();
        });
      } else {
        fallbackCopy(cmd);
        finish();
      }
    });
    resumeBtn.insertAdjacentElement("afterend", genPromptBtn);

    if (plan.content_html) {
      els.planPanel.innerHTML = window.DOMPurify
        ? window.DOMPurify.sanitize(plan.content_html)
        : plan.content_html;
    } else {
      renderMarkdown(plan.content_md, els.planPanel);
    }

    // v2 surfaces — Stage Map strip + Questions tab.
    renderStageMap(plan);
    renderQuestions(plan);

    addPlanSectionCopyBtns();
    addTabsCopyAll(plan, artifacts, prompts);

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

    els.promptsPanel.innerHTML = "";
    if (prompts.length === 0) {
      var emptyPrompts = document.createElement("div");
      emptyPrompts.className = "cp-detail-empty";
      emptyPrompts.style.padding = "40px 0";
      emptyPrompts.textContent = 'No prompts yet. Click "Generate Prompt" above to seed one, or push from /improve-prompt --push.';
      els.promptsPanel.appendChild(emptyPrompts);
    } else {
      prompts.forEach(function (prompt) {
        var card = document.createElement("div");
        card.className = "cp-artifact-card cp-prompt-card";
        var head = document.createElement("div");
        head.className = "cp-artifact-head";
        var title = document.createElement("span");
        title.className = "cp-artifact-title";
        title.textContent = prompt.title;
        head.appendChild(title);

        if (typeof prompt.score_before === "number" && typeof prompt.score_after === "number") {
          var scorePill = document.createElement("span");
          scorePill.className = "cp-kind-pill cp-prompt-score";
          scorePill.textContent = prompt.score_before + " → " + prompt.score_after + "%";
          head.appendChild(scorePill);
        } else if (typeof prompt.score_after === "number") {
          var scorePillOnly = document.createElement("span");
          scorePillOnly.className = "cp-kind-pill cp-prompt-score";
          scorePillOnly.textContent = prompt.score_after + "%";
          head.appendChild(scorePillOnly);
        }

        var copyGroup = document.createElement("div");
        copyGroup.className = "cp-copy-btn-group cp-copy-btn-group--artifact";
        copyGroup.appendChild(makeCopyBtn("Copy", (function (content) {
          return function () { return content; };
        })(prompt.content)));
        head.appendChild(copyGroup);

        card.appendChild(head);

        if (prompt.source_draft) {
          var details = document.createElement("details");
          details.className = "cp-prompt-source";
          var summary = document.createElement("summary");
          summary.textContent = "Original draft";
          details.appendChild(summary);
          var pre = document.createElement("pre");
          var code = document.createElement("code");
          code.textContent = prompt.source_draft;
          pre.appendChild(code);
          details.appendChild(pre);
          card.appendChild(details);
        }

        var body = document.createElement("pre");
        body.className = "cp-prompt-body";
        var bodyCode = document.createElement("code");
        bodyCode.textContent = prompt.content;
        body.appendChild(bodyCode);
        card.appendChild(body);
        els.promptsPanel.appendChild(card);
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
    if (els.promptsPanel) els.promptsPanel.hidden = tab !== "prompts";
    if (els.questionsPanel) els.questionsPanel.hidden = tab !== "questions";
  }

  /* ─── v2 bidirectional pipeline (Phase E) ──────────────────────────────────
   * Stage Map, Questions tab, Dispatch dialog. Server enforces every safety
   * rule (state machine, conflict resolution, dispatch token); the client
   * just renders state and POSTs intents. The latest set_stage token is
   * cached per-plan so the Dispatch button can hand it back to the live call
   * without a round-trip.
   * ─────────────────────────────────────────────────────────────────────── */

  var PIPELINE_STAGES = [
    "research",
    "pre-stage-improve",
    "planning",
    "post-plan-improve",
    "test-first",
    "code",
    "per-step-review",
    "architectural-review",
    "test-reality",
    "documentation"
  ];

  // Stages whose driving agent isn't shipped yet (matches dispatch.ts).
  // dispatch_stage will raise MissingAgentError for these; the UI greys
  // them out and adds a ⚠ marker.
  var STAGES_MISSING_AGENT = { "test-first": true, "test-reality": true };

  // Per-plan cache of the most recent setStage response. The dispatch
  // button reads token from here. Cleared on plan switch.
  var stageTokenCache = {};

  function v2ApiPath(slug, leaf) { return "/api/claude-plans/" + slug + "/" + leaf; }

  function v2Post(slug, leaf, body) {
    return fetch(v2ApiPath(slug, leaf), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (json) {
        if (!r.ok) {
          var err = new Error(json.message || json.error || ("HTTP " + r.status));
          err.code = json.error;
          err.name = json.name || "ServerError";
          err.status = r.status;
          err.payload = json;
          throw err;
        }
        return json;
      });
    });
  }

  function renderStageMap(plan) {
    var map = els.stageMap;
    if (!map) return;
    map.hidden = false;
    map.innerHTML = "";
    var current = plan.stage || null;
    PIPELINE_STAGES.forEach(function (stage) {
      var pill = document.createElement("button");
      pill.className = "cp-stage";
      if (stage === current) pill.classList.add("cp-stage--current");
      if (STAGES_MISSING_AGENT[stage]) pill.classList.add("cp-stage--missing-agent");
      pill.textContent = stage;
      pill.title = STAGES_MISSING_AGENT[stage]
        ? stage + " — agent not shipped yet (PR #160); dispatch will raise MissingAgentError"
        : stage + " — click to move plan here";
      pill.addEventListener("click", function () {
        v2Post(plan.slug, "stage", { to: stage }).then(function (res) {
          stageTokenCache[plan.slug] = res.token;
          showToast("Stage → " + res.stage + " (token issued)");
        }).catch(function (err) {
          showToast(err.code === "ILLEGAL_TRANSITION"
            ? "Illegal move: " + err.message
            : "Stage move failed: " + err.message);
        });
      });
      // Per-stage Dispatch button (Phase E §3).
      var dispatchBtn = document.createElement("button");
      dispatchBtn.className = "cp-stage-dispatch";
      dispatchBtn.textContent = "▶";
      dispatchBtn.title = "Dispatch a Claude Code session at " + stage;
      dispatchBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openDispatchDialog(plan, stage);
      });
      pill.appendChild(dispatchBtn);
      map.appendChild(pill);
    });
  }

  function openDispatchDialog(plan, stage) {
    // Step 1 — dry-run dispatch. Render the resolved command, then offer
    // a "Confirm live" button that re-POSTs with confirm:true + the
    // cached token for this plan.
    v2Post(plan.slug, "dispatch", { target_stage: stage }).then(function (dryRun) {
      var backdrop = document.createElement("div");
      backdrop.className = "cp-dispatch-dialog";
      var inner = document.createElement("div");
      inner.className = "cp-dispatch-dialog-inner";
      inner.innerHTML =
        "<h3>Dispatch &rarr; " + stage + "</h3>" +
        "<p>Dry-run resolved the following spawn. Confirm to launch a real Claude Code session.</p>" +
        "<pre>" +
          "<strong>command:</strong> " + escapeHtml(dryRun.command) + "\n" +
          "<strong>cwd:</strong>     " + escapeHtml(dryRun.cwd) + "\n" +
          "<strong>plan:</strong>    " + escapeHtml(dryRun.plan_slug) + "\n" +
          "<strong>stage:</strong>   " + escapeHtml(dryRun.target_stage) +
        "</pre>";
      var errorEl = document.createElement("div");
      errorEl.className = "cp-dispatch-error";
      errorEl.hidden = true;
      inner.appendChild(errorEl);

      var actions = document.createElement("div");
      actions.className = "cp-dispatch-dialog-actions";
      var cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", function () { document.body.removeChild(backdrop); });
      var confirm = document.createElement("button");
      confirm.className = "cp-dispatch-confirm";
      confirm.textContent = "Confirm live dispatch";
      confirm.addEventListener("click", function () {
        var token = stageTokenCache[plan.slug];
        if (!token || !token.token) {
          errorEl.hidden = false;
          errorEl.textContent =
            "No fresh dispatch token cached for this plan. Click the stage on the Stage Map first " +
            "to mint one (tokens are 5-min, single-use, stage-bound).";
          return;
        }
        if (token.issued_for_stage !== stage) {
          errorEl.hidden = false;
          errorEl.textContent =
            "Cached token was issued for " + token.issued_for_stage +
            ", not " + stage + ". Click " + stage + " on the Stage Map to issue a matching token.";
          return;
        }
        confirm.disabled = true;
        v2Post(plan.slug, "dispatch", {
          target_stage: stage,
          confirm: true,
          token: token.token
        }).then(function (live) {
          document.body.removeChild(backdrop);
          showToast("Live dispatch launched (pid=" + live.pid + ")");
          delete stageTokenCache[plan.slug];
        }).catch(function (err) {
          confirm.disabled = false;
          errorEl.hidden = false;
          errorEl.textContent = (err.code || "Error") + ": " + err.message;
        });
      });
      actions.appendChild(cancel);
      actions.appendChild(confirm);
      inner.appendChild(actions);
      backdrop.appendChild(inner);
      document.body.appendChild(backdrop);
    }).catch(function (err) {
      if (err.code === "MISSING_AGENT") {
        showToast(stage + ": " + err.message);
      } else {
        showToast("Dispatch dry-run failed: " + err.message);
      }
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderQuestions(plan) {
    if (!els.questionsPanel) return;
    var questions = plan.questions || [];
    els.questionsPanel.innerHTML = "";
    if (els.questionCount) els.questionCount.textContent = String(questions.length);
    if (questions.length === 0) {
      var empty = document.createElement("div");
      empty.className = "cp-detail-empty";
      empty.style.padding = "40px 0";
      empty.textContent = "No questions yet. Call push_question from Claude (or /qa park).";
      els.questionsPanel.appendChild(empty);
      return;
    }
    questions.forEach(function (q) {
      var card = document.createElement("div");
      card.className = "cp-question" + (q.answer ? " cp-question--answered" : "");

      var header = document.createElement("div");
      header.className = "cp-question-header";
      if (q.stage) {
        var stageTag = document.createElement("span");
        stageTag.className = "cp-question-stage";
        stageTag.textContent = q.stage;
        header.appendChild(stageTag);
      }
      if (q.asked_by) {
        var by = document.createElement("span");
        by.textContent = "asked by " + q.asked_by;
        header.appendChild(by);
      }
      card.appendChild(header);

      var qText = document.createElement("div");
      qText.className = "cp-question-q";
      qText.textContent = q.question;
      card.appendChild(qText);

      if (q.answer) {
        var recorded = document.createElement("div");
        recorded.className = "cp-question-recorded";
        recorded.textContent = q.answer;
        var meta = document.createElement("div");
        meta.className = "cp-question-recorded-meta";
        meta.textContent = "answered " +
          (q.answered_by ? "by " + q.answered_by + " " : "") +
          (q.answered_at ? "at " + fmtTime(q.answered_at) : "");
        recorded.appendChild(meta);
        card.appendChild(recorded);
      } else {
        if (q.options && q.options.length) {
          var optsRow = document.createElement("div");
          optsRow.className = "cp-question-options";
          q.options.forEach(function (opt) {
            var b = document.createElement("button");
            b.className = "cp-question-option";
            b.textContent = opt;
            b.addEventListener("click", function () { submitAnswer(plan.slug, q.id, opt); });
            optsRow.appendChild(b);
          });
          card.appendChild(optsRow);
        }
        var form = document.createElement("form");
        form.className = "cp-question-answer-form";
        var input = document.createElement("input");
        input.className = "cp-question-answer-input";
        input.placeholder = "Type an answer…";
        input.required = true;
        var submit = document.createElement("button");
        submit.type = "submit";
        submit.className = "cp-question-answer-submit";
        submit.textContent = "Answer";
        form.appendChild(input);
        form.appendChild(submit);
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          if (!input.value.trim()) return;
          submitAnswer(plan.slug, q.id, input.value.trim());
        });
        card.appendChild(form);
      }

      els.questionsPanel.appendChild(card);
    });
  }

  function submitAnswer(slug, questionId, answer) {
    v2Post(slug, "answers", { question_id: questionId, answer: answer }).then(function () {
      showToast("Answer recorded.");
      // SSE will fan out the plan upsert and re-render naturally.
    }).catch(function (err) {
      showToast("record_answer failed: " + err.message);
    });
  }

  function selectPlan(slug) {
    state.selectedSlug = slug;
    if (window.history && window.history.replaceState) {
      var url = window.location.pathname + "?plan=" + encodeURIComponent(slug);
      window.history.replaceState(null, "", url);
    }
    // Tokens are stage+plan bound — switching plans should not retain
    // tokens from elsewhere (they'd be rejected on the server anyway,
    // but better not to surface a stale token to the operator).
    Object.keys(stageTokenCache).forEach(function (k) {
      if (k !== slug) delete stageTokenCache[k];
    });
    renderRail();
    renderDetail();
  }

  els.tabs.forEach(function (btn) {
    btn.addEventListener("click", function () { setActiveTab(btn.dataset.tab); });
  });

  /* ─── Search ───────────────────────────────────────────────────────────────
   * Filter the rail by title/slug/status/content (plan + artifacts).
   * 120ms debounce keeps typing snappy even with hundreds of plans.
   *
   * Selection rule: when filtering narrows the rail, only auto-select a new
   * plan if the currently selected one is filtered out — picking the first
   * visible match. Don't yank the user off a plan they're already reading.
   */
  var searchDebounce = null;
  function applyQuery(raw) {
    var q = (raw == null ? "" : String(raw)).trim().toLowerCase();
    state.query = q;
    if (els.searchClear) els.searchClear.hidden = q.length === 0;
    renderRail();
    if (q) {
      var visible = sortedPlans();
      var stillVisible = state.selectedSlug &&
        visible.some(function (p) { return p.slug === state.selectedSlug; });
      if (!stillVisible && visible.length > 0) {
        selectPlan(visible[0].slug);
      }
    }
  }

  function setupSearch() {
    if (els.searchInput) {
      els.searchInput.addEventListener("input", function (e) {
        var v = e.target.value;
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(function () { applyQuery(v); }, 120);
      });
      els.searchInput.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          e.preventDefault();
          els.searchInput.value = "";
          applyQuery("");
          els.searchInput.blur();
        }
      });
    }
    if (els.searchClear) {
      els.searchClear.addEventListener("click", function () {
        if (els.searchInput) els.searchInput.value = "";
        applyQuery("");
        if (els.searchInput) els.searchInput.focus();
      });
    }
    // Press "/" anywhere (except in another input) to focus the search box.
    document.addEventListener("keydown", function (e) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      var tag = t && t.tagName;
      var isEditable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        (t && t.isContentEditable);
      if (isEditable) return;
      e.preventDefault();
      if (els.searchInput) {
        els.searchInput.focus();
        els.searchInput.select();
      }
    });
  }

  function upsertPlan(plan) {
    state.plans.set(plan.slug, plan);
    renderRail();
    if (state.selectedSlug === plan.slug) renderDetail();
  }

  function removePlan(slug) {
    state.plans.delete(slug);
    state.artifacts.delete(slug);
    state.prompts.delete(slug);
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

  function upsertPrompt(prompt) {
    var bucket = state.prompts.get(prompt.plan_slug);
    if (!bucket) {
      bucket = new Map();
      state.prompts.set(prompt.plan_slug, bucket);
    }
    bucket.set(prompt.slug, prompt);
    if (state.selectedSlug === prompt.plan_slug) renderDetail();
  }

  function removePrompt(planSlug, slug) {
    var bucket = state.prompts.get(planSlug);
    if (!bucket) return;
    bucket.delete(slug);
    if (state.selectedSlug === planSlug) renderDetail();
  }

  // A lint event "needs attention" if its score fell below the recording
  // threshold (default 50 when no threshold is supplied) or it flagged any
  // missing tags, antipatterns, or ceremony. The badge surfaces that count.
  function lintNeedsAttention(e) {
    if (!e) return false;
    var threshold = typeof e.threshold === "number" ? e.threshold : 50;
    if (typeof e.score === "number" && e.score < threshold) return true;
    if (Array.isArray(e.missing) && e.missing.length) return true;
    if (Array.isArray(e.antipatterns) && e.antipatterns.length) return true;
    if (Array.isArray(e.ceremony) && e.ceremony.length) return true;
    return false;
  }

  function setLintsBadge(count) {
    if (!els.lintsBadge) return;
    if (count > 0) {
      els.lintsBadge.textContent = String(count);
      els.lintsBadge.hidden = false;
    } else {
      els.lintsBadge.hidden = true;
    }
  }

  function loadLintsBadge() {
    return fetch("/api/prompt-lints")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var events = data && Array.isArray(data.events) ? data.events : [];
        setLintsBadge(events.filter(lintNeedsAttention).length);
      })
      .catch(function (err) {
        console.warn("[claude-plans] failed to load prompt lints:", err);
        setLintsBadge(0);
      });
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
    // Preload artifacts + prompts for visible plans
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
          if (data && Array.isArray(data.prompts)) {
            var pBucket = new Map();
            data.prompts.forEach(function (p) { pBucket.set(p.slug, p); });
            state.prompts.set(slug, pBucket);
          }
        })
        .catch(function () { /* ignore */ });
    }));
    renderRail();
    if (!state.selectedSlug) {
      var paramSlug = new URLSearchParams(window.location.search).get("plan");
      var sorted = sortedPlans();
      var target = paramSlug && state.plans.has(paramSlug)
        ? paramSlug
        : (sorted.length > 0 ? sorted[0].slug : null);
      if (target) selectPlan(target);
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
    es.addEventListener("prompt:upsert", function (e) {
      try { upsertPrompt(JSON.parse(e.data).prompt); } catch (_) {}
    });
    es.addEventListener("prompt:delete", function (e) {
      try {
        var payload = JSON.parse(e.data);
        removePrompt(payload.plan_slug, payload.slug);
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

  /* ─── Theme toggle ─────────────────────────────────────────────────────────── */

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("cp-theme", theme); } catch (_) {}
    var btn = document.getElementById("cp-theme-toggle");
    if (btn) {
      btn.textContent = theme === "dark" ? "☀︎" : "☾";
      btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    }
    initMermaid();
  }

  function setupTheme() {
    applyTheme(currentTheme());
    var btn = document.getElementById("cp-theme-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        applyTheme(currentTheme() === "dark" ? "light" : "dark");
        if (state.selectedSlug) renderDetail();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    setupTheme();
    setupSearch();
    setupTopics();
    setActiveTab("plan");
    loadLintsBadge();
    loadInitial().then(startStream);
  });
})();
