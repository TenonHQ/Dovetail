const fs = require("fs");

// Scope -> "App" label used in generated update-set names. Mirrors the
// override table in .claude/skills/sn-move-update-set so both tools agree.
var SCOPE_LABEL_OVERRIDES = {
  x_cadso_journey: "Journey",
  x_cadso_core: "Core",
  x_cadso_automate: "Automate",
  x_cadso_text_spoke: "Text",
  x_cadso_email_spok: "Email",
};

function scopeLabel(scope) {
  if (SCOPE_LABEL_OVERRIDES[scope]) return SCOPE_LABEL_OVERRIDES[scope];
  var stripped = scope.replace(/^x_cadso_/, "");
  return stripped
    .split(/[_-]/)
    .filter(Boolean)
    .map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function sanitizeTaskName(taskName) {
  return taskName.replace(/[^a-zA-Z0-9\s\-_]/g, "").trim();
}

// Task-level base name (no App segment yet — that's added per-scope by
// buildScopedUpdateSetName, since one task can span multiple scopes/apps).
function generateUpdateSetName(devInitials, taskId, shortDesc) {
  var parts = [];
  if (devInitials) parts.push(devInitials);
  parts.push(taskId);
  parts.push(shortDesc);
  return parts.join(" | ").substring(0, 80);
}

// Full per-scope update-set name: {DEVINITIALS} | {DEV-ID} | {App} | {Short Desc}
function buildScopedUpdateSetName(activeTask, appLabel) {
  var parts = [];
  if (activeTask.devInitials) parts.push(activeTask.devInitials);
  parts.push(activeTask.customId || activeTask.taskId);
  parts.push(appLabel);
  parts.push(activeTask.shortDesc || activeTask.taskName);
  return parts.join(" | ").substring(0, 80);
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

// Read active task from persistence file.
//
// Never throws. A truncated or hand-edited task file used to take down every
// endpoint that reads it (/api/scopes, /api/update-sets, the activate and
// create paths) with a 500 from JSON.parse — so a malformed file degrades to
// "no active task" instead. The shape is checked too: JSON.parse legitimately
// yields null / a string / an array for a valid-but-wrong file, and callers
// dot into this as an object (activeTask.devInitials, .customId, .taskName).
function readActiveTask(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    var parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn(
      "[dashboard] ignoring unreadable active-task file " +
        filePath +
        ": " +
        (e && e.message ? e.message : e),
    );
    return null;
  }
}

// Extract duplicate number from ServiceNow auto-numbered name
// "CU-abc — Name" => -1, "CU-abc — Name 1" => 1, "CU-abc — Name 2" => 2
function extractDuplicateNumber(name, baseName) {
  if (name === baseName) return -1;
  var suffix = name.substring(baseName.length).trim();
  var num = parseInt(suffix, 10);
  return isNaN(num) ? -1 : num;
}

module.exports = {
  buildScopedUpdateSetName,
  extractDuplicateNumber,
  generateUpdateSetDescription,
  generateUpdateSetName,
  readActiveTask,
  sanitizeTaskName,
  scopeLabel,
};
