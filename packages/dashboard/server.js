const express = require("express");
const path = require("path");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const fs = require("fs");
const { execFile } = require("child_process");
const RateLimit = require("express-rate-limit");
const {
  buildScopedUpdateSetName,
  extractDuplicateNumber,
  generateUpdateSetDescription,
  generateUpdateSetName,
  readActiveTask: readActiveTaskFile,
  sanitizeTaskName,
  scopeLabel,
} = require("./lib/helpers");

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

const UPDATE_SET_CONFIG = resolveDovePath(
  ".dove-update-sets.json",
  ".sinc-update-sets.json"
);
const DOVE_CONFIG_PATH = resolveDovePath("dove.config.js", "sinc.config.js");
const ACTIVE_TASK_FILE = resolveDovePath(
  ".dove-active-task.json",
  ".sinc-active-task.json"
);

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
var snClient = wrapper(
  axios.create({
    baseURL: BASE_URL,
    auth: { username: SN_USER, password: SN_PASSWORD },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    jar: snCookieJar,
    withCredentials: true,
  })
);

// Dovetail's core Scripted REST API now lives in the Dovetail scoped application
// at /api/cadso/dovetail_core/*. Older instances still expose the previous
// global-scope path /api/cadso/dovetail/*. Dashboard call sites still pass the
// original /api/cadso/claude/* paths; snApi maps them to dovetail_core first and,
// on a missing-endpoint error (404, or the 400 "Requested URI does not represent
// any resource" SN returns for an absent Scripted REST resource), latches to the
// legacy /api/cadso/dovetail/* path for the rest of the session and warns once.
// Mirrors packages/core/src/snClient.ts so the dashboard and the dove CLI agree.
var _dovetailApiUseLegacyPath = false;
var _SN_MISSING_ENDPOINT_BODY = "Requested URI does not represent any resource";

// True when an error means the Dovetail Scripted REST endpoint is absent on this
// instance: a 404, or the 400 body SN returns for an unknown scripted-REST URI.
function isMissingDovetailEndpoint(e) {
  var status = e && e.response && e.response.status;
  if (status === 404) return true;
  if (status === 400) {
    var data = e && e.response && e.response.data;
    var body = "";
    try {
      body = typeof data === "string" ? data : JSON.stringify(data || "");
    } catch (_e) {
      body = "";
    }
    return body.indexOf(_SN_MISSING_ENDPOINT_BODY) !== -1;
  }
  return false;
}

// Map a dashboard call-site path (api/cadso/{claude,dovetail,dovetail_core}/<op>)
// to the active Dovetail scoped-API path. Returns null for non-scoped endpoints
// (e.g. api/now/table/*), which pass through unchanged.
function dovetailScopedPath(endpoint) {
  var match = endpoint.match(
    /^\/?api\/cadso\/(?:dovetail_core|dovetail|claude)\/(.*)$/
  );
  if (!match) return null;
  var service = _dovetailApiUseLegacyPath ? "dovetail" : "dovetail_core";
  return "api/cadso/" + service + "/" + match[1];
}

async function snApi(method, endpoint, data) {
  await waitForRateLimit();
  var scopedPath = dovetailScopedPath(endpoint);
  var url = scopedPath || endpoint;
  try {
    return await snClient({ method: method, url: url, data: data });
  } catch (e) {
    if (
      scopedPath &&
      !_dovetailApiUseLegacyPath &&
      isMissingDovetailEndpoint(e)
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        "[deprecation] " +
          url +
          " not found. Falling back to legacy /api/cadso/dovetail/* path. Install the Dovetail application's Scripted REST APIs to silence this warning."
      );
      _dovetailApiUseLegacyPath = true;
      var legacyUrl = dovetailScopedPath(endpoint);
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

// Keep persistence paths in the server while the parsing logic remains a pure,
// importable helper for package-local tests.
function readActiveTask() {
  return readActiveTaskFile(ACTIVE_TASK_FILE);
}

// Write active task to persistence file
function writeActiveTask(task) {
  fs.writeFileSync(ACTIVE_TASK_FILE, JSON.stringify(task, null, 2));
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
      `api/now/table/sys_scope?sysparm_query=${encodeURIComponent(
        scopeQuery
      )}&sysparm_fields=sys_id,scope,name&sysparm_limit=50`
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

    // When a task is active, precompute the scope-qualified update-set name for
    // each scope (same generator the Start Task / quick-create path uses) so the
    // create UI never prefills a scope-less name that would collide across scopes.
    // readActiveTask() is non-throwing and returns null for a malformed file, so
    // a bad active task degrades to "no suggestion" rather than a 500 here.
    const activeTaskForNames = readActiveTask();
    const scopes = scopeKeys.map((key) => ({
      scope: key,
      sys_id: scopeMap[key] ? scopeMap[key].sys_id : null,
      display_name: scopeMap[key] ? scopeMap[key].name : key,
      selected_update_set: saved[key] || null,
      suggested_update_set_name: activeTaskForNames
        ? buildScopedUpdateSetName(activeTaskForNames, scopeLabel(key))
        : "",
    }));

    res.json({ scopes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/recent-edits — read local recent edits file, enrich with live SN data
var RECENT_EDITS_FILE = resolveDovePath(
  ".dove-recent-edits.json",
  ".sinc-recent-edits.json"
);

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
        var query =
          "name=" +
          edit.tableName +
          "_" +
          edit.sys_id +
          "^ORDERBYDESCsys_created_on";
        var snResp = await snApi(
          "get",
          "api/now/table/sys_update_xml?sysparm_query=" +
            encodeURIComponent(query) +
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
      `api/now/table/sys_update_set?sysparm_query=${encodeURIComponent(
        query
      )}&sysparm_fields=sys_id,name,state,application,sys_created_on,description&sysparm_limit=50`
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
      await snApi(
        "get",
        "api/cadso/claude/changeScope?scope=" + encodeURIComponent(scope)
      );
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
    const resp = await snApi("patch", `api/now/table/sys_update_set/${sysId}`, {
      state: "complete",
    });
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
      return res
        .status(400)
        .json({ error: "CLICKUP_API_TOKEN not configured" });
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
      return res
        .status(400)
        .json({ error: "CLICKUP_API_TOKEN not configured" });
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
      var statusName =
        t.status && t.status.status ? t.status.status : "unknown";
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

    res.json({
      tasks: tasks.length,
      byStatus: byStatus,
      statuses: allStatuses,
    });
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
      return res
        .status(400)
        .json({ error: "CLICKUP_API_TOKEN not configured" });
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
app.post("/api/clickup/select-task", async function (req, res) {
  try {
    var body = req.body;
    if (!body.taskId || !body.taskName) {
      return res
        .status(400)
        .json({ error: "taskId and taskName are required" });
    }

    var devInitials = "";
    try {
      var meResp = await clickupApi("get", "user");
      devInitials = (meResp.data.user && meResp.data.user.initials) || "";
    } catch (meErr) {
      // Non-fatal — naming falls back to no-initials prefix
    }

    var customId = body.customId || body.taskId;
    var shortDesc = sanitizeTaskName(body.taskName);
    var updateSetName = generateUpdateSetName(devInitials, customId, shortDesc);
    var description = generateUpdateSetDescription(
      body.taskName,
      body.taskDescription || ""
    );

    var activeTask = {
      taskId: body.taskId,
      customId: customId,
      devInitials: devInitials,
      shortDesc: shortDesc,
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
  var appLabel = scopeLabel(scope);
  var baseName = buildScopedUpdateSetName(activeTask, appLabel);
  var lookupId = activeTask.customId || activeTask.taskId;

  if (!lookupId || typeof lookupId !== "string" || lookupId.trim() === "") {
    throw new Error(
      "Cannot search for update sets: activeTask has an empty or missing task id"
    );
  }

  // Query ServiceNow for existing update sets matching this task in this scope.
  // Lookup is on the task id substring only (not the full name) so a re-run
  // still finds a set created before a naming-format change.
  var query =
    "application.scope=" +
    scope +
    "^nameLIKE" +
    lookupId +
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
    await snApi(
      "get",
      "api/cadso/claude/changeScope?scope=" + encodeURIComponent(scope)
    );

    var createData = {
      name: baseName,
      state: "in progress",
      application: scopeSysId,
    };
    if (activeTask.description) {
      createData.description = activeTask.description;
    }
    var createResp = await snApi(
      "post",
      "api/now/table/sys_update_set",
      createData
    );
    updateSet = createResp.data.result;
    created = true;
  }

  // Change the current update set on the ServiceNow instance and verify
  try {
    await snApi(
      "get",
      "api/cadso/claude/changeUpdateSet?sysId=" +
        encodeURIComponent(updateSet.sys_id)
    );

    // Verify the switch was successful
    var verifyResp = await snApi(
      "get",
      "api/cadso/claude/currentUpdateSet" +
        (scope ? "?scope=" + encodeURIComponent(scope) : "")
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
        "api/cadso/claude/changeUpdateSet?sysId=" +
          encodeURIComponent(updateSet.sys_id)
      );
      var retryResp = await snApi(
        "get",
        "api/cadso/claude/currentUpdateSet" +
          (scope ? "?scope=" + encodeURIComponent(scope) : "")
      );
      var retryData = retryResp.data;
      if (retryData && retryData.result) {
        retryData = retryData.result;
      }
      var retrySysId = retryData && retryData.sysId ? retryData.sysId : null;
      if (retrySysId !== updateSet.sys_id) {
        var actualName =
          retryData && retryData.name ? retryData.name : "unknown";
        console.error(
          "Update set " +
            updateSet.name +
            " was created but could not be activated. Current update set is " +
            actualName +
            "."
        );
      }
    }
  } catch (changeErr) {
    console.error(
      "Warning: Could not auto-switch update set on instance:",
      changeErr.message
    );
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
      return res
        .status(400)
        .json({ error: "scope and scope_sys_id are required" });
    }

    var activeTask = readActiveTask();
    if (!activeTask) {
      return res.status(400).json({ error: "No active task selected" });
    }

    var result = await findOrCreateUpdateSet(
      body.scope,
      body.scope_sys_id,
      activeTask
    );
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

// Shared core: find-or-create an update set in every scope from dove.config.js
// for the given active task. Used by both /activate-all-scopes and /start-task.
// Returns { results, activeTask }.
async function activateAllConfiguredScopes(activeTask) {
  // Read scopes from dove.config.js
  delete require.cache[require.resolve(DOVE_CONFIG_PATH)];
  var config = require(DOVE_CONFIG_PATH);
  var scopeKeys = Object.keys(config.scopes || {});

  // Resolve scope sys_ids
  var scopeQuery = scopeKeys
    .map(function (s) {
      return "scope=" + s;
    })
    .join("^OR");
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

  return { results: results, activeTask: readActiveTask() };
}

// POST /api/clickup/activate-all-scopes — find or create update sets for all configured scopes
app.post("/api/clickup/activate-all-scopes", async function (req, res) {
  try {
    var activeTask = readActiveTask();
    if (!activeTask) {
      return res.status(400).json({ error: "No active task selected" });
    }

    var outcome = await activateAllConfiguredScopes(activeTask);
    res.json({ results: outcome.results, activeTask: outcome.activeTask });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Slugify text for use in a branch name segment: lowercase, non-alphanumerics
// collapsed to single hyphens, trimmed, capped so the full branch name stays
// reasonable.
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);
}

function execFilePromise(cmd, args, opts) {
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, opts || {}, function (err, stdout, stderr) {
      if (err) {
        var detail = (stderr || err.message || "").toString().trim();
        return reject(new Error(detail || err.message));
      }
      resolve(stdout.toString().trim());
    });
  });
}

// True when a local branch with this name exists in cwd — checked explicitly
// (rather than inferred from a failed `checkout -b`) so a real checkout
// failure (e.g. uncommitted changes blocking the switch) surfaces its own
// git error instead of being masked as "branch doesn't exist".
function localBranchExists(branchName, cwd) {
  return new Promise(function (resolve) {
    execFile(
      "git",
      ["show-ref", "--verify", "--quiet", "refs/heads/" + branchName],
      { cwd: cwd },
      function (err) {
        resolve(!err);
      }
    );
  });
}

// Cut (or switch to, if it already exists) the working branch for a task in
// the given target folder: dev/{git-username}/{DEV-ID}/{short-desc}
async function createTaskBranch(activeTask, targetFolder) {
  var username = "";
  try {
    username = await execFilePromise("git", ["config", "user.name"], {
      cwd: targetFolder,
    });
  } catch (userErr) {
    // Fall through to the "dev" fallback below
  }
  var usernameSlug = slugify(username) || "dev";
  var taskIdSlug = slugify(activeTask.customId || activeTask.taskId);
  var descSlug = slugify(activeTask.shortDesc || activeTask.taskName);
  var branchName = "dev/" + usernameSlug + "/" + taskIdSlug + "/" + descSlug;

  var exists = await localBranchExists(branchName, targetFolder);
  if (exists) {
    await execFilePromise("git", ["checkout", branchName], {
      cwd: targetFolder,
    });
    return { branch: branchName, cwd: targetFolder, created: false };
  }

  await execFilePromise("git", ["checkout", "-b", branchName], {
    cwd: targetFolder,
  });
  return { branch: branchName, cwd: targetFolder, created: true };
}

// Compute (without creating anything) the scope-aware update-set name for
// every scope in dove.config.js. No ServiceNow API calls — used by Start Task
// to prefill the quick-create inputs rather than creating update sets outright.
function computeScopeNames(activeTask) {
  delete require.cache[require.resolve(DOVE_CONFIG_PATH)];
  var config = require(DOVE_CONFIG_PATH);
  var scopeKeys = Object.keys(config.scopes || {});
  return scopeKeys.map(function (scope) {
    return {
      scope: scope,
      name: buildScopedUpdateSetName(activeTask, scopeLabel(scope)),
    };
  });
}

// POST /api/clickup/start-task — mark the active task in-progress in ClickUp,
// compute (but do not create) the per-scope update-set names, and cut the
// working branch in an explicitly-chosen target folder. One deliberate
// action, not tied to mere task selection. Body: { targetFolder? } — an
// absolute path, or a path relative to PROJECT_ROOT (wherever this dashboard
// process was launched from) to a git checkout; branch creation is skipped
// if omitted.
app.post("/api/clickup/start-task", async function (req, res) {
  try {
    var activeTask = readActiveTask();
    if (!activeTask) {
      return res.status(400).json({ error: "No active task selected" });
    }

    try {
      await clickupApi("put", "task/" + activeTask.taskId, {
        status: "in progress",
      });
    } catch (statusErr) {
      var msg = statusErr.message;
      if (statusErr.response && statusErr.response.data) {
        msg =
          statusErr.response.data.err || statusErr.response.data.error || msg;
      }
      return res
        .status(502)
        .json({ error: "Failed to set ClickUp status: " + msg });
    }

    var scopeNames = computeScopeNames(activeTask);

    var branchResult = { skipped: true };
    var rawTargetFolder = req.body && req.body.targetFolder;
    if (rawTargetFolder) {
      // path.resolve leaves an already-absolute path untouched and resolves
      // a relative one (e.g. "../Mortise") against PROJECT_ROOT.
      var targetFolder = path.resolve(PROJECT_ROOT, rawTargetFolder);
      var invalid =
        !fs.existsSync(targetFolder) ||
        !fs.statSync(targetFolder).isDirectory();
      if (invalid) {
        branchResult = {
          error:
            "Target folder does not exist: " +
            targetFolder +
            " (from input: " +
            rawTargetFolder +
            ")",
        };
      } else {
        try {
          branchResult = await createTaskBranch(activeTask, targetFolder);
        } catch (branchErr) {
          branchResult = { error: branchErr.message };
        }
      }
    }

    res.json({
      status: "in progress",
      scopeNames: scopeNames,
      branch: branchResult,
      activeTask: activeTask,
    });
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

// Prompt-draft ids are pd_<8-hex>, written by @tenonhq/dovetail-claude-plans.
// Re-validated on the read side so a crafted id can't escape the store dir.
const PROMPT_DRAFT_ID = /^pd_[0-9a-f]{8}$/;

function isValidDraftId(id) {
  return typeof id === "string" && PROMPT_DRAFT_ID.test(id);
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

// Prompt lint events are global (not nested under a plan). Stored by
// @tenonhq/dovetail-claude-plans at <root>/_lint-events/<id>.json.
function lintEventsDir() {
  return path.join(CLAUDE_PLANS_DIR, "_lint-events");
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

function listClaudeLintEvents(filters) {
  const dir = lintEventsDir();
  if (!fs.existsSync(dir)) return [];
  const f = filters || {};
  const entries = fs.readdirSync(dir);
  const events = [];
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].endsWith(".json")) continue;
    const e = safeReadJson(path.join(dir, entries[i]));
    if (!e) continue;
    if (f.session_id !== undefined && e.session_id !== f.session_id) continue;
    if (f.plan_slug !== undefined && e.plan_slug !== f.plan_slug) continue;
    events.push(e);
  }
  events.sort(function (a, b) {
    const c = (b.timestamp || "").localeCompare(a.timestamp || "");
    if (c !== 0) return c;
    return (b.id || "").localeCompare(a.id || "");
  });
  if (typeof f.limit === "number") return events.slice(0, f.limit);
  return events;
}

// Parse a watcher path like "<root>/<slug>.json",
// "<root>/<slug>/artifacts/<artifact-slug>.json", or
// "<root>/_lint-events/<id>.json" into { kind, ... }.
function classifyPath(filePath) {
  const rel = path.relative(CLAUDE_PLANS_DIR, filePath);
  if (!rel || rel.startsWith("..")) return null;
  const parts = rel.split(path.sep);
  if (parts.length === 1 && parts[0] === ".focus") {
    return { kind: "focus" };
  }
  if (
    parts.length === 2 &&
    parts[0] === "_lint-events" &&
    parts[1].endsWith(".json")
  ) {
    return { kind: "lint", id: parts[1].slice(0, -5) };
  }
  if (
    parts.length === 2 &&
    parts[0] === "_prompt-drafts" &&
    parts[1].endsWith(".json")
  ) {
    if (parts[1] === "_active.json") return { kind: "draft-active" };
    return { kind: "draft", id: parts[1].slice(0, -5) };
  }
  if (parts.length === 1 && parts[0].endsWith(".json")) {
    return { kind: "plan", slug: parts[0].slice(0, -5) };
  }
  if (
    parts.length === 3 &&
    parts[1] === "artifacts" &&
    parts[2].endsWith(".json")
  ) {
    return {
      kind: "artifact",
      slug: parts[0],
      artifactSlug: parts[2].slice(0, -5),
    };
  }
  if (
    parts.length === 3 &&
    parts[1] === "prompts" &&
    parts[2].endsWith(".json")
  ) {
    return {
      kind: "prompt",
      slug: parts[0],
      promptSlug: parts[2].slice(0, -5),
    };
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
        slug: info.artifactSlug,
      });
      return;
    }
    const artifact = safeReadJson(filePath);
    if (artifact)
      broadcastClaudePlanEvent("artifact:upsert", { artifact: artifact });
    return;
  }
  if (info.kind === "prompt") {
    if (event === "unlink") {
      broadcastClaudePlanEvent("prompt:delete", {
        plan_slug: info.slug,
        slug: info.promptSlug,
      });
      return;
    }
    const prompt = safeReadJson(filePath);
    if (prompt) broadcastClaudePlanEvent("prompt:upsert", { prompt: prompt });
    return;
  }
  if (info.kind === "lint") {
    if (event === "unlink") {
      broadcastClaudePlanEvent("lint:delete", { id: info.id });
      return;
    }
    const lint = safeReadJson(filePath);
    if (lint) broadcastClaudePlanEvent("lint:upsert", { lint: lint });
    return;
  }
  if (info.kind === "draft-active") {
    // The active-tab pointer changed (a draft was made active, or the active
    // one was deleted and focus advanced). Tell editors which tab is active.
    const ptr = safeReadJson(filePath);
    broadcastClaudePlanEvent("draft:active", {
      active_id: ptr ? ptr.active_id : null,
    });
    return;
  }
  if (info.kind === "draft") {
    if (event === "unlink") {
      broadcastClaudePlanEvent("draft:delete", { id: info.id });
      return;
    }
    // Fires when a Claude session writes an enhanced prompt back, or another
    // editor instance autosaves — the editor merges it into the matching tab.
    const draft = safeReadJson(filePath);
    if (draft) broadcastClaudePlanEvent("draft:upsert", { draft: draft });
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
    depth: 3,
  });
  claudePlanWatcher.on("add", function (p) {
    handleWatcherChange("add", p);
  });
  claudePlanWatcher.on("change", function (p) {
    handleWatcherChange("change", p);
  });
  claudePlanWatcher.on("unlink", function (p) {
    handleWatcherChange("unlink", p);
  });
}

app.get("/claude-plans", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "claude-plans.html"));
});

// Multi-tab HTML prompt editor. Drafts persist to the claude-plans store so a
// Claude Code session can read the active tab and write an enhanced prompt back.
app.get("/prompt-editor", claudePlansLimiter, function (req, res) {
  res.sendFile(path.join(__dirname, "public", "prompt-editor.html"));
});

// Legacy path-segment deep links (/claude-plans/:slug) redirect to the
// query-param form so relative assets resolve against /claude-plans.
app.get("/claude-plans/:slug", function (req, res) {
  res.redirect(
    301,
    "/claude-plans?plan=" + encodeURIComponent(req.params.slug)
  );
});

app.get("/prompt-lints", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "prompt-lints.html"));
});

app.get("/api/prompt-lints", function (req, res) {
  try {
    const filters = {};
    if (typeof req.query.session_id === "string")
      filters.session_id = req.query.session_id;
    if (typeof req.query.plan_slug === "string")
      filters.plan_slug = req.query.plan_slug;
    if (typeof req.query.limit === "string") {
      const n = parseInt(req.query.limit, 10);
      if (!isNaN(n) && n > 0) filters.limit = Math.min(n, 1000); // mirror getLintEventsSchema cap
    }
    res.json({
      events: listClaudeLintEvents(filters),
      storage: CLAUDE_PLANS_DIR,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/claude-plans", function (req, res) {
  try {
    res.json({ plans: listClaudePlans(), storage: CLAUDE_PLANS_DIR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live GitHub merge state for plan-linked PRs. Plans store pr_url but no merge
// status, so we resolve it on demand via the `gh` CLI (authenticated locally).
// Results are cached: a MERGED state is terminal and cached forever; anything
// else is cached briefly so an open PR that later merges is picked up.
const PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const PR_STATUS_TTL_MS = 60 * 1000;
const prStatusCache = new Map(); // pr_url -> { state, merged, fetchedAt }

function ghPrState(prUrl) {
  return new Promise(function (resolve) {
    execFile(
      "gh",
      ["pr", "view", prUrl, "--json", "state,mergedAt"],
      { timeout: 5000 },
      function (err, stdout) {
        if (err) return resolve({ state: "unknown", merged: false });
        try {
          const data = JSON.parse(stdout);
          const state = data.state || "unknown";
          resolve({ state: state, merged: state === "MERGED" });
        } catch (e) {
          resolve({ state: "unknown", merged: false });
        }
      }
    );
  });
}

function resolvePrStatus(prUrl) {
  const cached = prStatusCache.get(prUrl);
  const now = Date.now();
  if (cached && (cached.merged || now - cached.fetchedAt < PR_STATUS_TTL_MS)) {
    return Promise.resolve({ state: cached.state, merged: cached.merged });
  }
  return ghPrState(prUrl).then(function (result) {
    prStatusCache.set(prUrl, {
      state: result.state,
      merged: result.merged,
      fetchedAt: Date.now(),
    });
    return result;
  });
}

// Run promise-returning tasks with bounded concurrency so a large plan set
// doesn't spawn dozens of `gh` processes at once.
function mapWithConcurrency(items, limit, worker) {
  return new Promise(function (resolve) {
    const results = new Array(items.length);
    let index = 0;
    let completed = 0;
    if (!items.length) return resolve(results);
    function runNext() {
      if (index >= items.length) return;
      const i = index++;
      Promise.resolve(worker(items[i]))
        .then(function (r) {
          results[i] = r;
        })
        .catch(function () {
          results[i] = null;
        })
        .then(function () {
          completed++;
          if (completed === items.length) resolve(results);
          else runNext();
        });
    }
    for (let k = 0; k < Math.min(limit, items.length); k++) runNext();
  });
}

// Place before "/api/claude-plans/:slug" so Express doesn't treat "pr-status"
// as a slug. Always resolves to a 200 with whatever statuses we could gather —
// a missing/unauthenticated `gh` degrades to {} rather than failing the page.
app.get("/api/claude-plans/pr-status", function (req, res) {
  try {
    const urls = [];
    const seen = {};
    listClaudePlans().forEach(function (plan) {
      const url = plan && plan.pr_url;
      if (typeof url === "string" && PR_URL_RE.test(url) && !seen[url]) {
        seen[url] = true;
        urls.push(url);
      }
    });
    mapWithConcurrency(urls, 5, resolvePrStatus).then(function (resolved) {
      const statuses = {};
      for (let i = 0; i < urls.length; i++) {
        if (resolved[i]) statuses[urls[i]] = resolved[i];
      }
      res.json({ statuses: statuses });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/claude-plans/stream", function (req, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
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
    if (!isValidSlug(slug))
      return res.status(400).json({ error: "invalid slug" });
    const plan = safeReadJson(planFilePath(slug));
    if (!plan) return res.status(404).json({ error: "plan not found" });
    res.json({
      plan: plan,
      artifacts: listClaudeArtifacts(slug),
      prompts: listClaudePrompts(slug),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- v2 bidirectional pipeline write routes (Phase E) ---
// All three call into @tenonhq/dovetail-claude-plans' storage layer so
// the state machine, conflict rule, and token lifecycle are enforced in
// exactly one place. Errors surface their typed `code` and `name` to the
// client so the dashboard can branch on them.
const claudePlansLib = require("@tenonhq/dovetail-claude-plans/dist/storage");

function sendTypedError(res, err) {
  // ZodError (input validation) is a 400. Storage's typed errors expose
  // a `code` (e.g. ILLEGAL_TRANSITION, MISSING_AGENT). Anything else is
  // a 500 with the message.
  if (err && err.name === "ZodError") {
    return res
      .status(400)
      .json({ error: "validation_failed", details: err.issues });
  }
  if (err && typeof err.code === "string") {
    var status = 409;
    if (err.code === "MISSING_AGENT") status = 424;
    if (err.code === "NO_TOKEN") status = 400;
    if (err.code === "STALE_TOKEN") status = 410;
    if (err.code === "SPAWN_ERROR") status = 500;
    return res.status(status).json({
      error: err.code,
      name: err.name,
      message: err.message,
    });
  }
  if (err && /not found/i.test(err.message || "")) {
    return res.status(404).json({ error: "not_found", message: err.message });
  }
  return res
    .status(500)
    .json({ error: "internal", message: (err && err.message) || String(err) });
}

// POST /api/claude-plans/:slug/answers — record an answer to a question.
// Body: { question_id, answer, answered_by? }
app.post(
  "/api/claude-plans/:slug/answers",
  claudePlansLimiter,
  express.json(),
  function (req, res) {
    try {
      var slug = req.params.slug;
      if (!isValidSlug(slug))
        return res.status(400).json({ error: "invalid slug" });
      var body = req.body || {};
      var result = claudePlansLib.recordAnswer({
        plan_slug: slug,
        question_id: body.question_id,
        answer: body.answer,
        answered_by: body.answered_by || "dashboard",
      });
      res.json(result);
    } catch (e) {
      sendTypedError(res, e);
    }
  }
);

// POST /api/claude-plans/:slug/stage — move the plan to a new stage.
// Body: { to: PipelineStage, by? }
// Source is forced to 'dashboard' so the conflict-resolution rule
// (docs/v2-design.md §4) treats dashboard moves as authoritative.
app.post(
  "/api/claude-plans/:slug/stage",
  claudePlansLimiter,
  express.json(),
  function (req, res) {
    try {
      var slug = req.params.slug;
      if (!isValidSlug(slug))
        return res.status(400).json({ error: "invalid slug" });
      var body = req.body || {};
      var result = claudePlansLib.setStage({
        plan_slug: slug,
        to: body.to,
        by: body.by || "dashboard",
        source: "dashboard",
      });
      res.json(result);
    } catch (e) {
      sendTypedError(res, e);
    }
  }
);

// POST /api/claude-plans/:slug/dispatch — dry-run or live dispatch.
// Body: { target_stage, confirm?, token?, by? }
// The dashboard's flow is: POST without confirm (dry-run) → show
// resolved command in the UI → POST with confirm:true + token from
// set_stage response → live spawn.
app.post(
  "/api/claude-plans/:slug/dispatch",
  claudePlansLimiter,
  express.json(),
  function (req, res) {
    try {
      var slug = req.params.slug;
      if (!isValidSlug(slug))
        return res.status(400).json({ error: "invalid slug" });
      var body = req.body || {};
      var result = claudePlansLib.dispatchStage({
        plan_slug: slug,
        target_stage: body.target_stage,
        confirm: body.confirm === true,
        token: body.token,
        by: body.by || "dashboard",
      });
      res.json(result);
    } catch (e) {
      sendTypedError(res, e);
    }
  }
);

// GET /api/claude-plans/:slug/versions — list saved version snapshots (newest-first).
app.get("/api/claude-plans/:slug/versions", function (req, res) {
  try {
    var slug = req.params.slug;
    if (!isValidSlug(slug))
      return res.status(400).json({ error: "invalid slug" });
    res.json({ slug: slug, versions: claudePlansLib.listVersions(slug) });
  } catch (e) {
    sendTypedError(res, e);
  }
});

// GET /api/claude-plans/:slug/versions/:n — read one full version snapshot.
app.get("/api/claude-plans/:slug/versions/:n", function (req, res) {
  try {
    var slug = req.params.slug;
    if (!isValidSlug(slug))
      return res.status(400).json({ error: "invalid slug" });
    var n = parseInt(req.params.n, 10);
    if (!(n > 0)) return res.status(400).json({ error: "invalid version" });
    var version = claudePlansLib.getVersion(slug, n);
    if (!version) return res.status(404).json({ error: "version not found" });
    res.json(version);
  } catch (e) {
    sendTypedError(res, e);
  }
});

// POST /api/claude-plans/:slug/versions/:n/restore — re-push a prior version as
// the new current record. Non-destructive (pre-restore current is snapshotted).
// The plan-file write triggers the chokidar watcher → plan:upsert SSE, so
// connected dashboards refresh without a manual broadcast.
app.post(
  "/api/claude-plans/:slug/versions/:n/restore",
  claudePlansLimiter,
  function (req, res) {
    try {
      var slug = req.params.slug;
      if (!isValidSlug(slug))
        return res.status(400).json({ error: "invalid slug" });
      var n = parseInt(req.params.n, 10);
      if (!(n > 0)) return res.status(400).json({ error: "invalid version" });
      var plan = claudePlansLib.restoreVersion(slug, n);
      res.json({ plan: plan });
    } catch (e) {
      sendTypedError(res, e);
    }
  }
);

app.delete("/api/claude-plans/:slug", claudePlansLimiter, function (req, res) {
  try {
    var slug = req.params.slug;
    if (!isValidSlug(slug))
      return res.status(400).json({ error: "invalid slug" });
    var baseDir = path.resolve(CLAUDE_PLANS_DIR);
    var planFile = path.resolve(baseDir, slug + ".json");
    if (!planFile.startsWith(baseDir + path.sep))
      return res.status(400).json({ error: "invalid slug" });
    if (!fs.existsSync(planFile))
      return res.status(404).json({ error: "plan not found" });
    fs.unlinkSync(planFile);
    var artifactsDir = path.resolve(baseDir, slug);
    if (
      artifactsDir.startsWith(baseDir + path.sep) &&
      fs.existsSync(artifactsDir)
    ) {
      fs.rmSync(artifactsDir, { recursive: true, force: true });
    }
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Prompt Editor (multi-tab HTML prompt drafts) ---
// All writes go through @tenonhq/dovetail-claude-plans' storage layer so the
// draft/active-pointer rules live in exactly one place. Each write lands a file
// under <root>/_prompt-drafts/, which the chokidar watcher turns into a
// draft:upsert / draft:delete / draft:active SSE frame — so the editor (and a
// Claude session's enhance write) refresh every connected tab automatically.

// GET /api/prompt-drafts — list all drafts (oldest-first) + the active id.
app.get("/api/prompt-drafts", claudePlansLimiter, function (req, res) {
  try {
    res.json(claudePlansLib.listPromptDraftsWithActive());
  } catch (e) {
    sendTypedError(res, e);
  }
});

// POST /api/prompt-drafts — create a new draft (tab). Body: { title?, content? }
app.post(
  "/api/prompt-drafts",
  claudePlansLimiter,
  express.json(),
  function (req, res) {
    try {
      var body = req.body || {};
      var draft = claudePlansLib.createPromptDraft({
        title: body.title,
        content: body.content,
        session_id: body.session_id,
      });
      res.json(draft);
    } catch (e) {
      sendTypedError(res, e);
    }
  }
);

// POST /api/prompt-drafts/active — set the active tab. Body: { id }
// Declared before "/:id" so Express doesn't treat "active" as an id.
app.post(
  "/api/prompt-drafts/active",
  claudePlansLimiter,
  express.json(),
  function (req, res) {
    try {
      var body = req.body || {};
      if (!isValidDraftId(body.id))
        return res.status(400).json({ error: "invalid draft id" });
      res.json(claudePlansLib.setActivePromptDraft(body.id));
    } catch (e) {
      sendTypedError(res, e);
    }
  }
);

// GET /api/prompt-drafts/:id — read one draft.
app.get("/api/prompt-drafts/:id", claudePlansLimiter, function (req, res) {
  try {
    var id = req.params.id;
    if (!isValidDraftId(id))
      return res.status(400).json({ error: "invalid draft id" });
    var draft = claudePlansLib.getPromptDraft(id);
    if (!draft) return res.status(404).json({ error: "draft not found" });
    res.json(draft);
  } catch (e) {
    sendTypedError(res, e);
  }
});

// PUT /api/prompt-drafts/:id — autosave title/content. Body: { title?, content? }
app.put(
  "/api/prompt-drafts/:id",
  claudePlansLimiter,
  express.json(),
  function (req, res) {
    try {
      var id = req.params.id;
      if (!isValidDraftId(id))
        return res.status(400).json({ error: "invalid draft id" });
      var body = req.body || {};
      if (body.title === undefined && body.content === undefined) {
        return res.status(400).json({ error: "nothing to update" });
      }
      res.json(
        claudePlansLib.updatePromptDraft({
          id: id,
          title: body.title,
          content: body.content,
        })
      );
    } catch (e) {
      sendTypedError(res, e);
    }
  }
);

// DELETE /api/prompt-drafts/:id — close a tab. Returns the new active id.
app.delete("/api/prompt-drafts/:id", claudePlansLimiter, function (req, res) {
  try {
    var id = req.params.id;
    if (!isValidDraftId(id))
      return res.status(400).json({ error: "invalid draft id" });
    res.json(claudePlansLib.deletePromptDraft(id));
  } catch (e) {
    sendTypedError(res, e);
  }
});

// --- TODO Panel ---
// A drag-to-reorder priority checklist. All writes go through
// @tenonhq/dovetail-todo's storage layer so the ordering/validation rules
// live in exactly one place (same pattern as the claude-plans routes above).
// The single store file is watched so MCP-driven and dashboard-driven changes
// both stream to the /todos page.
const todoLib = require("@tenonhq/dovetail-todo/dist/storage");

const TODO_DIR =
  process.env.DOVE_TODO_DIR || path.join(os.homedir(), ".dovetail", "todos");
const TODO_FILE = path.join(TODO_DIR, "todos.json");

const todoLimiter = RateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
});
// Read limiter for the page + list endpoints, which touch the filesystem.
const todoReadLimiter = RateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
});

// SSE fan-out for the TODO panel — one frame per connected client.
const todoSseClients = new Set();

function broadcastTodos(list) {
  const frame =
    "event: todos:update\ndata: " + JSON.stringify({ list: list }) + "\n\n";
  for (const res of todoSseClients) {
    try {
      res.write(frame);
    } catch (err) {
      todoSseClients.delete(res);
    }
  }
}

function emitTodoState() {
  try {
    broadcastTodos(todoLib.loadList({ rootDir: TODO_DIR }));
  } catch (e) {
    // A torn/partial read between rename events is transient; ignore.
  }
}

let todoWatcher = null;
function startTodoWatcher() {
  if (todoWatcher) return;
  try {
    fs.mkdirSync(TODO_DIR, { recursive: true });
  } catch (err) {
    console.warn("[todos] could not create storage dir:", err.message);
  }
  todoWatcher = chokidar.watch(TODO_FILE, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  });
  todoWatcher.on("add", emitTodoState);
  todoWatcher.on("change", emitTodoState);
  todoWatcher.on("unlink", function () {
    broadcastTodos({ schema_version: 1, items: [] });
  });
}

app.get("/todos", todoReadLimiter, function (req, res) {
  res.sendFile(path.join(__dirname, "public", "todos.html"));
});

app.get("/api/todos", todoReadLimiter, function (req, res) {
  try {
    res.json({
      list: todoLib.loadList({ rootDir: TODO_DIR }),
      storage: TODO_DIR,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/todos/stream", function (req, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("event: hello\ndata: {}\n\n");
  todoSseClients.add(res);

  const heartbeat = setInterval(function () {
    try {
      res.write(": heartbeat\n\n");
    } catch (err) {
      clearInterval(heartbeat);
      todoSseClients.delete(res);
    }
  }, 25000);

  req.on("close", function () {
    clearInterval(heartbeat);
    todoSseClients.delete(res);
  });
});

// POST /api/todos — add a one-line item. Body: { text, position? }
app.post("/api/todos", todoLimiter, function (req, res) {
  try {
    const body = req.body || {};
    const result = todoLib.addTodo(
      { text: body.text, position: body.position },
      { rootDir: TODO_DIR }
    );
    broadcastTodos(result.list);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/todos/reorder — persist a full priority order. Body: { ids: [] }
app.post("/api/todos/reorder", todoLimiter, function (req, res) {
  try {
    const body = req.body || {};
    const list = todoLib.reorderTodos({ ids: body.ids }, { rootDir: TODO_DIR });
    broadcastTodos(list);
    res.json({ list: list });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/todos/clear-done — drop every completed item.
app.post("/api/todos/clear-done", todoLimiter, function (req, res) {
  try {
    const result = todoLib.clearDone({ rootDir: TODO_DIR });
    broadcastTodos(result.list);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/todos/:id — toggle done or edit text. Body: { done? } or { text }
app.patch("/api/todos/:id", todoLimiter, function (req, res) {
  try {
    const id = req.params.id;
    const body = req.body || {};
    let result;
    if (typeof body.text === "string") {
      result = todoLib.updateTodo(
        { id: id, text: body.text },
        { rootDir: TODO_DIR }
      );
    } else {
      result = todoLib.toggleTodo(
        { id: id, done: body.done },
        { rootDir: TODO_DIR }
      );
    }
    broadcastTodos(result.list);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/todos/:id — remove one item.
app.delete("/api/todos/:id", todoLimiter, function (req, res) {
  try {
    const result = todoLib.removeTodo(
      { id: req.params.id },
      { rootDir: TODO_DIR }
    );
    broadcastTodos(result.list);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Only start the server when run directly (not when require()-d).
// Callers like dashboardCommand.ts and allScopesCommands.ts use
// spawn("node", [serverPath]) which sets require.main === module.
if (require.main === module) {
  startClaudePlanWatcher();
  startTodoWatcher();
  app.listen(PORT, "127.0.0.1", function () {
    console.log("\n  Dovetail Update Set Dashboard");
    console.log("  Instance:  " + SN_INSTANCE);
    console.log("  Project:   " + PROJECT_ROOT);
    console.log("  Dashboard: http://localhost:" + PORT);
    console.log("  Claude:    http://localhost:" + PORT + "/claude-plans");
    console.log("  TODO:      http://localhost:" + PORT + "/todos\n");
  });
}
