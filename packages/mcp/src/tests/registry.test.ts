import { TOOL_NAMES, buildDescriptorsForTests, RegistryDeps } from "../registry";

function makeFullDeps(): RegistryDeps {
  return {
    clickup: {
      config: { token: "pk", defaultTeamId: "1" },
      clientFactory: function () {
        return {} as any;
      }
    },
    gmail: {
      config: { clientId: "i", clientSecret: "s", refreshToken: "r" },
      authFactory: function () { return {} as any; },
      clientFactory: function () { return {} as any; }
    },
    calendar: {
      config: { clientId: "i", clientSecret: "s", refreshToken: "r" },
      authFactory: function () { return {} as any; },
      clientFactory: function () { return {} as any; }
    },
    servicenow: {
      safety: { denyTables: ["sys_user_password"], overrideTables: [] },
      clientFactory: function () { return {} as any; }
    }
  };
}

describe("registry — TOOL_NAMES", function () {
  it("exposes exactly 16 tool names", function () {
    expect(TOOL_NAMES.length).toBe(16);
  });

  it("has unique names", function () {
    var seen: Record<string, boolean> = {};
    for (var i = 0; i < TOOL_NAMES.length; i++) {
      var name = TOOL_NAMES[i];
      expect(seen[name]).toBeUndefined();
      seen[name] = true;
    }
  });

  it("matches the documented tool surface (Phase 1 reads + Phase 2 gated ClickUp writes)", function () {
    var expected = [
      "clickup_list_tasks",
      "clickup_get_task",
      "clickup_search_tasks",
      "clickup_get_team_sync",
      "clickup_update_task",
      "clickup_set_custom_field",
      "clickup_create_task",
      "clickup_link_tasks",
      "gmail_get_unread",
      "gmail_get_starred",
      "gmail_search",
      "gmail_get_action_required",
      "calendar_get_today",
      "calendar_get_week",
      "calendar_get_event",
      "servicenow_query_table"
    ];
    expect(Array.from(TOOL_NAMES)).toEqual(expected);
  });
});

describe("registry — descriptors", function () {
  it("produces a descriptor per tool with a description and shape", function () {
    var deps = makeFullDeps();
    var descs = buildDescriptorsForTests(deps);
    expect(descs.length).toBe(16);
    for (var i = 0; i < descs.length; i++) {
      var d = descs[i];
      expect(typeof d.description).toBe("string");
      expect(d.description.length).toBeGreaterThan(10);
      expect(typeof d.shape).toBe("object");
    }
  });

  it("guards ClickUp tools when clickup deps are missing", async function () {
    var deps = makeFullDeps();
    deps.clickup = undefined;
    deps.missingDescription = "missing CLICKUP_API_TOKEN";
    var descs = buildDescriptorsForTests(deps);
    var listTasks = descs.filter(function (d) { return d.name === "clickup_list_tasks"; })[0];
    var caught: any = null;
    try {
      await listTasks.handler({ teamId: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(String(caught.message)).toContain("ClickUp is not configured");
    expect(String(caught.message)).toContain("missing CLICKUP_API_TOKEN");
  });

  it("guards Google tools when google deps are missing", async function () {
    var deps = makeFullDeps();
    deps.gmail = undefined;
    deps.calendar = undefined;
    deps.missingDescription = "missing GOOGLE_*";
    var descs = buildDescriptorsForTests(deps);
    var unread = descs.filter(function (d) { return d.name === "gmail_get_unread"; })[0];
    var today = descs.filter(function (d) { return d.name === "calendar_get_today"; })[0];
    await expect(unread.handler({})).rejects.toThrow(/Gmail.*not configured/);
    await expect(today.handler({})).rejects.toThrow(/Calendar.*not configured/);
  });

  it("ServiceNow tool always wired (servicenow safety always present)", function () {
    var deps = makeFullDeps();
    var descs = buildDescriptorsForTests(deps);
    var sn = descs.filter(function (d) { return d.name === "servicenow_query_table"; })[0];
    expect(typeof sn.handler).toBe("function");
  });
});

describe("registry — annotations", function () {
  var readTools = [
    "clickup_list_tasks",
    "clickup_get_task",
    "clickup_search_tasks",
    "clickup_get_team_sync",
    "gmail_get_unread",
    "gmail_get_starred",
    "gmail_search",
    "gmail_get_action_required",
    "calendar_get_today",
    "calendar_get_week",
    "calendar_get_event",
    "servicenow_query_table"
  ];

  function byName(): Record<string, any> {
    var descs = buildDescriptorsForTests(makeFullDeps());
    var map: Record<string, any> = {};
    for (var i = 0; i < descs.length; i++) {
      map[descs[i].name] = descs[i];
    }
    return map;
  }

  it("every descriptor carries an annotations object", function () {
    var descs = buildDescriptorsForTests(makeFullDeps());
    for (var i = 0; i < descs.length; i++) {
      expect(typeof descs[i].annotations).toBe("object");
      expect(descs[i].annotations).not.toBeNull();
    }
  });

  it("read tools are marked readOnlyHint:true", function () {
    var map = byName();
    for (var i = 0; i < readTools.length; i++) {
      expect(map[readTools[i]].annotations.readOnlyHint).toBe(true);
    }
  });

  it("write tools are not read-only and carry destructive/idempotent hints", function () {
    var map = byName();

    expect(map["clickup_update_task"].annotations.readOnlyHint).toBe(false);
    expect(map["clickup_update_task"].annotations.destructiveHint).toBe(true);
    expect(map["clickup_update_task"].annotations.idempotentHint).toBe(true);

    expect(map["clickup_set_custom_field"].annotations.readOnlyHint).toBe(false);
    expect(map["clickup_set_custom_field"].annotations.destructiveHint).toBe(true);
    expect(map["clickup_set_custom_field"].annotations.idempotentHint).toBe(true);

    expect(map["clickup_create_task"].annotations.readOnlyHint).toBe(false);
    expect(map["clickup_create_task"].annotations.destructiveHint).toBe(false);
    expect(map["clickup_create_task"].annotations.idempotentHint).toBe(false);

    expect(map["clickup_link_tasks"].annotations.readOnlyHint).toBe(false);
    expect(map["clickup_link_tasks"].annotations.destructiveHint).toBe(false);
    expect(map["clickup_link_tasks"].annotations.idempotentHint).toBe(true);
  });
});
