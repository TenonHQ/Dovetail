// --- State ---

var scopesData = [];
var updateSetsCache = {};
var modalScopeKey = null;
var modalScopeSysId = null;

// ClickUp state
var activeTask = null;
var clickupTasks = {};
var clickupConfigured = false;
var availableStatuses = [];
var activeStatuses = ["in progress"];
var sidebarOpen = false;
var tasksLoading = false;
var taskSearchQuery = "";
var myTasksOnly = false;
var clickupUserId = null;

// --- API helpers ---

async function api(method, path, body) {
  var opts = {
    method: method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  var resp = await fetch(path, opts);
  if (!resp.ok) {
    var err = await resp.json().catch(function () {
      return { error: "Request failed" };
    });
    throw new Error(err.error || "Request failed");
  }
  return resp.json();
}

// --- Toast ---

function toast(message, type) {
  type = type || "success";
  var container = document.getElementById("toast-container");
  var el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(function () {
    el.remove();
  }, 4000);
}

// --- Load scopes ---

async function loadScopes() {
  try {
    var data = await api("GET", "/api/scopes");
    scopesData = data.scopes;
    renderScopes();
  } catch (e) {
    document.getElementById("scope-grid").innerHTML =
      '<div class="loading">Failed to load scopes: ' + e.message + "</div>";
  }
}

async function loadConfig() {
  try {
    var data = await api("GET", "/api/config");
    document.getElementById("instance-badge").textContent = data.instance;
  } catch (e) {
    // ignore
  }
}

// --- Render Scopes ---

function renderScopes() {
  var grid = document.getElementById("scope-grid");
  grid.innerHTML = "";

  scopesData.forEach(function (scope) {
    var card = document.createElement("div");
    card.className =
      "scope-card" + (scope.selected_update_set ? " has-selection" : "");
    card.id = "card-" + scope.scope;

    var selectedName = scope.selected_update_set
      ? scope.selected_update_set.name
      : "None";
    var selectedId = scope.selected_update_set
      ? scope.selected_update_set.sys_id
      : "";

    // Build activate button HTML if there's an active task
    var activateHtml = "";
    if (activeTask && scope.sys_id) {
      var scopeActivated = activeTask.scopes && activeTask.scopes[scope.scope];
      if (scopeActivated) {
        activateHtml =
          '<button class="btn-activate activated" disabled>Activated</button>';
      } else {
        activateHtml =
          '<button class="btn-activate" onclick="activateScope(\'' +
          scope.scope +
          "', '" +
          scope.sys_id +
          "')\">Activate " +
          (activeTask.customId || activeTask.taskId) +
          "</button>";
      }
    }

    // Build task badge if scope is activated for current task
    var taskBadgeHtml = "";
    if (activeTask && activeTask.scopes && activeTask.scopes[scope.scope]) {
      taskBadgeHtml =
        '<div class="scope-task-badge">' +
        (activeTask.customId || activeTask.taskId) +
        "</div>";
    }

    card.innerHTML =
      '<div class="scope-header">' +
      '<span class="scope-name">' +
      scope.scope +
      "</span>" +
      '<span class="scope-id">' +
      (scope.sys_id ? scope.sys_id.substring(0, 8) + "..." : "not found") +
      "</span>" +
      "</div>" +
      '<div class="display-name">' +
      scope.display_name +
      "</div>" +
      '<select class="update-set-select" id="select-' +
      scope.scope +
      '" onchange="onSelectChange(\'' +
      scope.scope +
      "')\">" +
      '<option value="">-- No Update Set --</option>' +
      '<option value="__loading" disabled>Loading...</option>' +
      "</select>" +
      '<div class="card-actions">' +
      '<button class="btn btn-primary" onclick="openCreateModal(\'' +
      scope.scope +
      "', '" +
      scope.sys_id +
      "')\" " +
      (!scope.sys_id ? "disabled" : "") +
      ">New</button>" +
      '<button class="btn btn-danger" id="close-btn-' +
      scope.scope +
      '" onclick="closeUpdateSet(\'' +
      scope.scope +
      "')\" disabled>Close</button>" +
      '<button class="btn btn-clear" id="clear-btn-' +
      scope.scope +
      '" onclick="clearSelection(\'' +
      scope.scope +
      "')\" " +
      (!scope.selected_update_set ? "disabled" : "") +
      ">Clear</button>" +
      activateHtml +
      "</div>" +
      '<div class="quick-create">' +
      '<input type="text" id="quick-name-' +
      scope.scope +
      '" value="' +
      escapeHtml(scope.suggested_update_set_name || "") +
      '" placeholder="Update set name..." class="quick-create-input" onkeydown="if(event.key===\'Enter\')quickCreateUpdateSet(\'' +
      scope.scope +
      "', '" +
      scope.sys_id +
      "')\" />" +
      '<button class="btn btn-primary btn-small" onclick="quickCreateUpdateSet(\'' +
      scope.scope +
      "', '" +
      scope.sys_id +
      "')\" " +
      (!scope.sys_id ? "disabled" : "") +
      ">Create</button>" +
      "</div>" +
      (scope.selected_update_set
        ? '<div class="selected-badge">Active for push</div>'
        : "") +
      taskBadgeHtml;

    grid.appendChild(card);
    loadUpdateSets(scope.scope, selectedId);
  });
}

async function loadUpdateSets(scope, selectedId) {
  try {
    var data = await api("GET", "/api/update-sets/" + scope);
    updateSetsCache[scope] = data.update_sets;

    var select = document.getElementById("select-" + scope);
    select.innerHTML = '<option value="">-- No Update Set --</option>';

    data.update_sets.forEach(function (us) {
      var option = document.createElement("option");
      option.value = us.sys_id;
      option.textContent = us.name;
      if (us.sys_id === selectedId) option.selected = true;
      select.appendChild(option);
    });

    var closeBtn = document.getElementById("close-btn-" + scope);
    if (closeBtn) closeBtn.disabled = !selectedId;
  } catch (e) {
    var selectEl = document.getElementById("select-" + scope);
    if (selectEl) {
      selectEl.innerHTML = '<option value="" disabled>Failed to load</option>';
    }
  }
}

// --- Update Set Actions ---

async function onSelectChange(scope) {
  var select = document.getElementById("select-" + scope);
  var sysId = select.value;
  var name = select.options[select.selectedIndex]
    ? select.options[select.selectedIndex].textContent
    : "";

  try {
    await api("POST", "/api/select-update-set", {
      scope: scope,
      update_set_sys_id: sysId,
      update_set_name: sysId ? name : null,
    });

    var scopeData = scopesData.find(function (s) {
      return s.scope === scope;
    });
    if (scopeData) {
      scopeData.selected_update_set = sysId
        ? { sys_id: sysId, name: name }
        : null;
    }

    var card = document.getElementById("card-" + scope);
    if (card) {
      if (sysId) {
        card.classList.add("has-selection");
      } else {
        card.classList.remove("has-selection");
      }
    }

    var closeBtn = document.getElementById("close-btn-" + scope);
    if (closeBtn) closeBtn.disabled = !sysId;
    var clearBtn = document.getElementById("clear-btn-" + scope);
    if (clearBtn) clearBtn.disabled = !sysId;

    var badge = card ? card.querySelector(".selected-badge") : null;
    if (sysId && !badge) {
      var b = document.createElement("div");
      b.className = "selected-badge";
      b.textContent = "Active for push";
      card.appendChild(b);
    } else if (!sysId && badge) {
      badge.remove();
    }

    toast(sysId ? "Selected: " + name : "Cleared selection for " + scope);
  } catch (e) {
    toast("Failed to save: " + e.message, "error");
  }
}

async function clearSelection(scope) {
  var select = document.getElementById("select-" + scope);
  if (select) select.value = "";
  await onSelectChange(scope);
}

async function closeUpdateSet(scope) {
  var select = document.getElementById("select-" + scope);
  var sysId = select ? select.value : "";
  if (!sysId) return;

  var name = select.options[select.selectedIndex]
    ? select.options[select.selectedIndex].textContent
    : "";
  if (!confirm('Close update set "' + name + '"?')) return;

  try {
    await api("PATCH", "/api/update-set/" + sysId + "/close");

    await api("POST", "/api/select-update-set", {
      scope: scope,
      update_set_sys_id: "",
      update_set_name: null,
    });

    var scopeData = scopesData.find(function (s) {
      return s.scope === scope;
    });
    if (scopeData) scopeData.selected_update_set = null;

    toast("Closed: " + name);
    loadUpdateSets(scope, "");

    var card = document.getElementById("card-" + scope);
    if (card) {
      card.classList.remove("has-selection");
      var badge = card.querySelector(".selected-badge");
      if (badge) badge.remove();
    }
    var clearBtn = document.getElementById("clear-btn-" + scope);
    if (clearBtn) clearBtn.disabled = true;
    var closeBtn = document.getElementById("close-btn-" + scope);
    if (closeBtn) closeBtn.disabled = true;
  } catch (e) {
    toast("Failed to close: " + e.message, "error");
  }
}

// --- Modal ---

function openCreateModal(scope, scopeSysId) {
  modalScopeKey = scope;
  modalScopeSysId = scopeSysId;
  document.getElementById("modal-scope").value = scope;
  var modalScopeData = scopesData.find(function (s) {
    return s.scope === scope;
  });
  // Prefer the scope-qualified name (…| DEV-x | App | …) so sets created in
  // different scopes don't share an identical name; fall back to the scope-less
  // task name only when no per-scope suggestion is available.
  document.getElementById("modal-name").value =
    (modalScopeData && modalScopeData.suggested_update_set_name) ||
    (activeTask ? activeTask.updateSetName : "");
  document.getElementById("modal-description").value = activeTask
    ? activeTask.description
    : "";
  document.getElementById("create-modal").classList.add("active");
  document.getElementById("modal-name").focus();
}

function closeModal() {
  document.getElementById("create-modal").classList.remove("active");
  modalScopeKey = null;
  modalScopeSysId = null;
}

async function createUpdateSet() {
  var name = document.getElementById("modal-name").value.trim();
  if (!name) {
    toast("Name is required", "error");
    return;
  }

  var btn = document.getElementById("modal-create-btn");
  btn.disabled = true;
  btn.textContent = "Creating...";

  try {
    var data = await api("POST", "/api/update-set", {
      name: name,
      scope: modalScopeKey,
      scope_sys_id: modalScopeSysId,
      description: document.getElementById("modal-description").value.trim(),
    });

    var newSysId = data.update_set.sys_id;

    await api("POST", "/api/select-update-set", {
      scope: modalScopeKey,
      update_set_sys_id: newSysId,
      update_set_name: name,
    });

    var scopeData = scopesData.find(function (s) {
      return s.scope === modalScopeKey;
    });
    if (scopeData) {
      scopeData.selected_update_set = { sys_id: newSysId, name: name };
    }

    toast("Created: " + name);
    closeModal();

    loadUpdateSets(modalScopeKey, newSysId);

    var card = document.getElementById("card-" + modalScopeKey);
    if (card) {
      card.classList.add("has-selection");
      var badge = card.querySelector(".selected-badge");
      if (!badge) {
        var b = document.createElement("div");
        b.className = "selected-badge";
        b.textContent = "Active for push";
        card.appendChild(b);
      }
    }
    var closeBtn = document.getElementById("close-btn-" + modalScopeKey);
    if (closeBtn) closeBtn.disabled = false;
    var clearBtn = document.getElementById("clear-btn-" + modalScopeKey);
    if (clearBtn) clearBtn.disabled = false;
  } catch (e) {
    toast("Failed to create: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create";
  }
}

// --- Quick Create (inline per-scope) ---

async function quickCreateUpdateSet(scope, scopeSysId) {
  var input = document.getElementById("quick-name-" + scope);
  var name = input ? input.value.trim() : "";
  if (!name) {
    toast("Enter a name first", "error");
    if (input) input.focus();
    return;
  }

  // Find and disable the create button
  var card = document.getElementById("card-" + scope);
  var btn = card ? card.querySelector(".quick-create .btn") : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Creating...";
  }

  try {
    var data = await api("POST", "/api/update-set", {
      name: name,
      scope: scope,
      scope_sys_id: scopeSysId,
    });

    var newSysId = data.update_set.sys_id;

    await api("POST", "/api/select-update-set", {
      scope: scope,
      update_set_sys_id: newSysId,
      update_set_name: name,
    });

    var scopeData = scopesData.find(function (s) {
      return s.scope === scope;
    });
    if (scopeData) {
      scopeData.selected_update_set = { sys_id: newSysId, name: name };
    }

    toast("Created: " + name);
    if (input) input.value = "";

    loadUpdateSets(scope, newSysId);

    if (card) {
      card.classList.add("has-selection");
      var badge = card.querySelector(".selected-badge");
      if (!badge) {
        var b = document.createElement("div");
        b.className = "selected-badge";
        b.textContent = "Active for push";
        card.appendChild(b);
      }
    }
    var closeBtn = document.getElementById("close-btn-" + scope);
    if (closeBtn) closeBtn.disabled = false;
    var clearBtn = document.getElementById("clear-btn-" + scope);
    if (clearBtn) clearBtn.disabled = false;
  } catch (e) {
    toast("Failed to create: " + e.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Create";
    }
  }
}

// =============================================================================
// ClickUp Sidebar
// =============================================================================

// --- Sidebar toggle ---

function toggleSidebar() {
  var sidebar = document.getElementById("task-sidebar");
  var toggleBtn = document.getElementById("sidebar-toggle");

  sidebarOpen = !sidebarOpen;
  if (sidebarOpen) {
    sidebar.classList.remove("collapsed");
    toggleBtn.classList.add("active");
    if (Object.keys(clickupTasks).length === 0 && activeStatuses.length > 0) {
      loadClickUpTasks();
    }
  } else {
    sidebar.classList.add("collapsed");
    toggleBtn.classList.remove("active");
  }
}

// --- Load ClickUp status ---

async function loadClickUpStatus() {
  try {
    var data = await api("GET", "/api/clickup/status");
    clickupConfigured = data.configured;

    if (clickupConfigured) {
      document.getElementById("sidebar-toggle").style.display = "";
      renderTaskToggles();

      // Fetch current user for "My Tasks" filter
      if (!clickupUserId) {
        try {
          var me = await api("GET", "/api/clickup/me");
          clickupUserId = me.id;
        } catch (meErr) {
          // Non-critical — My Tasks filter just won't work
        }
      }
    }

    if (data.activeTask) {
      activeTask = data.activeTask;
      renderActiveTaskBanner();
      renderActiveTaskChip();
      renderScopes();
      fillQuickCreateDefaults();
    }
  } catch (e) {
    // ClickUp not available — just hide the button
  }
}

// --- Load ClickUp tasks ---

async function loadClickUpTasks() {
  if (tasksLoading) return;
  tasksLoading = true;

  var taskList = document.getElementById("task-list");
  taskList.innerHTML = '<div class="sidebar-loading">Loading tasks...</div>';

  try {
    var statusParam = activeStatuses.join(",");
    var data = await api(
      "GET",
      "/api/clickup/tasks?statuses=" + encodeURIComponent(statusParam)
    );
    clickupTasks = data.byStatus || {};

    // Merge discovered statuses with what we know
    var newStatuses = data.statuses || [];
    newStatuses.forEach(function (s) {
      if (availableStatuses.indexOf(s) === -1) {
        availableStatuses.push(s);
      }
    });

    renderStatusFilters();
    renderTaskList();
  } catch (e) {
    taskList.innerHTML =
      '<div class="sidebar-loading">Failed to load: ' + e.message + "</div>";
  } finally {
    tasksLoading = false;
  }
}

// --- Render status filters ---

function renderStatusFilters() {
  var container = document.getElementById("status-filters");

  // Ensure common statuses are always available
  var defaults = ["in progress", "open", "review", "to do"];
  defaults.forEach(function (s) {
    if (availableStatuses.indexOf(s) === -1) {
      availableStatuses.push(s);
    }
  });

  container.innerHTML = "";
  availableStatuses.forEach(function (status) {
    var chip = document.createElement("button");
    chip.className =
      "filter-chip" + (activeStatuses.indexOf(status) !== -1 ? " active" : "");
    chip.textContent = status;
    chip.onclick = function () {
      var idx = activeStatuses.indexOf(status);
      if (idx !== -1) {
        activeStatuses.splice(idx, 1);
      } else {
        activeStatuses.push(status);
      }
      chip.classList.toggle("active");
      loadClickUpTasks();
    };
    container.appendChild(chip);
  });
}

// --- Render task list ---

function filterTasks(tasks) {
  var filtered = tasks;
  var query = taskSearchQuery.toLowerCase();
  if (query) {
    filtered = filtered.filter(function (task) {
      var name = task.name.toLowerCase();
      var id = (task.customId || task.id || "").toLowerCase();
      return name.indexOf(query) !== -1 || id.indexOf(query) !== -1;
    });
  }
  if (myTasksOnly && clickupUserId) {
    filtered = filtered.filter(function (task) {
      return (
        task.assignees &&
        task.assignees.some(function (a) {
          return String(a.id) === String(clickupUserId);
        })
      );
    });
  }
  return filtered;
}

function renderTaskList() {
  var container = document.getElementById("task-list");
  container.innerHTML = "";

  var statusKeys = Object.keys(clickupTasks);
  if (statusKeys.length === 0) {
    container.innerHTML = '<div class="sidebar-loading">No tasks found</div>';
    return;
  }

  var totalVisible = 0;

  statusKeys.forEach(function (status) {
    var tasks = filterTasks(clickupTasks[status] || []);
    if (tasks.length === 0) return;

    totalVisible += tasks.length;

    var group = document.createElement("div");
    group.className = "task-status-group";

    var label = document.createElement("div");
    label.className = "task-status-label";
    label.textContent = status + " (" + tasks.length + ")";
    group.appendChild(label);

    tasks.forEach(function (task) {
      var card = document.createElement("div");
      card.className =
        "task-card" +
        (activeTask && activeTask.taskId === task.id ? " selected" : "");
      card.onclick = function () {
        selectTask(task);
      };

      var priorityHtml = "";
      if (task.priority) {
        // Tenon tertiary + status palette (see tokens.css)
        var colors = {
          urgent: "#d92b2b",
          high: "#f16b19",
          normal: "#f4dc00",
          low: "#76d6ff",
        };
        var color = colors[task.priority] || "#9caaa1";
        priorityHtml =
          '<span class="task-priority-dot" style="background:' +
          color +
          '"></span>';
      }

      var assigneeHtml = "";
      if (task.assignees && task.assignees.length > 0) {
        var initials = task.assignees
          .map(function (a) {
            return (
              a.initials || (a.username || "?").substring(0, 2).toUpperCase()
            );
          })
          .join(", ");
        assigneeHtml =
          '<span class="task-card-assignee">' +
          escapeHtml(initials) +
          "</span>";
      }

      card.innerHTML =
        '<div class="task-card-name">' +
        escapeHtml(task.name) +
        "</div>" +
        '<div class="task-card-meta">' +
        '<span class="task-card-id">' +
        (task.customId || task.id) +
        "</span>" +
        priorityHtml +
        assigneeHtml +
        "</div>";

      group.appendChild(card);
    });

    container.appendChild(group);
  });

  if (totalVisible === 0) {
    container.innerHTML =
      '<div class="sidebar-loading">No matching tasks</div>';
  }
}

// --- Select task ---

async function selectTask(task) {
  // If already selected, deselect
  if (activeTask && activeTask.taskId === task.id) {
    await deselectTask();
    return;
  }

  try {
    var data = await api("POST", "/api/clickup/select-task", {
      taskId: task.id,
      customId: task.customId || "",
      taskName: task.name,
      taskDescription: task.description || "",
      taskUrl: task.url || "",
    });

    activeTask = data.activeTask;
    toast("Task selected: " + task.name);

    renderActiveTaskBanner();
    renderActiveTaskChip();
    renderTaskList();
    renderScopes();

    // Fill quick-create inputs with the generated update set name
    fillQuickCreateDefaults();
  } catch (e) {
    toast("Failed to select task: " + e.message, "error");
  }
}

// --- Deselect task ---

async function deselectTask() {
  if (!confirm("Deselect active task? Update sets will remain.")) return;

  try {
    await api("POST", "/api/clickup/deselect-task");
    activeTask = null;
    toast("Task deselected");

    clearQuickCreateDefaults();
    renderActiveTaskBanner();
    renderActiveTaskChip();
    renderTaskList();
    renderScopes();
  } catch (e) {
    toast("Failed to deselect: " + e.message, "error");
  }
}

// --- Render active task banner (sidebar) ---

function renderActiveTaskBanner() {
  var banner = document.getElementById("active-task-banner");
  if (!activeTask) {
    banner.style.display = "none";
    banner.innerHTML = "";
    return;
  }

  banner.style.display = "";

  var scopeKeys = activeTask.scopes ? Object.keys(activeTask.scopes) : [];
  var scopeText =
    scopeKeys.length > 0
      ? "<span>" + scopeKeys.join(", ") + "</span>"
      : "None activated yet";

  banner.innerHTML =
    '<div class="active-task-name">' +
    escapeHtml(activeTask.taskName) +
    "</div>" +
    '<div class="active-task-us-name">' +
    escapeHtml(activeTask.updateSetName) +
    "</div>" +
    '<div class="active-task-scopes">Scopes: ' +
    scopeText +
    "</div>" +
    '<button class="btn-start-task" onclick="startTask()">Start Task</button>' +
    '<button class="btn-deselect" onclick="deselectTask()">Deselect</button>';
}

// --- Render active task chip (header) ---

function renderActiveTaskChip() {
  var chip = document.getElementById("active-task-chip");
  if (!activeTask) {
    chip.style.display = "none";
    chip.textContent = "";
    return;
  }

  chip.style.display = "";
  chip.textContent = activeTask.customId || activeTask.taskId;
  chip.title = activeTask.updateSetName;
  chip.onclick = function () {
    if (!sidebarOpen) toggleSidebar();
  };
}

// --- Activate scope for current task ---

async function activateScope(scope, scopeSysId) {
  if (!activeTask) {
    toast("No active task selected", "error");
    return;
  }

  // Find and disable the activate button
  var card = document.getElementById("card-" + scope);
  var activateBtn = card ? card.querySelector(".btn-activate") : null;
  if (activateBtn) {
    activateBtn.disabled = true;
    activateBtn.textContent = "Activating...";
  }

  try {
    var data = await api("POST", "/api/clickup/activate-scope", {
      scope: scope,
      scope_sys_id: scopeSysId,
    });

    var us = data.update_set;
    var verb = data.created ? "Created" : "Found";
    toast(verb + " update set for " + scope + ": " + us.name);

    // Update activeTask scopes
    if (!activeTask.scopes) activeTask.scopes = {};
    activeTask.scopes[scope] = { sys_id: us.sys_id, name: us.name };

    // Update scopesData so the dropdown reflects the new selection
    var scopeData = scopesData.find(function (s) {
      return s.scope === scope;
    });
    if (scopeData) {
      scopeData.selected_update_set = { sys_id: us.sys_id, name: us.name };
    }

    // Re-render to update all UI elements
    renderActiveTaskBanner();
    renderScopes();
  } catch (e) {
    toast("Failed to activate scope: " + e.message, "error");
    if (activateBtn) {
      activateBtn.disabled = false;
      activateBtn.textContent =
        "Activate " + (activeTask.customId || activeTask.taskId);
    }
  }
}

// --- Start task: ClickUp status -> in progress, prefill update-set names, branch ---

var START_TASK_FOLDER_KEY = "dt-start-task-folder";

async function startTask() {
  if (!activeTask) return;

  var remembered = "";
  try {
    remembered = localStorage.getItem(START_TASK_FOLDER_KEY) || "";
  } catch (e) {}
  var targetFolder = prompt(
    "Which folder should the branch be created in? (absolute path, or relative to where this dashboard was launched from, e.g. ../Mortise; leave blank to skip branch creation)",
    remembered
  );
  if (targetFolder === null) {
    // User cancelled the whole prompt dialog — abort Start Task entirely.
    return;
  }
  targetFolder = targetFolder.trim();
  if (targetFolder) {
    try {
      localStorage.setItem(START_TASK_FOLDER_KEY, targetFolder);
    } catch (e) {}
  }

  var btn = document.querySelector(".btn-start-task");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Starting...";
  }

  try {
    var data = await api("POST", "/api/clickup/start-task", {
      targetFolder: targetFolder,
    });

    if (data.activeTask) {
      activeTask = data.activeTask;
    }

    var parts = ["status: in progress"];

    if (data.branch && data.branch.branch) {
      parts.push(
        (data.branch.created ? "branch created: " : "switched to branch: ") +
          data.branch.branch
      );
    } else if (data.branch && data.branch.error) {
      parts.push("branch failed: " + data.branch.error);
    } else if (data.branch && data.branch.skipped) {
      parts.push("branch skipped");
    }

    toast(parts.join(" — "));

    renderActiveTaskBanner();
    renderScopes();

    // Fill each scope's quick-create input with its generated name — after
    // renderScopes() so the freshly-built inputs aren't overwritten. Nothing
    // is created; the dev reviews/edits and clicks Create per scope.
    (data.scopeNames || []).forEach(function (entry) {
      var input = document.getElementById("quick-name-" + entry.scope);
      if (input) input.value = entry.name;
    });
  } catch (e) {
    toast("Failed to start task: " + e.message, "error");
  } finally {
    var refreshedBtn = document.querySelector(".btn-start-task");
    if (refreshedBtn) {
      refreshedBtn.disabled = false;
      refreshedBtn.textContent = "Start Task";
    }
  }
}

// --- Auto-activate all scopes ---

async function autoActivateAllScopes() {
  if (!activeTask) return;

  // Disable all activate buttons and show progress
  scopesData.forEach(function (scope) {
    var card = document.getElementById("card-" + scope.scope);
    var btn = card ? card.querySelector(".btn-activate") : null;
    if (btn && !btn.classList.contains("activated")) {
      btn.disabled = true;
      btn.textContent = "Activating...";
    }
  });

  try {
    var data = await api("POST", "/api/clickup/activate-all-scopes");
    var results = data.results || [];

    // Update activeTask from server response
    if (data.activeTask) {
      activeTask = data.activeTask;
    }

    var created = 0;
    var found = 0;
    var errors = 0;

    results.forEach(function (r) {
      if (r.error) {
        errors++;
        return;
      }
      if (r.created) {
        created++;
      } else {
        found++;
      }

      // Update scopesData
      var scopeData = scopesData.find(function (s) {
        return s.scope === r.scope;
      });
      if (scopeData) {
        scopeData.selected_update_set = {
          sys_id: r.update_set.sys_id,
          name: r.update_set.name,
        };
      }
    });

    var parts = [];
    if (created > 0) parts.push(created + " created");
    if (found > 0) parts.push(found + " found");
    if (errors > 0) parts.push(errors + " failed");
    toast("Update sets: " + parts.join(", "));

    renderActiveTaskBanner();
    renderScopes();
  } catch (e) {
    toast("Failed to auto-activate scopes: " + e.message, "error");
    renderScopes();
  }
}

// --- Task toggles (My Tasks) ---

function renderTaskToggles() {
  var container = document.getElementById("task-toggles");
  container.innerHTML = "";

  if (!clickupConfigured) return;

  var btn = document.createElement("button");
  btn.className = "filter-chip" + (myTasksOnly ? " active" : "");
  btn.textContent = "my tasks";
  btn.onclick = function () {
    myTasksOnly = !myTasksOnly;
    btn.classList.toggle("active");
    renderTaskList();
  };
  container.appendChild(btn);
}

// --- Quick-create defaults from active task ---

function fillQuickCreateDefaults() {
  if (!activeTask) return;
  scopesData.forEach(function (scope) {
    var input = document.getElementById("quick-name-" + scope.scope);
    if (input && !input.value.trim()) {
      input.value = activeTask.updateSetName;
    }
  });
}

function clearQuickCreateDefaults() {
  scopesData.forEach(function (scope) {
    var input = document.getElementById("quick-name-" + scope.scope);
    if (input) {
      input.value = "";
    }
  });
}

// --- Recent Edits ---

var recentEdits = [];
var recentEditsInterval = null;

async function loadRecentEdits() {
  try {
    var data = await api("GET", "/api/recent-edits");
    var incoming = data.edits || [];

    // Warn if a newly-pushed file was already edited in the last 30 minutes
    var THIRTY_MIN = 30 * 60 * 1000;
    var now = Date.now();
    incoming.forEach(function (edit) {
      var alreadyPresent = recentEdits.some(function (prev) {
        return prev.sys_id === edit.sys_id && prev.tableName === edit.tableName;
      });
      if (!alreadyPresent) {
        var recentSave = recentEdits.some(function (prev) {
          return (
            prev.name === edit.name &&
            prev.tableName === edit.tableName &&
            now - new Date(prev.timestamp).getTime() < THIRTY_MIN
          );
        });
        if (recentSave) {
          toast(
            edit.name + " was already saved less than 30 minutes ago.",
            "warn"
          );
        }
      }
    });

    recentEdits = incoming;
    renderRecentEdits();
  } catch (e) {
    // Silently fail — panel just stays hidden or stale
  }
}

async function dismissRecentEdit(sys_id, tableName) {
  try {
    await api("POST", "/api/recent-edits/dismiss", {
      sys_id: sys_id,
      tableName: tableName,
    });
    recentEdits = recentEdits.filter(function (e) {
      return !(e.sys_id === sys_id && e.tableName === tableName);
    });
    renderRecentEdits();
  } catch (e) {
    toast("Failed to dismiss: " + e.message, "error");
  }
}

function timeAgo(timestamp) {
  var now = new Date();
  var then = new Date(timestamp);
  var seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return seconds + "s ago";
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

function renderRecentEdits() {
  var panel = document.getElementById("recent-edits-panel");
  var list = document.getElementById("recent-edits-list");

  if (recentEdits.length === 0) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "";
  list.innerHTML = "";

  // Build a lookup of expected update sets from scopesData
  var expectedUpdateSets = {};
  scopesData.forEach(function (scope) {
    if (scope.selected_update_set) {
      expectedUpdateSets[scope.scope] = scope.selected_update_set.name;
    }
  });

  recentEdits.forEach(function (edit) {
    var row = document.createElement("div");
    row.className = "recent-edit-row";

    var nameEl = document.createElement("span");
    nameEl.className = "recent-edit-name";
    nameEl.textContent = edit.name;
    nameEl.title = edit.tableName + "/" + edit.name;

    var scopeEl = document.createElement("span");
    scopeEl.className = "recent-edit-scope";
    scopeEl.textContent = edit.scope;

    var updateSetEl = document.createElement("span");
    var isDefault = edit.updateSet.toLowerCase().indexOf("default") !== -1;
    var expected = expectedUpdateSets[edit.scope];
    var isMismatch =
      expected && edit.updateSet !== expected && edit.updateSet !== "unknown";
    updateSetEl.className =
      "recent-edit-update-set" + (isDefault || isMismatch ? " warning" : "");
    updateSetEl.textContent = edit.updateSet;
    if (isMismatch && expected) {
      updateSetEl.title = "Expected: " + expected;
    }

    var timeEl = document.createElement("span");
    timeEl.className = "recent-edit-time";
    timeEl.textContent = timeAgo(edit.timestamp);

    var dismissBtn = document.createElement("button");
    dismissBtn.className = "recent-edit-dismiss";
    dismissBtn.title = "Dismiss";
    dismissBtn.textContent = "×";
    (function (id, table) {
      dismissBtn.addEventListener("click", function () {
        dismissRecentEdit(id, table);
      });
    })(edit.sys_id, edit.tableName);

    row.appendChild(nameEl);
    row.appendChild(scopeEl);
    row.appendChild(updateSetEl);
    row.appendChild(timeEl);
    row.appendChild(dismissBtn);
    list.appendChild(row);
  });
}

// --- Utility ---

function escapeHtml(str) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// --- Keyboard ---

document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    closeModal();
    if (sidebarOpen) toggleSidebar();
  }
});

// --- Refresh ---

async function refreshDashboard() {
  var btn = document.getElementById("refresh-btn");
  btn.disabled = true;
  btn.textContent = "Refreshing...";

  try {
    await loadScopes();
    await loadRecentEdits();
    if (clickupConfigured && activeTask) {
      await loadClickUpStatus();
    }
    toast("Dashboard refreshed");
  } catch (e) {
    toast("Refresh failed: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh";
  }
}

// --- Init ---

loadConfig();
loadScopes();
loadRecentEdits();
loadClickUpStatus();

// Poll recent edits every 10 seconds
recentEditsInterval = setInterval(loadRecentEdits, 60000);

// Wire up sidebar toggle and close buttons
document
  .getElementById("sidebar-toggle")
  .addEventListener("click", toggleSidebar);
document
  .getElementById("sidebar-close")
  .addEventListener("click", toggleSidebar);
document
  .getElementById("refresh-btn")
  .addEventListener("click", refreshDashboard);

// Render initial status filter chips
renderStatusFilters();

// Wire up task search input
document.getElementById("task-search").addEventListener("input", function (e) {
  taskSearchQuery = e.target.value;
  renderTaskList();
});

// Render task toggles (My Tasks)
renderTaskToggles();

// --- Theme toggle ---

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("cp-theme", theme);
  } catch (e) {}
  var btn = document.getElementById("cp-theme-toggle");
  if (btn) {
    btn.textContent = theme === "dark" ? "☀︎" : "☾";
    btn.title =
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }
}

(function setupTheme() {
  applyTheme(currentTheme());
  var btn = document.getElementById("cp-theme-toggle");
  if (btn) {
    btn.addEventListener("click", function () {
      applyTheme(currentTheme() === "dark" ? "light" : "dark");
    });
  }
})();
