import {
  setColumn,
  effectiveValue,
  diffInherited,
  overrideUpdateName,
  labelUpdateName,
  OVERRIDABLE,
} from "../src/table";
import type { ServiceNowClient } from "../src/client";

/**
 * Tests for the INHERITED-column path.
 *
 * The behaviour under test was established against a live instance (tenonworkshed,
 * 2026-07-16) rather than assumed — the bug these cover was a confident claim about
 * ServiceNow that had never been checked. The facts the stub below encodes:
 *
 *   - a child narrows an inherited column via sys_dictionary_override (mandatory /
 *     read_only / default_value, each needing its `<attr>_override` flag) and
 *     sys_documentation (label), touching neither parent nor siblings;
 *   - base_table is the DEFINING table, not the immediate parent;
 *   - scope follows the CHILD;
 *   - the three record types have three DIFFERENT update-set capture names.
 */

interface StubOpts {
  /** An existing override row on the child, if any. */
  overrideRow?: Record<string, string> | null;
  /** An existing label row on the child, if any. */
  labelRow?: Record<string, string> | null;
  /** The defining table's dictionary row. */
  parentDict?: Record<string, string>;
  /** The child's scope sys_id, as sys_db_object.sys_scope. */
  childScope?: string;
  /** Update-set names that are considered captured. Absent = everything captures. */
  capturedNames?: Array<string>;
  /** Simulate ServiceNow taking the write and changing nothing. */
  ignoreWrites?: boolean;
  /** Write the value but leave the override flag off — an INERT override. */
  dropFlags?: boolean;
  updateSetState?: string;
}

interface Recorded {
  pushes: Array<Record<string, unknown>>;
  creates: Array<Record<string, unknown>>;
}

/** A child table x_child extending x_base through an intermediate x_mid. The column is
 *  defined on x_base — so base_table must resolve to x_base, NOT x_mid. */
function inheritedClient(opts: StubOpts) {
  var parentDict = opts.parentDict || {
    sys_id: "PCOL",
    element: "description",
    internal_type: "string",
    column_label: "Description",
    mandatory: "false",
    default_value: "",
    read_only: "false",
    max_length: "40",
  };
  var overrideRow = opts.overrideRow === undefined ? null : opts.overrideRow;
  var labelRow = opts.labelRow === undefined ? null : opts.labelRow;
  var rec: Recorded = { pushes: [], creates: [] };

  var c = {
    _rec: rec,
    table: {
      query: async function (table: string, query: string) {
        if (table === "sys_update_set") {
          return [
            {
              sys_id: "us1",
              name: "Test Set",
              state:
                opts.updateSetState === undefined
                  ? "in progress"
                  : opts.updateSetState,
            },
          ];
        }
        if (table === "sys_db_object") {
          if (query.indexOf("name=x_child") === 0) {
            return [
              {
                name: "x_child",
                super_class: "MIDSYS",
                sys_scope: opts.childScope || "CHILDSCOPE",
              },
            ];
          }
          if (query.indexOf("sys_id=MIDSYS") === 0) return [{ name: "x_mid" }];
          if (query.indexOf("name=x_mid") === 0) {
            return [{ name: "x_mid", super_class: "BASESYS" }];
          }
          if (query.indexOf("sys_id=BASESYS") === 0)
            return [{ name: "x_base" }];
          if (query.indexOf("name=x_base") === 0) {
            return [{ name: "x_base", super_class: "" }];
          }
          return [];
        }
        if (table === "sys_scope") {
          return [{ scope: "x_cadso_child", name: "Child App" }];
        }
        if (table === "sys_dictionary") {
          // Only x_base defines the column. x_child and x_mid have no row — which is
          // exactly why the old code declared this impossible.
          if (query.indexOf("name=x_base") === 0) return [parentDict];
          return [];
        }
        if (table === "sys_dictionary_override") {
          return overrideRow ? [overrideRow] : [];
        }
        if (table === "sys_documentation") {
          return labelRow ? [labelRow] : [];
        }
        if (table === "sys_update_xml") {
          if (!opts.capturedNames) return [{ sys_id: "UX1" }];
          // Match the queried name EXACTLY. A substring check would let a wrong name that
          // merely starts with the right one ("..._OVR1_WRONG") report as captured —
          // the stub would then hide the very mistake these tests exist to catch.
          var marker = "^name=";
          var at = query.indexOf(marker);
          var asked = at === -1 ? "" : query.slice(at + marker.length);
          var hit = opts.capturedNames.filter(function (n) {
            return n === asked;
          });
          return hit.length > 0 ? [{ sys_id: "UX1" }] : [];
        }
        return [];
      },
    },
    buildAgent: {
      runQuery: async function () {
        return [];
      },
      getTableSchema: async function () {
        throw new Error("nope");
      },
    },
    claude: {
      createRecord: async function (p: {
        table: string;
        fields: Record<string, string>;
        scope?: string;
        update_set_sys_id?: string;
      }) {
        rec.creates.push(p);
        if (opts.ignoreWrites) return { sys_id: "IGNORED" };
        var fields = Object.assign({}, p.fields);
        if (opts.dropFlags) {
          Object.keys(fields).forEach(function (k) {
            if (k.indexOf("_override") !== -1) fields[k] = "false";
          });
        }
        if (p.table === "sys_dictionary_override") {
          overrideRow = Object.assign({ sys_id: "OVR1" }, fields);
          return { sys_id: "OVR1" };
        }
        if (p.table === "sys_documentation") {
          labelRow = Object.assign({ sys_id: "DOC1" }, fields);
          return { sys_id: "DOC1" };
        }
        return { sys_id: "NEW" };
      },
      pushWithUpdateSet: async function (p: {
        table: string;
        record_sys_id: string;
        fields: Record<string, string>;
      }) {
        rec.pushes.push(p);
        if (opts.ignoreWrites) return { sys_id: p.record_sys_id };
        var target =
          p.table === "sys_dictionary_override" ? overrideRow : labelRow;
        if (target) {
          Object.keys(p.fields).forEach(function (k) {
            var v = p.fields[k];
            if (opts.dropFlags && k.indexOf("_override") !== -1) v = "false";
            (target as Record<string, string>)[k] = v;
          });
        }
        return { sys_id: p.record_sys_id };
      },
      currentUpdateSet: async function () {
        return { sys_id: "", name: "" };
      },
      changeUpdateSet: async function () {
        return {};
      },
      deleteRecord: async function () {
        return {};
      },
    },
    attachment: {
      listFor: async function () {
        return [];
      },
      upload: async function () {
        return { sys_id: "a", file_name: "", content_type: "" };
      },
      remove: async function () {
        return undefined;
      },
    },
    now: {
      get: async function () {
        throw new Error("nope");
      },
      post: async function () {
        throw new Error("nope");
      },
    },
  };
  return c as unknown as ServiceNowClient & { _rec: Recorded };
}

function recOf(client: ServiceNowClient): Recorded {
  return (client as unknown as { _rec: Recorded })._rec;
}

describe("update-set capture names", function () {
  // These three are NOT analogous, and assuming they were is the kind of mistake that
  // reports a perfectly-captured change as uncaptured. Both were read off real rows.
  it("keys an override capture by SYS_ID, not table_element", function () {
    expect(overrideUpdateName("abc123")).toBe("sys_dictionary_override_abc123");
  });

  it("keys a label capture by table_element_language", function () {
    expect(labelUpdateName("problem", "short_description")).toBe(
      "sys_documentation_problem_short_description_en",
    );
  });
});

describe("effectiveValue", function () {
  var parent = { mandatory: "false", column_label: "Description" };

  it("reads through to the parent when the child has no override", function () {
    expect(effectiveValue("mandatory", null, parent, null)).toBe("false");
  });

  it("uses the override only when its flag is ON", function () {
    var active = { mandatory: "true", mandatory_override: "true" };
    expect(effectiveValue("mandatory", active, parent, null)).toBe("true");
  });

  it("IGNORES an override whose flag is off — the row is inert and the child inherits", function () {
    // A value sitting in an unflagged override row is not what the column does. Trusting
    // it would report `unchanged` for a column that behaves the opposite way.
    var inert = { mandatory: "true", mandatory_override: "false" };
    expect(effectiveValue("mandatory", inert, parent, null)).toBe("false");
  });

  it("takes the label from the child's own documentation row when it has one", function () {
    expect(
      effectiveValue("column_label", null, parent, {
        label: "Problem statement",
      }),
    ).toBe("Problem statement");
  });

  it("falls back to the defining table's label when the child has no documentation row", function () {
    expect(effectiveValue("column_label", null, parent, null)).toBe(
      "Description",
    );
  });
});

describe("diffInherited", function () {
  var parent = { mandatory: "false", column_label: "Description" };

  it("reports only what differs from what the child sees today", function () {
    var changes = diffInherited(
      { mandatory: "true", column_label: "Description" },
      null,
      parent,
      null,
    );
    expect(changes).toEqual([
      { attribute: "mandatory", from: "false", to: "true" },
    ]);
  });

  it("treats a value the child already INHERITS as no change — pinning it would silently decouple the child", function () {
    expect(diffInherited({ mandatory: "false" }, null, parent, null)).toEqual(
      [],
    );
  });
});

describe("setColumn on an inherited column", function () {
  it("OVERRIDES the column for the child instead of refusing — the bug this fixes", async function () {
    // The old code threw here and told the caller to edit x_base, which would have
    // changed the column for every table extending it.
    var client = inheritedClient({});
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: true },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("applied");
    expect(result.via).toBe("override");
    expect(result.definedOn).toBe("x_base");
    expect(result.verified).toBe(true);
    expect(result.capturedInUpdateSet).toBe(true);
  });

  it("writes the override flag, without which the row is inert and the child keeps inheriting", async function () {
    var client = inheritedClient({});
    await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: true },
      updateSetSysId: "us1",
    });
    var created = recOf(client).creates[0];
    expect(created.table).toBe("sys_dictionary_override");
    expect(created.fields).toEqual({
      name: "x_child",
      element: "description",
      base_table: "x_base",
      mandatory: "true",
      mandatory_override: "true",
    });
  });

  it("sets base_table to the DEFINING table, not the immediate parent", async function () {
    // x_child extends x_mid extends x_base; the column is defined on x_base. Verified
    // live against cmdb_ci_endpoint_sharepoint_service, whose overrides carry
    // base_table=cmdb_ci while its immediate parent is cmdb_ci_endpoint_inclusion.
    var client = inheritedClient({});
    await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { readOnly: true },
      updateSetSysId: "us1",
    });
    expect(
      (recOf(client).creates[0].fields as Record<string, string>).base_table,
    ).toBe("x_base");
  });

  it("scopes the override to the CHILD — taking the parent's scope would land it in global", async function () {
    var client = inheritedClient({});
    await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: true },
      updateSetSysId: "us1",
    });
    expect(recOf(client).creates[0].scope).toBe("x_cadso_child");
    expect(recOf(client).creates[0].update_set_sys_id).toBe("us1");
  });

  it("routes a LABEL to sys_documentation, which is where a per-child label lives", async function () {
    var client = inheritedClient({});
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { label: "Problem statement" },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("applied");
    var created = recOf(client).creates[0];
    expect(created.table).toBe("sys_documentation");
    expect(created.fields).toEqual({
      name: "x_child",
      element: "description",
      label: "Problem statement",
      language: "en",
    });
  });

  it("UPDATES an existing override rather than inserting a second one", async function () {
    var client = inheritedClient({
      overrideRow: {
        sys_id: "OVR9",
        name: "x_child",
        element: "description",
        mandatory: "false",
        mandatory_override: "true",
      },
    });
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: true },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("applied");
    expect(recOf(client).creates).toHaveLength(0);
    expect(recOf(client).pushes[0].record_sys_id).toBe("OVR9");
  });

  it("splits a mixed request across BOTH record types in one call", async function () {
    var client = inheritedClient({});
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { label: "Notes", mandatory: true },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("applied");
    var tables = recOf(client).creates.map(function (c) {
      return c.table;
    });
    expect(tables).toContain("sys_dictionary_override");
    expect(tables).toContain("sys_documentation");
    expect(result.note).toMatch(/sys_dictionary_override \+ sys_documentation/);
  });

  // The probe on tenonworkshed caught this and the tests had not: a label-only change
  // reported the sys_id of a pre-existing override row it never wrote. The result
  // docstrings promise "" when the attribute did not change — a verb built on "do not
  // report what you did not do" must not violate that in its own reporting.
  it("reports an EMPTY overrideSysId on a label-only change, even when an override row already exists", async function () {
    var client = inheritedClient({
      overrideRow: {
        sys_id: "OVR9",
        name: "x_child",
        element: "description",
        mandatory: "false",
        mandatory_override: "true",
      },
    });
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { label: "Problem statement" },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("applied");
    // The pre-existing OVR9 was not touched, so it must not be reported as written.
    expect(result.overrideSysId).toBe("");
    expect(result.labelSysId).toBe("DOC1");
    // Prove the claim: nothing was written to sys_dictionary_override at all.
    var rec = recOf(client);
    var overrideWrites = rec.pushes.concat(rec.creates).filter(function (w) {
      return w.table === "sys_dictionary_override";
    });
    expect(overrideWrites).toHaveLength(0);
  });

  it("reports an EMPTY labelSysId on an override-only change, even when a label row already exists", async function () {
    var client = inheritedClient({
      labelRow: {
        sys_id: "DOC9",
        name: "x_child",
        element: "description",
        label: "Custom label",
        language: "en",
      },
    });
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: true },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("applied");
    expect(result.overrideSysId).toBe("OVR1");
    // The pre-existing DOC9 was not touched, so it must not be reported as written.
    expect(result.labelSysId).toBe("");
    var rec = recOf(client);
    var labelWrites = rec.pushes.concat(rec.creates).filter(function (w) {
      return w.table === "sys_documentation";
    });
    expect(labelWrites).toHaveLength(0);
  });

  it("writes NOTHING when the child already presents the requested value, and says it still tracks the parent", async function () {
    var client = inheritedClient({});
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: false }, // x_base already says false
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("unchanged");
    expect(recOf(client).creates).toHaveLength(0);
    expect(recOf(client).pushes).toHaveLength(0);
    expect(result.note).toMatch(/still TRACKS x_base/);
  });

  it("catches a write ServiceNow silently ignored, rather than trusting the 200", async function () {
    var client = inheritedClient({ ignoreWrites: true });
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: true },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
  });

  it("catches an INERT override — value written, flag off, child still inheriting", async function () {
    // The nastiest failure available here: everything returns 200, the row exists and
    // holds the right value, and the column does not behave as asked.
    var client = inheritedClient({ dropFlags: true });
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: true },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/INERT/);
    expect(result.note).toMatch(/still inherits from x_base/);
  });

  it("reports an uncaptured override — it is live here and can never be promoted", async function () {
    var client = inheritedClient({ capturedNames: [] });
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: true },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("applied");
    expect(result.verified).toBe(true);
    expect(result.capturedInUpdateSet).toBe(false);
    expect(result.note).toMatch(/NOT captured/);
  });

  it("looks for the override capture under its sys_id-keyed name", async function () {
    // Pin the real convention: if this ever regresses to sys_dictionary_override_<table>
    // _<element>, capture silently reports false for a change that WAS captured.
    var client = inheritedClient({
      capturedNames: ["sys_dictionary_override_OVR1"],
    });
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: true },
      updateSetSysId: "us1",
    });
    expect(result.capturedInUpdateSet).toBe(true);
  });

  it("refuses a CLOSED update set on the inherited path too", async function () {
    var client = inheritedClient({ updateSetState: "complete" });
    await expect(
      setColumn({
        client: client,
        table: "x_child",
        column: "description",
        attributes: { mandatory: true },
        updateSetSysId: "us1",
      }),
    ).rejects.toThrow(/not 'in progress'/);
    expect(recOf(client).creates).toHaveLength(0);
  });

  it("dry-runs without writing, naming the child as the only table affected", async function () {
    var client = inheritedClient({});
    var result = await setColumn({
      client: client,
      table: "x_child",
      column: "description",
      attributes: { mandatory: true },
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    expect(result.via).toBe("override");
    expect(result.changes).toEqual([
      { attribute: "mandatory", from: "false", to: "true" },
    ]);
    expect(result.note).toMatch(/x_child ALONE/);
    expect(recOf(client).creates).toHaveLength(0);
    expect(recOf(client).pushes).toHaveLength(0);
  });

  it("refuses max_length on the dry-run too, so a plan cannot promise what a run will not do", async function () {
    await expect(
      setColumn({
        client: inheritedClient({}),
        table: "x_child",
        column: "description",
        attributes: { maxLength: 200 },
        dryRun: true,
      }),
    ).rejects.toThrow(/max_length is PHYSICAL/);
  });

  it("refuses maxLength on an inherited LENGTHLESS column for the type reason, not the inheritance one", async function () {
    // Order matters. The type is a property of the column, so it is wrong wherever the
    // column lives — whereas the inherited refusal says "change it at the source", which
    // here would send the caller to the parent to attempt something impossible there too.
    await expect(
      setColumn({
        client: inheritedClient({
          parentDict: {
            sys_id: "PCOL",
            element: "description",
            internal_type: "reference",
            column_label: "Description",
            mandatory: "false",
            max_length: "32",
          },
        }),
        table: "x_child",
        column: "description",
        attributes: { maxLength: 200 },
        updateSetSysId: "us1",
      }),
    ).rejects.toThrow(/is a 'reference' column, which has no length/);
  });

  it("still refuses a rename on an inherited column", async function () {
    await expect(
      setColumn({
        client: inheritedClient({}),
        table: "x_child",
        column: "description",
        attributes: { element: "renamed" },
        updateSetSysId: "us1",
      }),
    ).rejects.toThrow(/cannot be renamed/);
  });

  it("exposes exactly the three attributes ServiceNow lets a child override", function () {
    // Not label (sys_documentation) and not max_length (physical on the ancestor).
    expect(Object.keys(OVERRIDABLE).sort()).toEqual([
      "default_value",
      "mandatory",
      "read_only",
    ]);
    expect(OVERRIDABLE.default_value.flag).toBe("default_value_override");
  });
});
