// Tests for the Claude Code session detector behind the `dove watch` soft
// guard (claudeSession.ts, TenonHQ/Dovetail#155). Pure-function tests — an
// explicit env object is passed so the real process.env never leaks in.

import {
  isClaudeCodeSession,
  isClaudeCodeToolShell,
  isWatchInClaudeAllowed,
  WATCH_HUMAN_ONLY_WARNING,
} from "../claudeSession";

describe("isClaudeCodeToolShell (hard-block signal)", function () {
  it("is true only when CLAUDECODE has a value", function () {
    expect(isClaudeCodeToolShell({ CLAUDECODE: "1" })).toBe(true);
    expect(isClaudeCodeToolShell({ CLAUDECODE: " " })).toBe(false);
    expect(isClaudeCodeToolShell({})).toBe(false);
  });

  it("ignores CLAUDE_CODE_* config variables a human may have in their profile", function () {
    expect(isClaudeCodeToolShell({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(false);
    expect(isClaudeCodeSession({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
  });
});

describe("isWatchInClaudeAllowed", function () {
  it("accepts exactly 1", function () {
    expect(isWatchInClaudeAllowed({ DOVE_ALLOW_WATCH_IN_CLAUDE: "1" })).toBe(true);
  });

  it("rejects unset, empty, and other truthy-looking values", function () {
    expect(isWatchInClaudeAllowed({})).toBe(false);
    expect(isWatchInClaudeAllowed({ DOVE_ALLOW_WATCH_IN_CLAUDE: "" })).toBe(false);
    expect(isWatchInClaudeAllowed({ DOVE_ALLOW_WATCH_IN_CLAUDE: "true" })).toBe(false);
    expect(isWatchInClaudeAllowed({ DOVE_ALLOW_WATCH_IN_CLAUDE: "0" })).toBe(false);
  });
});

describe("isClaudeCodeSession", function () {
  it("returns false for an empty environment", function () {
    expect(isClaudeCodeSession({})).toBe(false);
  });

  it("returns false when only unrelated variables are set", function () {
    expect(isClaudeCodeSession({ HOME: "/tmp", SN_INSTANCE: "x.service-now.com" })).toBe(
      false,
    );
  });

  it("returns true when CLAUDECODE is set", function () {
    expect(isClaudeCodeSession({ CLAUDECODE: "1" })).toBe(true);
  });

  it("returns true when any CLAUDE_CODE_* variable is set", function () {
    expect(isClaudeCodeSession({ CLAUDE_CODE_SESSION_ID: "abc123" })).toBe(true);
    expect(isClaudeCodeSession({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(true);
  });

  it("treats empty or whitespace-only values as unset", function () {
    expect(isClaudeCodeSession({ CLAUDECODE: "" })).toBe(false);
    expect(isClaudeCodeSession({ CLAUDE_CODE_SESSION_ID: "   " })).toBe(false);
  });

  it("does not match look-alike prefixes", function () {
    expect(isClaudeCodeSession({ CLAUDE: "1", CLAUDECODEX: "1", MY_CLAUDE_CODE_X: "1" })).toBe(
      false,
    );
  });

  it("defaults to process.env and agrees with an explicit copy of it", function () {
    expect(isClaudeCodeSession()).toBe(isClaudeCodeSession({ ...process.env }));
  });
});

describe("WATCH_HUMAN_ONLY_WARNING", function () {
  it("names the hazard, the safe headless verbs, and the tracking issue", function () {
    expect(WATCH_HUMAN_ONLY_WARNING).toContain("human-only");
    expect(WATCH_HUMAN_ONLY_WARNING).toContain("branch switch");
    expect(WATCH_HUMAN_ONLY_WARNING).toContain("Claude Code");
    expect(WATCH_HUMAN_ONLY_WARNING).toContain("dove push");
    expect(WATCH_HUMAN_ONLY_WARNING).toContain("dove refresh");
    expect(WATCH_HUMAN_ONLY_WARNING).toContain("dove status");
    expect(WATCH_HUMAN_ONLY_WARNING).toContain("TenonHQ/Dovetail#155");
  });
});
