import { setFormLayout } from "../src/layout/formLayout";
import { makeMockClient } from "./mockClient";

var US = { sys_id: "us1", name: "Work", state: "in progress" };

/** A global sys_ui_form row for the Default view. */
function formRow(sysId: string) {
  return { sys_id: sysId, view: "", sys_user: "" };
}

/** A sys_ui_section row for the Default view. caption "" = primary section. */
function sectionRow(sysId: string, caption: string) {
  return { sys_id: sysId, caption: caption, view: "", sys_user: "" };
}

/** A sys_ui_form_section join row placing a section onto a form. */
function joinRow(sysId: string, formSysId: string, sectionSysId: string, position: number) {
  return {
    sys_id: sysId,
    sys_ui_form: formSysId,
    sys_ui_section: sectionSysId,
    position: String(position)
  };
}

/** A sys_ui_element field row within a section. */
function elementRow(sysId: string, element: string, position: number) {
  return { sys_id: sysId, element: element, position: String(position) };
}

describe("setFormLayout", function () {
  it("rejects an empty sections array", async function () {
    var ctx = makeMockClient();
    await expect(setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    })).rejects.toThrow(/sections must be a non-empty array/);
  });

  it("rejects an update set that is not in progress", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [{ sys_id: "us1", name: "Done", state: "complete" }];
        return [];
      }
    });
    await expect(setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [{ fields: ["number"] }],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    })).rejects.toThrow(/in progress/);
  });

  it("rejects duplicate section captions", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    await expect(setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [
        { caption: "Meta Data", fields: ["a"] },
        { caption: "Meta Data", fields: ["b"] }
      ],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    })).rejects.toThrow(/duplicate section caption/);
  });

  it("treats two missing captions as duplicate primary sections", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    await expect(setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [{ fields: ["a"] }, { fields: ["b"] }],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    })).rejects.toThrow(/duplicate section caption/);
  });

  it("creates a single-section form with all its fields from scratch", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    var result = await setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [{ fields: ["number", "name", "state"] }],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(result.dryRun).toBe(false);
    expect(result.view).toBe("");

    var formCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_form"; });
    var sectionCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_section"; });
    var joinCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_form_section"; });
    var elementCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_element"; });

    expect(formCreates).toHaveLength(1);
    expect(formCreates[0].fields.name).toBe("x_cadso_automate_audience");
    expect(formCreates[0].update_set_sys_id).toBe("us1");

    expect(sectionCreates).toHaveLength(1);
    expect(sectionCreates[0].fields.caption).toBe("");
    // Primary (blank caption) section: title "false".
    expect(sectionCreates[0].fields.title).toBe("false");
    expect(sectionCreates[0].fields.header).toBe("false");

    expect(joinCreates).toHaveLength(1);
    expect(joinCreates[0].fields.sys_ui_form).toBe(formCreates[0] && "new_1");
    expect(joinCreates[0].fields.position).toBe("0");

    expect(elementCreates.map(function (c) { return c.fields.element; })).toEqual(["number", "name", "state"]);
    expect(elementCreates.map(function (c) { return c.fields.position; })).toEqual(["0", "1", "2"]);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
  });

  it("creates a two-section form with positioned join rows", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    var result = await setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [
        { fields: ["number", "name"] },
        { caption: "Meta Data", fields: ["created_by", "sys_updated_on"] }
      ],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(result.dryRun).toBe(false);

    var sectionCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_section"; });
    var joinCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_form_section"; });
    var elementCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_element"; });

    expect(sectionCreates).toHaveLength(2);
    expect(sectionCreates.map(function (c) { return c.fields.caption; })).toEqual(["", "Meta Data"]);
    // Non-primary section gets title "true"; primary gets "false".
    expect(sectionCreates[0].fields.title).toBe("false");
    expect(sectionCreates[1].fields.title).toBe("true");

    expect(joinCreates).toHaveLength(2);
    expect(joinCreates.map(function (c) { return c.fields.position; })).toEqual(["0", "1"]);

    expect(elementCreates).toHaveLength(4);
    expect(elementCreates.map(function (c) { return c.fields.element; }))
      .toEqual(["number", "name", "created_by", "sys_updated_on"]);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
  });

  it("is idempotent — re-running an existing layout writes nothing", async function () {
    var ctx = makeMockClient({
      query: async function (table, query) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_form") return [formRow("form1")];
        if (table === "sys_ui_section") return [sectionRow("sec0", ""), sectionRow("sec1", "Meta Data")];
        if (table === "sys_ui_form_section") {
          return [joinRow("j0", "form1", "sec0", 0), joinRow("j1", "form1", "sec1", 1)];
        }
        if (table === "sys_ui_element") {
          if (query === "sys_ui_section=sec0") {
            return [elementRow("e0", "number", 0), elementRow("e1", "name", 1)];
          }
          if (query === "sys_ui_section=sec1") {
            return [elementRow("e2", "created_by", 0)];
          }
          return [];
        }
        return [];
      }
    });
    var result = await setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [
        { fields: ["number", "name"] },
        { caption: "Meta Data", fields: ["created_by"] }
      ],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
    expect(result.records.every(function (r) { return r.action === "unchanged"; })).toBe(true);
  });

  it("reorders fields within a section via pushWithUpdateSet", async function () {
    var ctx = makeMockClient({
      query: async function (table, query) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_form") return [formRow("form1")];
        if (table === "sys_ui_section") return [sectionRow("sec0", "")];
        if (table === "sys_ui_form_section") return [joinRow("j0", "form1", "sec0", 0)];
        if (table === "sys_ui_element" && query === "sys_ui_section=sec0") {
          return [elementRow("e0", "number", 0), elementRow("e1", "name", 1)];
        }
        return [];
      }
    });
    await setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [{ fields: ["name", "number"] }],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(2);
    expect(ctx.calls.pushWithUpdateSet[0].table).toBe("sys_ui_element");
    expect(ctx.calls.deleteRecord).toHaveLength(0);
  });

  it("prunes a dropped field and pins the update set before deleting", async function () {
    var ctx = makeMockClient({
      query: async function (table, query) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_form") return [formRow("form1")];
        if (table === "sys_ui_section") return [sectionRow("sec0", "")];
        if (table === "sys_ui_form_section") return [joinRow("j0", "form1", "sec0", 0)];
        if (table === "sys_ui_element" && query === "sys_ui_section=sec0") {
          return [elementRow("e0", "number", 0), elementRow("e1", "stale", 1)];
        }
        return [];
      }
    });
    var result = await setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [{ fields: ["number"] }],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(ctx.calls.deleteRecord).toHaveLength(1);
    expect(ctx.calls.deleteRecord[0].table).toBe("sys_ui_element");
    expect(ctx.calls.deleteRecord[0].sys_id).toBe("e1");
    expect(ctx.calls.changeUpdateSet).toEqual([{ sysId: "us1" }]);
    expect(result.records.filter(function (r) { return r.action === "deleted"; })).toHaveLength(1);
  });

  it("prunes a dropped section, its join, and all its element rows", async function () {
    var ctx = makeMockClient({
      query: async function (table, query) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_form") return [formRow("form1")];
        if (table === "sys_ui_section") return [sectionRow("sec0", ""), sectionRow("sec1", "Meta Data")];
        if (table === "sys_ui_form_section") {
          return [joinRow("j0", "form1", "sec0", 0), joinRow("j1", "form1", "sec1", 1)];
        }
        if (table === "sys_ui_element") {
          if (query === "sys_ui_section=sec0") return [elementRow("e0", "number", 0)];
          if (query === "sys_ui_section=sec1") {
            return [elementRow("e1", "created_by", 0), elementRow("e2", "sys_updated_on", 1)];
          }
          return [];
        }
        return [];
      }
    });
    var result = await setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [{ fields: ["number"] }],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.changeUpdateSet).toEqual([{ sysId: "us1" }]);
    // Join + 2 orphaned elements + the orphaned section = 4 deletes.
    expect(ctx.calls.deleteRecord).toHaveLength(4);
    var deletedTables = ctx.calls.deleteRecord.map(function (c) { return c.table; });
    expect(deletedTables.filter(function (t) { return t === "sys_ui_form_section"; })).toHaveLength(1);
    expect(deletedTables.filter(function (t) { return t === "sys_ui_section"; })).toHaveLength(1);
    expect(deletedTables.filter(function (t) { return t === "sys_ui_element"; })).toHaveLength(2);
    // The orphaned element rows must be deleted before the section row.
    var sectionIdx = deletedTables.indexOf("sys_ui_section");
    var elementIdxs = ctx.calls.deleteRecord
      .map(function (c, i) { return c.table === "sys_ui_element" ? i : -1; })
      .filter(function (i) { return i >= 0; });
    elementIdxs.forEach(function (i) { expect(i).toBeLessThan(sectionIdx); });
    expect(result.records.filter(function (r) { return r.action === "deleted"; })).toHaveLength(4);
  });

  it("keeps a dropped field when prune is false", async function () {
    var ctx = makeMockClient({
      query: async function (table, query) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_form") return [formRow("form1")];
        if (table === "sys_ui_section") return [sectionRow("sec0", "")];
        if (table === "sys_ui_form_section") return [joinRow("j0", "form1", "sec0", 0)];
        if (table === "sys_ui_element" && query === "sys_ui_section=sec0") {
          return [elementRow("e0", "number", 0), elementRow("e1", "extra", 1)];
        }
        return [];
      }
    });
    await setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [{ fields: ["number"] }],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
      prune: false
    });
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
  });

  it("dryRun plans the layout without writing", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    var result = await setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [
        { fields: ["number", "name"] },
        { caption: "Meta Data", fields: ["created_by"] }
      ],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
      dryRun: true
    });
    expect(result.dryRun).toBe(true);
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
    expect(result.records.filter(function (r) { return r.action === "created"; }).length).toBeGreaterThan(0);
    // form + 2 sections + 2 joins + 3 elements all planned as created.
    expect(result.records.filter(function (r) {
      return r.table === "sys_ui_element" && r.action === "created";
    })).toHaveLength(3);
  });

  it("dedupes repeated fields within a section", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    await setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [{ fields: ["number", "name", "number"] }],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    var elementCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_element"; });
    expect(elementCreates.map(function (c) { return c.fields.element; })).toEqual(["number", "name"]);
  });

  it("adds a new section to an existing single-section form", async function () {
    var ctx = makeMockClient({
      query: async function (table, query) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_form") return [formRow("form1")];
        if (table === "sys_ui_section") return [sectionRow("sec0", "")];
        if (table === "sys_ui_form_section") return [joinRow("j0", "form1", "sec0", 0)];
        if (table === "sys_ui_element" && query === "sys_ui_section=sec0") {
          return [elementRow("e0", "number", 0)];
        }
        return [];
      }
    });
    await setFormLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      sections: [
        { fields: ["number"] },
        { caption: "Meta Data", fields: ["created_by"] }
      ],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    var sectionCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_section"; });
    var joinCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_form_section"; });
    var elementCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_element"; });
    // Only the new section + its join + its one element are created.
    expect(sectionCreates).toHaveLength(1);
    expect(sectionCreates[0].fields.caption).toBe("Meta Data");
    expect(joinCreates).toHaveLength(1);
    expect(joinCreates[0].fields.position).toBe("1");
    expect(joinCreates[0].fields.sys_ui_section).toBe(sectionCreates[0] && "new_1");
    expect(elementCreates).toHaveLength(1);
    expect(elementCreates[0].fields.element).toBe("created_by");
    expect(ctx.calls.deleteRecord).toHaveLength(0);
  });
});
