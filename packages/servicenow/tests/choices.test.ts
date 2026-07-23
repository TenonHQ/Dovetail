import { addChoicesToField, removeChoicesFromField } from "../src/choices";
import { makeMockClient as makeClient } from "./mockClient";

describe("addChoicesToField", function () {
  var dictRow = {
    sys_id: "dict1",
    name: "x_cadso_core_event",
    element: "state",
    choice: "0",
    sys_scope: "scope_core"
  };
  var updateSetRow = {
    sys_id: "us1",
    name: "Tenon - Core - Sinch DLR Tables",
    state: "in progress",
    application: "scope_core"
  };

  it("creates new choices and flips sys_dictionary.choice to 3", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [dictRow];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        if (table === "sys_choice") return [];
        return [];
      }
    });

    var result = await addChoicesToField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      updateSetSysId: "us1",
      choices: [
        { value: "delivered", label: "Delivered" },
        { value: "failed", label: "Failed" }
      ]
    });

    expect(result.dictionary.choiceWas).toBe(0);
    expect(result.dictionary.choiceNow).toBe(3);
    expect(result.choices.map(c => c.action)).toEqual(["created", "created"]);
    expect(ctx.calls.createRecord).toHaveLength(2);
    expect(ctx.calls.createRecord[0].table).toBe("sys_choice");
    expect(ctx.calls.createRecord[0].fields.name).toBe("x_cadso_core_event");
    expect(ctx.calls.createRecord[0].fields.element).toBe("state");
    expect(ctx.calls.createRecord[0].fields.sys_scope).toBe("scope_core");
    expect(ctx.calls.createRecord[0].update_set_sys_id).toBe("us1");
    expect(ctx.calls.createRecord[0].scope).toBe("x_cadso_core");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
    expect(ctx.calls.pushWithUpdateSet[0].table).toBe("sys_dictionary");
    expect(ctx.calls.pushWithUpdateSet[0].fields.choice).toBe("3");
  });

  it("is idempotent — returns unchanged for matching existing rows", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [{ ...dictRow, choice: "3" }];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        if (table === "sys_choice") {
          return [
            {
              sys_id: "ch1",
              value: "delivered",
              label: "Delivered",
              sequence: "",
              language: "en",
              inactive: "false"
            }
          ];
        }
        return [];
      }
    });

    var result = await addChoicesToField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      updateSetSysId: "us1",
      choices: [{ value: "delivered", label: "Delivered" }]
    });

    expect(result.choices[0].action).toBe("unchanged");
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
  });

  it("updates label when existing value has different label", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [{ ...dictRow, choice: "3" }];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        if (table === "sys_choice") {
          return [
            {
              sys_id: "ch1",
              value: "delivered",
              label: "OLD",
              sequence: "",
              language: "en",
              inactive: "false"
            }
          ];
        }
        return [];
      }
    });

    var result = await addChoicesToField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      updateSetSysId: "us1",
      choices: [{ value: "delivered", label: "Delivered" }]
    });

    expect(result.choices[0].action).toBe("updated");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
    expect(ctx.calls.pushWithUpdateSet[0].fields.label).toBe("Delivered");
  });

  it("rejects when sys_dictionary record is missing", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        return [];
      }
    });

    await expect(
      addChoicesToField(ctx.client, {
        table: "bogus",
        column: "column",
        updateSetSysId: "us1",
        choices: [{ value: "x", label: "X" }]
      })
    ).rejects.toThrow(/sys_dictionary record not found/);
  });

  it("rejects when update set is not in progress", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [dictRow];
        if (table === "sys_update_set") return [{ ...updateSetRow, state: "complete" }];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        return [];
      }
    });

    await expect(
      addChoicesToField(ctx.client, {
        table: "x_cadso_core_event",
        column: "state",
        updateSetSysId: "us1",
        choices: [{ value: "x", label: "X" }]
      })
    ).rejects.toThrow(/in progress/);
  });

  it("rejects empty updateSetSysId", async function () {
    var ctx = makeClient();
    await expect(
      addChoicesToField(ctx.client, {
        table: "t",
        column: "c",
        updateSetSysId: "",
        choices: [{ value: "x", label: "X" }]
      })
    ).rejects.toThrow(/updateSetSysId is required/);
  });

  it("never creates a duplicate sys_choice row for a repeated value — last label wins", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [{ ...dictRow, choice: "3" }];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        if (table === "sys_choice") return [];
        return [];
      }
    });

    var result = await addChoicesToField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      updateSetSysId: "us1",
      choices: [
        { value: "delivered", label: "Old Label" },
        { value: "delivered", label: "New Label" }
      ]
    });

    // The existing-choice cache is read once, so an un-deduped repeat would fall through
    // to createRecord twice and leave two live rows for the same value.
    expect(ctx.calls.createRecord).toHaveLength(1);
    expect(ctx.calls.createRecord[0].fields.label).toBe("New Label");
    expect(result.choices).toHaveLength(1);
  });
});

describe("removeChoicesFromField", function () {
  var dictRow = {
    sys_id: "dict1",
    name: "x_cadso_core_event",
    element: "state",
    choice: "3",
    sys_scope: "scope_core"
  };
  var updateSetRow = {
    sys_id: "us1",
    name: "Tenon - Core - Sinch DLR Tables",
    state: "in progress",
    application: "scope_core"
  };

  function clientWithChoices(choiceRows: Array<any>) {
    return makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [dictRow];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_choice") return choiceRows;
        return [];
      }
    });
  }

  it("soft-deletes an active value by setting inactive=true — never a hard delete", async function () {
    var ctx = clientWithChoices([
      { sys_id: "ch1", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "false" }
    ]);

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["delivered"],
      updateSetSysId: "us1"
    });

    expect(result.choices[0].action).toBe("deactivated");
    expect(result.choices[0].sysId).toBe("ch1");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
    expect(ctx.calls.pushWithUpdateSet[0].table).toBe("sys_choice");
    expect(ctx.calls.pushWithUpdateSet[0].record_sys_id).toBe("ch1");
    expect(ctx.calls.pushWithUpdateSet[0].fields.inactive).toBe("true");
    expect(ctx.calls.pushWithUpdateSet[0].update_set_sys_id).toBe("us1");
    // Soft-delete only — the row is never dropped, and no new row is created.
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(ctx.calls.createRecord).toHaveLength(0);
  });

  it("is idempotent — an already-inactive value is 'unchanged' with no write", async function () {
    var ctx = clientWithChoices([
      { sys_id: "ch1", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "true" }
    ]);

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["delivered"],
      updateSetSysId: "us1"
    });

    expect(result.choices[0].action).toBe("unchanged");
    expect(result.choices[0].sysId).toBe("ch1");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
  });

  it("reports a value that does not exist on the field as 'missing' — no write", async function () {
    var ctx = clientWithChoices([
      { sys_id: "ch1", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "false" }
    ]);

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["nonexistent"],
      updateSetSysId: "us1"
    });

    expect(result.choices[0].action).toBe("missing");
    expect(result.choices[0].sysId).toBe("");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
  });

  it("matches on language — an 'en' request leaves a 'fr' row of the same value untouched", async function () {
    var ctx = clientWithChoices([
      { sys_id: "chfr", value: "delivered", label: "Livré", sequence: "", language: "fr", inactive: "false" }
    ]);

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["delivered"],
      updateSetSysId: "us1"
    });

    expect(result.choices[0].action).toBe("missing");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
  });

  it("mixes deactivated / unchanged / missing across one batch", async function () {
    var ctx = clientWithChoices([
      { sys_id: "ch1", value: "a", label: "A", sequence: "", language: "en", inactive: "false" },
      { sys_id: "ch2", value: "b", label: "B", sequence: "", language: "en", inactive: "true" }
    ]);

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["a", "b", "c"],
      updateSetSysId: "us1"
    });

    expect(result.choices.map(c => c.action)).toEqual([
      "deactivated",
      "unchanged",
      "missing"
    ]);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
    expect(ctx.calls.pushWithUpdateSet[0].record_sys_id).toBe("ch1");
  });

  it("rejects when the field's sys_dictionary row is missing — no silent all-missing", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [];
        if (table === "sys_update_set") return [updateSetRow];
        return [];
      }
    });

    await expect(
      removeChoicesFromField(ctx.client, {
        table: "bogus",
        column: "column",
        values: ["x"],
        updateSetSysId: "us1"
      })
    ).rejects.toThrow(/sys_dictionary record not found/);
  });

  it("rejects empty updateSetSysId", async function () {
    var ctx = makeClient();
    await expect(
      removeChoicesFromField(ctx.client, {
        table: "t",
        column: "c",
        values: ["x"],
        updateSetSysId: ""
      })
    ).rejects.toThrow(/updateSetSysId is required/);
  });

  it("rejects an empty values array", async function () {
    var ctx = makeClient();
    await expect(
      removeChoicesFromField(ctx.client, {
        table: "t",
        column: "c",
        values: [],
        updateSetSysId: "us1"
      })
    ).rejects.toThrow(/values must be a non-empty array/);
  });

  it("collapses a repeated value to one write and one result row", async function () {
    var ctx = clientWithChoices([
      { sys_id: "ch1", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "false" }
    ]);

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["delivered", "delivered", "delivered"],
      updateSetSysId: "us1"
    });

    // The cache is read once up front, so an un-deduped repeat would re-push the same
    // sys_id and double-count it in the summary.
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].action).toBe("deactivated");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
  });

  it("refuses a truncated choice list rather than reporting live values as missing", async function () {
    var thousand = [];
    for (var i = 0; i < 1000; i += 1) {
      thousand.push({
        sys_id: "ch" + i,
        value: "v" + i,
        label: "V" + i,
        sequence: "",
        language: "en",
        inactive: "false"
      });
    }
    var ctx = clientWithChoices(thousand);

    await expect(
      removeChoicesFromField(ctx.client, {
        table: "x_cadso_core_event",
        column: "state",
        values: ["v0"],
        updateSetSysId: "us1"
      })
    ).rejects.toThrow(/truncated choice list/);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
  });
});
