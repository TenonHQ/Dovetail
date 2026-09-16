const fs = require("fs");

// Scope -> "App" label used in generated update-set names. Mirrors the
// override table in .claude/skills/sn-move-update-set so both tools agree.
const SCOPE_LABEL_OVERRIDES = {
  x_cadso_journey: "Journey",
  x_cadso_core: "Core",
  x_cadso_automate: "Automate",
  x_cadso_text_spoke: "Text",
  x_cadso_email_spok: "Email",
};

function scopeLabel(scope) {
  if (SCOPE_LABEL_OVERRIDES[scope]) return SCOPE_LABEL_OVERRIDES[scope];
  const stripped = scope.replace(/^x_cadso_/, "");
  return stripped
    .split(/[_-]/)
    .filter(Boolean)
    .map(function (word) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function sanitizeTaskName(taskName) {
  return taskName.replace(/[^a-zA-Z0-9\s\-_]/g, "").trim();
}

function generateUpdateSetName(devInitials, taskId, shortDesc) {
  const parts = [];
  if (devInitials) parts.push(devInitials);
  parts.push(taskId);
  parts.push(shortDesc);
  return parts.join(" | ").substring(0, 80);
}

function buildScopedUpdateSetName(activeTask, appLabel) {
  const parts = [];
  if (activeTask.devInitials) parts.push(activeTask.devInitials);
  parts.push(activeTask.customId || activeTask.taskId);
  parts.push(appLabel);
  parts.push(activeTask.shortDesc || activeTask.taskName);
  return parts.join(" | ").substring(0, 80);
}

function generateUpdateSetDescription(taskName, taskDescription) {
  let description = taskName;
  if (taskDescription) {
    const firstSentence = taskDescription.split(/[.!\n]/)[0].trim();
    if (firstSentence) {
      description += " — " + firstSentence.substring(0, 150);
    }
  }
  return description;
}

// Never throws. Invalid or unreadable files degrade to "no active task".
function readActiveTask(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (error) {
    console.warn(
      "[dashboard] ignoring unreadable active-task file " +
        filePath +
        ": " +
        (error && error.message ? error.message : error),
    );
    return null;
  }
}

function extractDuplicateNumber(name, baseName) {
  if (name === baseName) return -1;
  const suffix = name.substring(baseName.length).trim();
  const number = parseInt(suffix, 10);
  return isNaN(number) ? -1 : number;
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
