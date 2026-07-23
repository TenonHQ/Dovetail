import { addChoicesToField, removeChoicesFromField } from "../src/choices";
import type { ChoiceActionResult } from "../src/types";
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

  it("keeps ChoiceActionResult constructible without sysIds — published type stays compatible", function () {
    // ChoiceActionResult ships in @tenonhq/dovetail-servicenow, so a REQUIRED new field
    // would fail to compile for any consumer that builds or mocks one. This object is
    // the pre-sysIds shape; if sysIds ever becomes required again, tsc fails here.
    var legacy: ChoiceActionResult = {
      value: "delivered",
      label: "Delivered",
      sysId: "ch1",
      action: "created"
    };

    expect(legacy.sysIds).toBeUndefined();
    // The runtime nonetheless always populates it — see the assertions below.
  });

  it("updates EVERY duplicate row for a value so they converge on one label", async function () {
    // Same reasoning as the remove path: updating one of two live rows leaves the other
    // showing the stale label in the dropdown while the result claims "updated".
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [{ ...dictRow, choice: "3" }];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        if (table === "sys_choice")
          return [
            { sys_id: "dupeA", value: "delivered", label: "Stale", sequence: "", language: "en", inactive: "false" },
            { sys_id: "dupeB", value: "delivered", label: "Stale", sequence: "", language: "en", inactive: "false" }
          ];
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
    expect(result.choices[0].sysIds).toEqual(["dupeA", "dupeB"]);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(2);
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet[0].fields.label).toBe("Delivered");
    expect(ctx.calls.pushWithUpdateSet[1].fields.label).toBe("Delivered");
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

  it("deactivates EVERY duplicate row for a value, not just the last one found", async function () {
    // sys_choice has no uniqueness constraint on (name, element, value, language), so a
    // field can genuinely hold two live rows for one value. Acting on one and reporting
    // "deactivated" would leave the choice selectable in the dropdown.
    var ctx = clientWithChoices([
      { sys_id: "dupeA", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "false" },
      { sys_id: "dupeB", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "false" }
    ]);

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["delivered"],
      updateSetSysId: "us1"
    });

    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].action).toBe("deactivated");
    expect(result.choices[0].sysIds).toEqual(["dupeA", "dupeB"]);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(2);
    expect(
      ctx.calls.pushWithUpdateSet.map(function (c: any) {
        return c.record_sys_id;
      })
    ).toEqual(["dupeA", "dupeB"]);
  });

  it("deactivates only the still-live duplicate when one is already inactive", async function () {
    var ctx = clientWithChoices([
      { sys_id: "dupeA", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "true" },
      { sys_id: "dupeB", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "false" }
    ]);

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["delivered"],
      updateSetSysId: "us1"
    });

    expect(result.choices[0].action).toBe("deactivated");
    expect(result.choices[0].sysIds).toEqual(["dupeA", "dupeB"]);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
    expect(ctx.calls.pushWithUpdateSet[0].record_sys_id).toBe("dupeB");
  });

  it("reports 'unchanged' with no write when every duplicate is already inactive", async function () {
    var ctx = clientWithChoices([
      { sys_id: "dupeA", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "true" },
      { sys_id: "dupeB", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "true" }
    ]);

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["delivered"],
      updateSetSysId: "us1"
    });

    expect(result.choices[0].action).toBe("unchanged");
    expect(result.choices[0].sysIds).toEqual(["dupeA", "dupeB"]);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
  });

  function manyChoices(count: number) {
    var rows = [];
    for (var i = 0; i < count; i += 1) {
      rows.push({
        sys_id: "ch" + i,
        value: "v" + i,
        label: "V" + i,
        sequence: "",
        language: "en",
        inactive: "false"
      });
    }
    return rows;
  }

  it("reads only the requested values, so the query does not grow with the field", async function () {
    var ctx = clientWithChoices([
      { sys_id: "ch1", value: "delivered", label: "Delivered", sequence: "", language: "en", inactive: "false" }
    ]);

    await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["delivered", "failed"],
      updateSetSysId: "us1"
    });

    var choiceQueries = ctx.calls.tableQuery.filter(function (c) {
      return c.table === "sys_choice";
    });
    expect(choiceQueries).toHaveLength(1);
    expect(choiceQueries[0].query).toBe(
      "name=x_cadso_core_event^element=state^valueINdelivered,failed"
    );
  });

  it("batches a long value list instead of building one enormous query", async function () {
    var ctx = clientWithChoices([]);
    var values = [];
    for (var i = 0; i < 120; i += 1) {
      values.push("v" + i);
    }

    await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: values,
      updateSetSysId: "us1"
    });

    var choiceQueries = ctx.calls.tableQuery.filter(function (c) {
      return c.table === "sys_choice";
    });
    // 120 values at a batch size of 50 → 50 + 50 + 20.
    expect(choiceQueries).toHaveLength(3);
    expect(choiceQueries[0].query.split(",")).toHaveLength(50);
    expect(choiceQueries[2].query.split(",")).toHaveLength(20);
  });

  it("stays usable on a field with far more choices than one page fits", async function () {
    // The whole-field read refused outright above the page ceiling, which made both
    // verbs unusable on a large choice set. Scoping the read to the requested values
    // bounds it by the request instead, so field size stops mattering.
    var ctx = makeClient({
      query: async function (table: string, query?: string) {
        if (table === "sys_dictionary") return [dictRow];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_choice") {
          // A 40,000-row field: the instance only ever returns the asked-for value.
          expect(query).toContain("^valueINv7");
          return [
            { sys_id: "ch7", value: "v7", label: "V7", sequence: "", language: "en", inactive: "false" }
          ];
        }
        return [];
      }
    });

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["v7"],
      updateSetSysId: "us1"
    });

    expect(result.choices[0].action).toBe("deactivated");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
  });

  it("refuses a truncated read rather than reporting live values as missing", async function () {
    // Backstop only: one batch asks for at most 50 values, so overflowing a page means
    // absurd duplication on a single value. Still must refuse rather than guess.
    var ctx = clientWithChoices(manyChoices(1001));

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

  it("refuses a value carrying encoded-query metacharacters instead of malforming the query", async function () {
    var ctx = clientWithChoices([]);

    await expect(
      removeChoicesFromField(ctx.client, {
        table: "x_cadso_core_event",
        column: "state",
        values: ["a^b"],
        updateSetSysId: "us1"
      })
    ).rejects.toThrow(/Invalid character in query value/);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
  });

  it("handles values named after Object.prototype members without dropping them", async function () {
    // On a plain {} lookup, seen["constructor"] is truthy via the prototype chain, so
    // dedupe would treat the value as a repeat and drop it from the request entirely —
    // never written, never reported.
    var ctx = clientWithChoices([
      { sys_id: "ch1", value: "constructor", label: "C", sequence: "", language: "en", inactive: "false" },
      { sys_id: "ch2", value: "toString", label: "T", sequence: "", language: "en", inactive: "false" },
      { sys_id: "ch3", value: "__proto__", label: "P", sequence: "", language: "en", inactive: "false" }
    ]);

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["constructor", "toString", "__proto__"],
      updateSetSysId: "us1"
    });

    expect(result.choices.map(c => c.value)).toEqual([
      "constructor",
      "toString",
      "__proto__"
    ]);
    expect(result.choices.map(c => c.action)).toEqual([
      "deactivated",
      "deactivated",
      "deactivated"
    ]);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(3);
  });

  it("still works on a field holding exactly the page limit — no off-by-one refusal", async function () {
    // Guards the boundary: reading exactly the ceiling must not be mistaken for
    // "there may be more", or such a field could never be edited again.
    var ctx = clientWithChoices(manyChoices(1000));

    var result = await removeChoicesFromField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      values: ["v0"],
      updateSetSysId: "us1"
    });

    expect(result.choices[0].action).toBe("deactivated");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
  });
});
