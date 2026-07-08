import { setRelatedLists } from "../src/layout/relatedLists";
import { makeMockClient } from "./mockClient";

var US = { sys_id: "us1", name: "Work", state: "in progress" };

function entryRow(sysId: string, relatedList: string, position: number) {
  return {
    sys_id: sysId,
    related_list: relatedList,
    position: String(position),
  };
}

function globalList() {
  return { sys_id: "list1", view: "", sys_user: "" };
}

describe("setRelatedLists", function () {
  it("rejects an empty relatedLists array", async function () {
    var ctx = makeMockClient();
    await expect(
      setRelatedLists(ctx.client, {
        table: "x_cadso_automate_audience",
        relatedLists: [],
        updateSetSysId: "us1",
        scope: "x_cadso_automate",
      }),
    ).rejects.toThrow(/relatedLists must be a non-empty array/);
  });

  it("rejects an update set that is not in progress", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set")
          return [{ sys_id: "us1", name: "Done", state: "complete" }];
        return [];
      },
    });
    await expect(
      setRelatedLists(ctx.client, {
        table: "x_cadso_automate_audience",
        relatedLists: ["x_cadso_automate_email_send.audiences"],
        updateSetSysId: "us1",
        scope: "x_cadso_automate",
      }),
    ).rejects.toThrow(/in progress/);
  });

  it("creates the related list and all entries from scratch", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      },
    });
    var result = await setRelatedLists(ctx.client, {
      table: "x_cadso_automate_audience",
      relatedLists: [
        "x_cadso_automate_email_send.audiences",
        "x_cadso_automate_sms_send.audiences",
        "REL:abc123",
      ],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
    });
    expect(result.dryRun).toBe(false);
    expect(result.view).toBe("");
    var listCreates = ctx.calls.createRecord.filter(function (c) {
      return c.table === "sys_ui_related_list";
    });
    var entryCreates = ctx.calls.createRecord.filter(function (c) {
      return c.table === "sys_ui_related_list_entry";
    });
    expect(listCreates).toHaveLength(1);
    expect(listCreates[0].fields.name).toBe("x_cadso_automate_audience");
    expect(listCreates[0].update_set_sys_id).toBe("us1");
    expect(
      entryCreates.map(function (c) {
        return c.fields.related_list;
      }),
    ).toEqual([
      "x_cadso_automate_email_send.audiences",
      "x_cadso_automate_sms_send.audiences",
      "REL:abc123",
    ]);
    expect(
      entryCreates.map(function (c) {
        return c.fields.position;
      }),
    ).toEqual(["0", "1", "2"]);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
  });

  it("is idempotent — re-running an existing layout writes nothing", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_related_list") return [globalList()];
        if (table === "sys_ui_related_list_entry")
          return [
            entryRow("e0", "x_cadso_automate_email_send.audiences", 0),
            entryRow("e1", "x_cadso_automate_sms_send.audiences", 1),
          ];
        return [];
      },
    });
    var result = await setRelatedLists(ctx.client, {
      table: "x_cadso_automate_audience",
      relatedLists: [
        "x_cadso_automate_email_send.audiences",
        "x_cadso_automate_sms_send.audiences",
      ],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
    });
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(
      result.records.every(function (r) {
        return r.action === "unchanged";
      }),
    ).toBe(true);
  });

  it("repositions a moved entry", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_related_list") return [globalList()];
        if (table === "sys_ui_related_list_entry")
          return [
            entryRow("e0", "x_cadso_automate_email_send.audiences", 0),
            entryRow("e1", "x_cadso_automate_sms_send.audiences", 1),
          ];
        return [];
      },
    });
    await setRelatedLists(ctx.client, {
      table: "x_cadso_automate_audience",
      relatedLists: [
        "x_cadso_automate_sms_send.audiences",
        "x_cadso_automate_email_send.audiences",
      ],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
    });
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(2);
    expect(ctx.calls.pushWithUpdateSet[0].table).toBe(
      "sys_ui_related_list_entry",
    );
    expect(ctx.calls.deleteRecord).toHaveLength(0);
  });

  it("prunes a removed entry and pins the update set before deleting", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_related_list") return [globalList()];
        if (table === "sys_ui_related_list_entry")
          return [
            entryRow("e0", "x_cadso_automate_email_send.audiences", 0),
            entryRow("e1", "x_cadso_automate_stale.audiences", 1),
          ];
        return [];
      },
    });
    var result = await setRelatedLists(ctx.client, {
      table: "x_cadso_automate_audience",
      relatedLists: ["x_cadso_automate_email_send.audiences"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
    });
    expect(ctx.calls.deleteRecord).toHaveLength(1);
    expect(ctx.calls.deleteRecord[0].sys_id).toBe("e1");
    expect(ctx.calls.changeUpdateSet).toEqual([{ sysId: "us1" }]);
    expect(
      result.records.filter(function (r) {
        return r.action === "deleted";
      }),
    ).toHaveLength(1);
  });

  it("keeps a removed entry when prune is false", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_related_list") return [globalList()];
        if (table === "sys_ui_related_list_entry")
          return [
            entryRow("e0", "x_cadso_automate_email_send.audiences", 0),
            entryRow("e1", "x_cadso_automate_extra.audiences", 1),
          ];
        return [];
      },
    });
    await setRelatedLists(ctx.client, {
      table: "x_cadso_automate_audience",
      relatedLists: ["x_cadso_automate_email_send.audiences"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
      prune: false,
    });
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
  });

  it("dryRun plans the layout without writing", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      },
    });
    var result = await setRelatedLists(ctx.client, {
      table: "x_cadso_automate_audience",
      relatedLists: [
        "x_cadso_automate_email_send.audiences",
        "x_cadso_automate_sms_send.audiences",
      ],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(
      result.records.filter(function (r) {
        return r.action === "created";
      }).length,
    ).toBeGreaterThan(0);
  });

  it("dedupes repeated related-list identifiers", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      },
    });
    await setRelatedLists(ctx.client, {
      table: "x_cadso_automate_audience",
      relatedLists: [
        "x_cadso_automate_email_send.audiences",
        "x_cadso_automate_sms_send.audiences",
        "x_cadso_automate_email_send.audiences",
      ],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
    });
    var entryCreates = ctx.calls.createRecord.filter(function (c) {
      return c.table === "sys_ui_related_list_entry";
    });
    expect(
      entryCreates.map(function (c) {
        return c.fields.related_list;
      }),
    ).toEqual([
      "x_cadso_automate_email_send.audiences",
      "x_cadso_automate_sms_send.audiences",
    ]);
  });
});
