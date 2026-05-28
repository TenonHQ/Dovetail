const express = require("express");
const path = require("path");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const fs = require("fs");
const RateLimit = require("express-rate-limit");

// Everything resolves from CWD — run this from your Dovetail project directory
const PROJECT_ROOT = process.cwd();
const envPath = path.resolve(PROJECT_ROOT, ".env");
require("dotenv").config({ path: envPath });

const app = express();
app.disable("x-powered-by");
const PORT = process.env.DASHBOARD_PORT || 3456;

const SN_INSTANCE = process.env.SN_INSTANCE || "";
const SN_USER = process.env.SN_USER || "";

// Rate limiter for recent-edits endpoint: max 100 requests per 15 minutes per IP
const recentEditsLimiter = RateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
// Rate limiter for claude-plans destructive operations
const claudePlansLimiter = RateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
});
const SN_PASSWORD = process.env.SN_PASSWORD || "";
const BASE_URL = `https://${SN_INSTANCE}`;

// Resolve an artifact path, preferring the dove.* name and falling back to the
// legacy sinc.* name when only the legacy file exists.
function resolveDovePath(doveName, sincName) {
  var dovePath = path.join(PROJECT_ROOT, doveName);
  var sincPath = path.join(PROJECT_ROOT, sincName);
  if (fs.existsSync(dovePath)) return dovePath;
  if (fs.existsSync(sincPath)) return sincPath;
  return dovePath;
}

const UPDATE_SET_CONFIG = resolveDovePath(".dove-update-sets.json", ".sinc-update-sets.json");
const DOVE_CONFIG_PATH = resolveDovePath("dove.config.js", "sinc.config.js");
const ACTIVE_TASK_FILE = resolveDovePath(".dove-active-task.json", ".sinc-active-task.json");

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || "";
const CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID || "";

// Rate limiting for ServiceNow API calls.
// Dashboard uses 10 RPS so that combined with core's 20 RPS the total stays
// under ServiceNow's per-user throttle when both are active simultaneously.
var snRequestTimestamps = [];
var MAX_SN_RPS = 10;
var SN_WINDOW_MS = 1000;

function waitForRateLimit() {
  var now = Date.now();
  // Purge timestamps older than the window
  snRequestTimestamps = snRequestTimestamps.filter(function (ts) {
    return now - ts < SN_WINDOW_MS;
  });

  if (snRequestTimestamps.length < MAX_SN_RPS) {
    snRequestTimestamps.push(now);
    return Promise.resolve();
  }

  // Calculate how long to wait until the oldest request falls out of the window
  var oldest = snRequestTimestamps[0];
  var delayMs = SN_WINDOW_MS - (now - oldest) + 10; // +10ms buffer
  return new Promise(function (resolve) {
    setTimeout(function () {
      snRequestTimestamps = snRequestTimestamps.filter(function (ts) {
        return Date.now() - ts < SN_WINDOW_MS;
      });
      snRequestTimestamps.push(Date.now());
      resolve();
    }, delayMs);
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Session-persistent ServiceNow client — cookie jar ensures scope changes
// (changeScope) persist across subsequent requests in the same session.
var snCookieJar = new CookieJar();
var snClient = wrapper(axios.create({
  baseURL: BASE_URL,
  auth: { username: SN_USER, password: SN_PASSWORD },
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
  },
  jar: snCookieJar,
  withCredentials: true,
}));

// Dovetail Scripted REST API rebrand: the API path moved from /api/cadso/claude/*
// to /api/cadso/dovetail/*. snApi rewrites legacy /api/cadso/claude/* URLs to the
// new path on first call; if that 404s (instance hasn't been re-imported yet) we
// latch back to the legacy path for the rest of the session and warn once.
var _dovetailApiUseLegacyClaudePath = false;

async function snApi(method, endpoint, data) {
  await waitForRateLimit();
  // Rewrite legacy /api/cadso/claude/* call sites to the new dovetail path,
  // unless we've already discovered this instance only speaks the legacy path.
  var rewritten = endpoint;
  var isDovetailScopedApi = endpoint.indexOf("api/cadso/claude/") === 0
    || endpoint.indexOf("/api/cadso/claude/") === 0
    || endpoint.indexOf("api/cadso/dovetail/") === 0
    || endpoint.indexOf("/api/cadso/dovetail/") === 0;
  if (isDovetailScopedApi) {
    rewritten = _dovetailApiUseLegacyClaudePath
      ? endpoint.replace("api/cadso/dovetail/", "api/cadso/claude/")
      : endpoint.replace("api/cadso/claude/", "api/cadso/dovetail/");
  }
  try {
    return await snClient({ method: method, url: rewritten, data: data });
  } catch (e) {
    var status = e && e.response && e.response.status;
    if (isDovetailScopedApi && !_dovetailApiUseLegacyClaudePath && status === 404) {
      // eslint-disable-next-line no-console
      console.warn(
        "[deprecation] " + rewritten +
          " returned 404. Falling back to legacy /api/cadso/claude/* path. Re-import the Dovetail Scripted REST API XML on your ServiceNow instance to silence this warning.",
      );
      _dovetailApiUseLegacyClaudePath = true;
      var legacyUrl = rewritten.replace("api/cadso/dovetail/", "api/cadso/claude/");
      return await snClient({ method: method, url: legacyUrl, data: data });
    }
    throw e;
  }
}

// ClickUp API helper
function clickupApi(method, endpoint, data) {
  return axios({
    method,
    url: "https://api.clickup.com/api/v2/" + endpoint,
    headers: {
      Authorization: CLICKUP_TOKEN,
      "Content-Type": "application/json",
    },
    data,
  });
}

// Generate update set name from ClickUp task
function generateUpdateSetName(taskId, taskName) {
  var sanitized = taskName.replace(/[^a-zA-Z0-9\s\-_]/g, "").trim();
  var base = "CU-" + taskId + " — " + sanitized;
  return base.substring(0, 80);
}

// Generate update set description from task
function generateUpdateSetDescription(taskName, taskDescription) {
  var desc = taskName;
  if (taskDescription) {
    var firstSentence = taskDescription.split(/[.!\n]/)[0].trim();
    if (firstSentence) {
      desc += " — " + firstSentence.substring(0, 150);
    }
  }
  return desc;
}

// Read active task from persistence file
function readActiveTask() {
  if (fs.existsSync(ACTIVE_TASK_FILE)) {
    return JSON.parse(fs.readFileSync(ACTIVE_TASK_FILE, "utf8"));
  }
  return null;
}

// Write active task to persistence file
function writeActiveTask(task) {
  fs.writeFileSync(ACTIVE_TASK_FILE, JSON.stringify(task, null, 2));
}

// Extract duplicate number from ServiceNow auto-numbered name
// "CU-abc — Name" => -1, "CU-abc — Name 1" => 1, "CU-abc — Name 2" => 2
function extractDuplicateNumber(name, baseName) {
  if (name === baseName) return -1;
  var suffix = name.substring(baseName.length).trim();
  var num = parseInt(suffix, 10);
  return isNaN(num) ? -1 : num;
}

// Find the best matching update set (highest duplicate number)
function findBestMatch(updateSets, baseName) {
  var matches = updateSets.filter(function (us) {
    return us.name === baseName || us.name.indexOf(baseName + " ") === 0;
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  var best = matches[0];
  var bestNum = extractDuplicateNumber(best.name, baseName);
  for (var i = 1; i < matches.length; i++) {
    var num = extractDuplicateNumber(matches[i].name, baseName);
    if (num > bestNum) {
      best = matches[i];
      bestNum = num;
    }
  }
  return best;
}

// GET /api/scopes — read from dove.config.js (or legacy sinc.config.js) + resolve display names
app.get("/api/scopes", async (req, res) => {
  try {
    delete require.cache[require.resolve(DOVE_CONFIG_PATH)];
    const config = require(DOVE_CONFIG_PATH);
    const scopeKeys = Object.keys(config.scopes || {});

    // Batch query for all scope records
    const scopeQuery = scopeKeys.map((s) => `scope=${s}`).join("^OR");
    const resp = await snApi(
      "get",
      `api/now/table/sys_scope?sysparm_query=${encodeURIComponent(scopeQuery)}&sysparm_fields=sys_id,scope,name&sysparm_limit=50`
    );

    const scopeRecords = resp.data.result || [];
    const scopeMap = {};
    scopeRecords.forEach((r) => {
      scopeMap[r.scope] = { sys_id: r.sys_id, name: r.name, scope: r.scope };
    });

    // Load saved selections
    let saved = {};
    if (fs.existsSync(UPDATE_SET_CONFIG)) {
      saved = JSON.parse(fs.readFileSync(UPDATE_SET_CONFIG, "utf8"));
    }

    const scopes = scopeKeys.map((key) => ({
      scope: key,
      sys_id: scopeMap[key] ? scopeMap[key].sys_id : null,
      display_name: scopeMap[key] ? scopeMap[key].name : key,
      selected_update_set: saved[key] || null,
    }));

    res.json({ scopes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/recent-edits — read local recent edits file, enrich with live SN data
var RECENT_EDITS_FILE = resolveDovePath(".dove-recent-edits.json", ".sinc-recent-edits.json");

app.get("/api/recent-edits", recentEditsLimiter, async function (req, res) {
  try {
    var edits = [];
    if (fs.existsSync(RECENT_EDITS_FILE)) {
      edits = JSON.parse(fs.readFileSync(RECENT_EDITS_FILE, "utf8"));
    }

    if (edits.length === 0) {
      return res.json({ edits: [] });
    }

    // For each edit, query sys_update_xml to get the live update set
    var enriched = [];
    for (var i = 0; i < edits.length; i++) {
      var edit = edits[i];
      var updateSetName = "unknown";
      try {
        var query = "name=" + edit.tableName + "_" + edit.sys_id + "^ORDERBYDESCsys_created_on";
        var snResp = await snApi(
          "get",
          "api/now/table/sys_update_xml?sysparm_query=" + encodeURIComponent(query) +
          "&sysparm_fields=update_set,update_set.name&sysparm_limit=1"
        );
        var results = snResp.data.result || [];
        if (results.length > 0) {
          updateSetName = results[0]["update_set.name"] || "unknown";
        }
      } catch (snErr) {
        // If SN query fails, still show the entry with "unknown" update set
      }

      enriched.push({
        sys_id: edit.sys_id,
        tableName: edit.tableName,
        name: edit.name,
        scope: edit.scope,
        updateSet: updateSetName,
        timestamp: edit.timestamp,
      });
    }

    res.json({ edits: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/recent-edits/dismiss — remove one entry from the local recent edits file
app.post("/api/recent-edits/dismiss", function (req, res) {
  try {
    var sys_id = req.body.sys_id;
    var tableName = req.body.tableName;
    if (!sys_id || !tableName) {
      return res.status(400).json({ error: "sys_id and tableName required" });
    }
    var edits = [];
    if (fs.existsSync(RECENT_EDITS_FILE)) {
      edits = JSON.parse(fs.readFileSync(RECENT_EDITS_FILE, "utf8"));
    }
    var filtered = edits.filter(function (e) {
      return !(e.sys_id === sys_id && e.tableName === tableName);
    });
    fs.writeFileSync(RECENT_EDITS_FILE, JSON.stringify(filtered, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/update-sets/:scope — list in-progress update sets for a scope
app.get("/api/update-sets/:scope", async (req, res) => {
  try {
    const { scope } = req.params;
    const query = `application.scope=${scope}^state=in progress^ORDERBYDESCsys_created_on`;
    const resp = await snApi(
      "get",
      `api/now/table/sys_update_set?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=sys_id,name,state,application,sys_created_on,description&sysparm_limit=50`
    );
    res.json({ update_sets: resp.data.result || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/update-set — create a new update set
app.post("/api/update-set", async (req, res) => {
  try {
    const { name, scope, scope_sys_id, description } = req.body;
    if (!name || typeof name !== "string" || name.trim() === "") {
      return res.status(400).json({ error: "name is required" });
    }
    if (!scope_sys_id || typeof scope_sys_id !== "string") {
      return res.status(400).json({ error: "scope_sys_id is required" });
    }

    // Switch to the target scope before creating — ServiceNow uses session scope
    if (scope) {
      await snApi("get", "api/cadso/claude/changeScope?scope=" + encodeURIComponent(scope));
    }

    const data = {
      name,
      state: "in progress",
      application: scope_sys_id,
    };
    if (description) data.description = description;

    const resp = await snApi("post", "api/now/table/sys_update_set", data);
    res.json({ update_set: resp.data.result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/update-set/:sysId/close — close an update set
app.patch("/api/update-set/:sysId/close", async (req, res) => {
  try {
    const { sysId } = req.params;
    const resp = await snApi(
      "patch",
      `api/now/table/sys_update_set/${sysId}`,
      { state: "complete" }
    );
    res.json({ update_set: resp.data.result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/select-update-set — save scope->updateSet mapping
app.post("/api/select-update-set", async (req, res) => {
  try {
    const { scope, update_set_sys_id, update_set_name } = req.body;
    if (!scope || typeof scope !== "string") {
      return res.status(400).json({ error: "scope is required" });
    }

    let config = {};
    if (fs.existsSync(UPDATE_SET_CONFIG)) {
      config = JSON.parse(fs.readFileSync(UPDATE_SET_CONFIG, "utf8"));
    }

    if (update_set_sys_id) {
      config[scope] = { sys_id: update_set_sys_id, name: update_set_name };
    } else {
      delete config[scope];
    }

    fs.writeFileSync(UPDATE_SET_CONFIG, JSON.stringify(config, null, 2));
    res.json({ saved: true, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/config — return current saved config
app.get("/api/config", (req, res) => {
  try {
    let config = {};
    if (fs.existsSync(UPDATE_SET_CONFIG)) {
      config = JSON.parse(fs.readFileSync(UPDATE_SET_CONFIG, "utf8"));
    }
    res.json({ config, instance: SN_INSTANCE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ClickUp Endpoints ---

// GET /api/clickup/status — check if ClickUp is configured + active task
app.get("/api/clickup/status", function (req, res) {
  try {
    var activeTask = readActiveTask();
    res.json({
      configured: !!(CLICKUP_TOKEN && CLICKUP_TOKEN.length > 0),
      hasTeamId: !!(CLICKUP_TEAM_ID && CLICKUP_TEAM_ID.length > 0),
      activeTask: activeTask,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clickup/me — fetch current ClickUp user
app.get("/api/clickup/me", async function (req, res) {
  try {
    if (!CLICKUP_TOKEN) {
      return res.status(400).json({ error: "CLICKUP_API_TOKEN not configured" });
    }
    var resp = await clickupApi("get", "user");
    var user = resp.data.user || {};
    res.json({
      id: user.id,
      username: user.username || "",
      email: user.email || "",
      initials: user.initials || "",
    });
  } catch (e) {
    var msg = e.message;
    if (e.response && e.response.data) {
      msg = e.response.data.err || e.response.data.error || msg;
    }
    res.status(500).json({ error: msg });
  }
});

// GET /api/clickup/tasks — fetch user's tasks with optional status filter
app.get("/api/clickup/tasks", async function (req, res) {
  try {
    if (!CLICKUP_TOKEN) {
      return res.status(400).json({ error: "CLICKUP_API_TOKEN not configured" });
    }

    var teamId = CLICKUP_TEAM_ID;
    if (!teamId) {
      var teamsResp = await clickupApi("get", "team");
      var teams = teamsResp.data.teams || [];
      if (teams.length === 0) {
        return res.status(400).json({ error: "No ClickUp teams found" });
      }
      teamId = teams[0].id;
    }

    var statuses = req.query.statuses;
    var statusList = statuses ? statuses.split(",") : [];

    var url = "team/" + teamId + "/task?subtasks=true&include_closed=false";
    statusList.forEach(function (s) {
      url += "&statuses[]=" + encodeURIComponent(s.trim());
    });

    var resp = await clickupApi("get", url);
    var tasks = resp.data.tasks || [];

    // Group by status
    var byStatus = {};
    var allStatuses = [];
    tasks.forEach(function (t) {
      var statusName = t.status && t.status.status ? t.status.status : "unknown";
      if (!byStatus[statusName]) {
        byStatus[statusName] = [];
        allStatuses.push(statusName);
      }
      var assignees = (t.assignees || []).map(function (a) {
        return {
          id: a.id,
          username: a.username || "",
          initials: a.initials || "",
        };
      });
      byStatus[statusName].push({
        id: t.id,
        name: t.name,
        description: t.description || "",
        status: statusName,
        statusColor: t.status && t.status.color ? t.status.color : null,
        priority: t.priority ? t.priority.priority : null,
        url: t.url || "",
        customId: t.custom_id || null,
        assignees: assignees,
      });
    });

    res.json({ tasks: tasks.length, byStatus: byStatus, statuses: allStatuses });
  } catch (e) {
    var msg = e.message;
    if (e.response && e.response.data) {
      msg = e.response.data.err || e.response.data.error || msg;
    }
    res.status(500).json({ error: msg });
  }
});

// GET /api/clickup/task/:taskId — fetch single task detail
app.get("/api/clickup/task/:taskId", async function (req, res) {
  try {
    if (!CLICKUP_TOKEN) {
      return res.status(400).json({ error: "CLICKUP_API_TOKEN not configured" });
    }
    var resp = await clickupApi("get", "task/" + req.params.taskId);
    var t = resp.data;
    res.json({
      task: {
        id: t.id,
        name: t.name,
        description: t.description || "",
        status: t.status && t.status.status ? t.status.status : "unknown",
        statusColor: t.status && t.status.color ? t.status.color : null,
        priority: t.priority ? t.priority.priority : null,
        url: t.url || "",
        customId: t.custom_id || null,
      },
    });
  } catch (e) {
    var msg = e.message;
    if (e.response && e.response.data) {
      msg = e.response.data.err || e.response.data.error || msg;
    }
    res.status(500).json({ error: msg });
  }
});

// POST /api/clickup/select-task — select a task as active
app.post("/api/clickup/select-task", function (req, res) {
  try {
    var body = req.body;
    if (!body.taskId || !body.taskName) {
      return res.status(400).json({ error: "taskId and taskName are required" });
    }

    var updateSetName = generateUpdateSetName(body.taskId, body.taskName);
    var description = generateUpdateSetDescription(
      body.taskName,
      body.taskDescription || ""
    );

    var activeTask = {
      taskId: body.taskId,
      taskName: body.taskName,
      taskDescription: body.taskDescription || "",
      updateSetName: updateSetName,
      description: description,
      taskUrl: body.taskUrl || "",
      scopes: {},
    };

    writeActiveTask(activeTask);
    res.json({ activeTask: activeTask });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Core logic: find or create update set for a scope given an active task
// Returns { update_set, created }
async function findOrCreateUpdateSet(scope, scopeSysId, activeTask) {
  var baseName = activeTask.updateSetName;
  var taskId = activeTask.taskId;

  if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
    throw new Error("Cannot search for update sets: activeTask has an empty or missing taskId");
  }

  // Query ServiceNow for existing update sets matching this task in this scope
  var query =
    "application.scope=" + scope +
    "^nameLIKECU-" + taskId +
    "^state=in progress" +
    "^ORDERBYDESCsys_created_on";
  var searchResp = await snApi(
    "get",
    "api/now/table/sys_update_set?sysparm_query=" +
      encodeURIComponent(query) +
      "&sysparm_fields=sys_id,name,state,application,sys_created_on,description&sysparm_limit=50"
  );
  var existing = searchResp.data.result || [];

  var updateSet = null;

  if (existing.length > 0) {
    updateSet = findBestMatch(existing, baseName);
    if (!updateSet) {
      updateSet = existing[0];
    }
  }

  var created = false;
  if (!updateSet) {
    // Switch to the target scope before creating — ServiceNow uses session scope,
    // not the application field, when creating update sets via Table API
    await snApi("get", "api/cadso/claude/changeScope?scope=" + encodeURIComponent(scope));

    var createData = {
      name: baseName,
      state: "in progress",
      application: scopeSysId,
    };
    if (activeTask.description) {
      createData.description = activeTask.description;
    }
    var createResp = await snApi("post", "api/now/table/sys_update_set", createData);
    updateSet = createResp.data.result;
    created = true;
  }

  // Change the current update set on the ServiceNow instance and verify
  try {
    await snApi(
      "get",
      "api/cadso/claude/changeUpdateSet?sysId=" + encodeURIComponent(updateSet.sys_id)
    );

    // Verify the switch was successful
    var verifyResp = await snApi(
      "get",
      "api/cadso/claude/currentUpdateSet" + (scope ? "?scope=" + encodeURIComponent(scope) : "")
    );
    var verifyData = verifyResp.data;
    if (verifyData && verifyData.result) {
      verifyData = verifyData.result;
    }
    var currentSysId = verifyData && verifyData.sysId ? verifyData.sysId : null;
    if (currentSysId !== updateSet.sys_id) {
      // Retry once
      console.warn("Update set verification failed, retrying switch...");
      await snApi(
        "get",
        "api/cadso/claude/changeUpdateSet?sysId=" + encodeURIComponent(updateSet.sys_id)
      );
      var retryResp = await snApi(
        "get",
        "api/cadso/claude/currentUpdateSet" + (scope ? "?scope=" + encodeURIComponent(scope) : "")
      );
      var retryData = retryResp.data;
      if (retryData && retryData.result) {
        retryData = retryData.result;
      }
      var retrySysId = retryData && retryData.sysId ? retryData.sysId : null;
      if (retrySysId !== updateSet.sys_id) {
        var actualName = retryData && retryData.name ? retryData.name : "unknown";
        console.error(
          "Update set " + updateSet.name + " was created but could not be activated. Current update set is " + actualName + "."
        );
      }
    }
  } catch (changeErr) {
    console.error("Warning: Could not auto-switch update set on instance:", changeErr.message);
  }

  return { update_set: updateSet, created: created };
}

// Persist scope activation into both active task file and update set config
function persistScopeActivation(scope, updateSet, activeTask) {
  activeTask.scopes[scope] = {
    sys_id: updateSet.sys_id,
    name: updateSet.name,
  };
  writeActiveTask(activeTask);

  var config = {};
  if (fs.existsSync(UPDATE_SET_CONFIG)) {
    config = JSON.parse(fs.readFileSync(UPDATE_SET_CONFIG, "utf8"));
  }
  config[scope] = {
    sys_id: updateSet.sys_id,
    name: updateSet.name,
  };
  fs.writeFileSync(UPDATE_SET_CONFIG, JSON.stringify(config, null, 2));
}

// POST /api/clickup/activate-scope — find or create update set for a scope
app.post("/api/clickup/activate-scope", async function (req, res) {
  try {
    var body = req.body;
    if (!body.scope || !body.scope_sys_id) {
      return res.status(400).json({ error: "scope and scope_sys_id are required" });
    }

    var activeTask = readActiveTask();
    if (!activeTask) {
      return res.status(400).json({ error: "No active task selected" });
    }

    var result = await findOrCreateUpdateSet(body.scope, body.scope_sys_id, activeTask);
    persistScopeActivation(body.scope, result.update_set, activeTask);

    res.json({
      update_set: result.update_set,
      created: result.created,
      scope: body.scope,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clickup/activate-all-scopes — find or create update sets for all configured scopes
app.post("/api/clickup/activate-all-scopes", async function (req, res) {
  try {
    var activeTask = readActiveTask();
    if (!activeTask) {
      return res.status(400).json({ error: "No active task selected" });
    }

    // Read scopes from dove.config.js
    delete require.cache[require.resolve(DOVE_CONFIG_PATH)];
    var config = require(DOVE_CONFIG_PATH);
    var scopeKeys = Object.keys(config.scopes || {});

    // Resolve scope sys_ids
    var scopeQuery = scopeKeys.map(function (s) { return "scope=" + s; }).join("^OR");
    var scopeResp = await snApi(
      "get",
      "api/now/table/sys_scope?sysparm_query=" +
        encodeURIComponent(scopeQuery) +
        "&sysparm_fields=sys_id,scope,name&sysparm_limit=50"
    );
    var scopeRecords = scopeResp.data.result || [];
    var scopeMap = {};
    scopeRecords.forEach(function (r) {
      scopeMap[r.scope] = r.sys_id;
    });

    // Activate each scope sequentially (respects rate limits)
    var results = [];
    for (var i = 0; i < scopeKeys.length; i++) {
      var scope = scopeKeys[i];
      var scopeSysId = scopeMap[scope];
      if (!scopeSysId) {
        results.push({ scope: scope, error: "scope not found on instance" });
        continue;
      }

      try {
        var result = await findOrCreateUpdateSet(scope, scopeSysId, activeTask);
        persistScopeActivation(scope, result.update_set, activeTask);
        // Re-read active task so subsequent iterations see updated scopes
        activeTask = readActiveTask();
        results.push({
          scope: scope,
          update_set: result.update_set,
          created: result.created,
        });
      } catch (scopeErr) {
        results.push({ scope: scope, error: scopeErr.message });
      }
    }

    res.json({ results: results, activeTask: readActiveTask() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clickup/deselect-task — clear the active task
app.post("/api/clickup/deselect-task", function (req, res) {
  try {
    if (fs.existsSync(ACTIVE_TASK_FILE)) {
      fs.unlinkSync(ACTIVE_TASK_FILE);
    }
    res.json({ cleared: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Claude Plans Panel ---
// Reads JSON records written by @tenonhq/dovetail-claude-plans into
// ~/.dovetail/claude-plans/ and streams updates to the /claude-plans page.
// Storage layout:
//   <root>/<plan-slug>.json
//   <root>/<plan-slug>/artifacts/<artifact-slug>.json
const os = require("os");
const chokidar = require("chokidar");

const CLAUDE_PLANS_DIR =
  process.env.DOVE_CLAUDE_PLANS_DIR ||
  path.join(os.homedir(), ".dovetail", "claude-plans");

// Slugs are written by @tenonhq/dovetail-claude-plans' slugify() — kebab-case,
// max 64 chars. We re-validate on the read side so a request like `..%2Ffoo`
// cannot escape CLAUDE_PLANS_DIR via path.join.
const CLAUDE_PLAN_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isValidSlug(slug) {
  return typeof slug === "string" && CLAUDE_PLAN_SLUG.test(slug);
}

function planFilePath(slug) {
  return path.join(CLAUDE_PLANS_DIR, slug + ".json");
}

function artifactsDirFor(slug) {
  return path.join(CLAUDE_PLANS_DIR, slug, "artifacts");
}

function promptsDirFor(slug) {
  return path.join(CLAUDE_PLANS_DIR, slug, "prompts");
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

function listClaudePlans() {
  if (!fs.existsSync(CLAUDE_PLANS_DIR)) return [];
  const entries = fs.readdirSync(CLAUDE_PLANS_DIR);
  const plans = [];
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i];
    if (!name.endsWith(".json")) continue;
    const plan = safeReadJson(path.join(CLAUDE_PLANS_DIR, name));
    if (plan) plans.push(plan);
  }
  plans.sort(function (a, b) {
    return (b.updated_at || "").localeCompare(a.updated_at || "");
  });
  return plans;
}

function listClaudeArtifacts(slug) {
  if (!isValidSlug(slug)) return [];
  const dir = artifactsDirFor(slug);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir);
  const artifacts = [];
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].endsWith(".json")) continue;
    const a = safeReadJson(path.join(dir, entries[i]));
    if (a) artifacts.push(a);
  }
  artifacts.sort(function (a, b) {
    return (a.created_at || "").localeCompare(b.created_at || "");
  });
  return artifacts;
}

function listClaudePrompts(slug) {
  if (!isValidSlug(slug)) return [];
  const baseDir = path.resolve(CLAUDE_PLANS_DIR);
  const dir = path.resolve(promptsDirFor(slug));
  if (!dir.startsWith(baseDir + path.sep)) return [];
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir);
  const prompts = [];
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].endsWith(".json")) continue;
    const p = safeReadJson(path.join(dir, entries[i]));
    if (p) prompts.push(p);
  }
  prompts.sort(function (a, b) {
    return (a.created_at || "").localeCompare(b.created_at || "");
  });
  return prompts;
}

// Parse a watcher path like "<root>/<slug>.json" or
// "<root>/<slug>/artifacts/<artifact-slug>.json" into { kind, slug, artifactSlug }.
function classifyPath(filePath) {
  const rel = path.relative(CLAUDE_PLANS_DIR, filePath);
  if (!rel || rel.startsWith("..")) return null;
  const parts = rel.split(path.sep);
  if (parts.length === 1 && parts[0] === ".focus") {
    return { kind: "focus" };
  }
  if (parts.length === 1 && parts[0].endsWith(".json")) {
    return { kind: "plan", slug: parts[0].slice(0, -5) };
  }
  if (parts.length === 3 && parts[1] === "artifacts" && parts[2].endsWith(".json")) {
    return { kind: "artifact", slug: parts[0], artifactSlug: parts[2].slice(0, -5) };
  }
  if (parts.length === 3 && parts[1] === "prompts" && parts[2].endsWith(".json")) {
    return { kind: "prompt", slug: parts[0], promptSlug: parts[2].slice(0, -5) };
  }
  return null;
}

// SSE fan-out. Each connected client is a response object held open until the
// client disconnects; broadcastClaudePlanEvent writes a single SSE frame to all.
const claudePlanSseClients = new Set();

function broadcastClaudePlanEvent(event, data) {
  const frame = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const res of claudePlanSseClients) {
    try {
      res.write(frame);
    } catch (err) {
      claudePlanSseClients.delete(res);
    }
  }
}

function handleWatcherChange(event, filePath) {
  const info = classifyPath(filePath);
  if (!info) return;
  if (info.kind === "focus") {
    const focus = safeReadJson(filePath);
    if (focus && isValidSlug(focus.slug)) {
      broadcastClaudePlanEvent("plan:focus", { slug: focus.slug });
    }
    return;
  }
  if (info.kind === "plan") {
    if (event === "unlink") {
      broadcastClaudePlanEvent("plan:delete", { slug: info.slug });
      return;
    }
    const plan = safeReadJson(filePath);
    if (plan) broadcastClaudePlanEvent("plan:upsert", { plan: plan });
    return;
  }
  if (info.kind === "artifact") {
    if (event === "unlink") {
      broadcastClaudePlanEvent("artifact:delete", {
        plan_slug: info.slug,
        slug: info.artifactSlug
      });
      return;
    }
    const artifact = safeReadJson(filePath);
    if (artifact) broadcastClaudePlanEvent("artifact:upsert", { artifact: artifact });
    return;
  }
  if (info.kind === "prompt") {
    if (event === "unlink") {
      broadcastClaudePlanEvent("prompt:delete", {
        plan_slug: info.slug,
        slug: info.promptSlug
      });
      return;
    }
    const prompt = safeReadJson(filePath);
    if (prompt) broadcastClaudePlanEvent("prompt:upsert", { prompt: prompt });
  }
}

// Start the watcher lazily — create the storage dir if missing so chokidar has
// something to watch. ignoreInitial avoids replaying every file on boot
// (clients fetch initial state via GET /api/claude-plans).
let claudePlanWatcher = null;
function startClaudePlanWatcher() {
  if (claudePlanWatcher) return;
  try {
    fs.mkdirSync(CLAUDE_PLANS_DIR, { recursive: true });
  } catch (err) {
    console.warn("[claude-plans] could not create storage dir:", err.message);
  }
  claudePlanWatcher = chokidar.watch(CLAUDE_PLANS_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    depth: 3
  });
  claudePlanWatcher.on("add", function (p) { handleWatcherChange("add", p); });
  claudePlanWatcher.on("change", function (p) { handleWatcherChange("change", p); });
  claudePlanWatcher.on("unlink", function (p) { handleWatcherChange("unlink", p); });
}

app.get(["/claude-plans", "/claude-plans/:slug"], function (req, res) {
  res.sendFile(path.join(__dirname, "public", "claude-plans.html"));
});

app.get("/api/claude-plans", function (req, res) {
  try {
    res.json({ plans: listClaudePlans(), storage: CLAUDE_PLANS_DIR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/claude-plans/stream", function (req, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();
  res.write("event: hello\ndata: {}\n\n");
  claudePlanSseClients.add(res);

  const heartbeat = setInterval(function () {
    try {
      res.write(": heartbeat\n\n");
    } catch (err) {
      clearInterval(heartbeat);
      claudePlanSseClients.delete(res);
    }
  }, 25000);

  req.on("close", function () {
    clearInterval(heartbeat);
    claudePlanSseClients.delete(res);
  });
});

// :slug must avoid the static "stream" route above; Express matches in order.
app.get("/api/claude-plans/:slug", function (req, res) {
  try {
    const slug = req.params.slug;
    if (!isValidSlug(slug)) return res.status(400).json({ error: "invalid slug" });
    const plan = safeReadJson(planFilePath(slug));
    if (!plan) return res.status(404).json({ error: "plan not found" });
    res.json({
      plan: plan,
      artifacts: listClaudeArtifacts(slug),
      prompts: listClaudePrompts(slug)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/claude-plans/:slug", claudePlansLimiter, function (req, res) {
  try {
    var slug = req.params.slug;
    if (!isValidSlug(slug)) return res.status(400).json({ error: "invalid slug" });
    var baseDir = path.resolve(CLAUDE_PLANS_DIR);
    var planFile = path.resolve(baseDir, slug + ".json");
    if (!planFile.startsWith(baseDir + path.sep)) return res.status(400).json({ error: "invalid slug" });
    if (!fs.existsSync(planFile)) return res.status(404).json({ error: "plan not found" });
    fs.unlinkSync(planFile);
    var artifactsDir = path.resolve(baseDir, slug);
    if (artifactsDir.startsWith(baseDir + path.sep) && fs.existsSync(artifactsDir)) {
      fs.rmSync(artifactsDir, { recursive: true, force: true });
    }
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Only start the server when run directly (not when require()-d).
// Callers like dashboardCommand.ts and allScopesCommands.ts use
// spawn("node", [serverPath]) which sets require.main === module.
if (require.main === module) {
  startClaudePlanWatcher();
  app.listen(PORT, "127.0.0.1", function () {
    console.log("\n  Dovetail Update Set Dashboard");
    console.log("  Instance:  " + SN_INSTANCE);
    console.log("  Project:   " + PROJECT_ROOT);
    console.log("  Dashboard: http://localhost:" + PORT);
    console.log("  Claude:    http://localhost:" + PORT + "/claude-plans\n");
  });
}
