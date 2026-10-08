import { ensureDesignAccess, findDesignAccess } from "../src/table";
import type { ServiceNowClient } from "../src/client";

/**
 * Stub instance: scopes x_cadso_journey (JOURNEYSYS) and x_cadso_automate (AUTOSYS);
 * update set "usj" in Journey, "usa" in Automate (both in progress), "usc" a COMPLETE
 * set in Journey. Design Access JOURNEY -> AUTOMATE is
 * present or missing per opts; a created record reads back with the fields it was
 * inserted with (owned by the source scope) unless `readBackSource` / `readBackScope` pin
 * a different source_scope / sys_scope.
 */
type Calls = {
  creates: Array<{
    table: string;
    scope: string;
    updateSet: string;
    fields: Record<string, string>;
  }>;
  queries: Array<string>;
};
function stub(opts: {
  present?: boolean;
  insertThrows?: boolean;
  noSysId?: boolean;
  readBackSource?: string;
  /** Pin the read-back sys_scope (default: the inserted source_scope). */
  readBackScope?: string;
}): { client: ServiceNowClient; calls: Calls } {
  var calls: Calls = { creates: [], queries: [] };
  var client = {
    table: {
      query: async function (table: string, query: string) {
        calls.queries.push(table + "?" + query);
        if (table === "sys_scope") {
          if (query === "scope=x_cadso_journey")
            return [{ sys_id: "JOURNEYSYS", scope: "x_cadso_journey" }];
          if (query === "scope=x_cadso_automate")
            return [{ sys_id: "AUTOSYS", scope: "x_cadso_automate" }];
          return [];
        }
        if (table === "sys_update_set") {
          if (query === "sys_id=usj")
            return [
              {
                sys_id: "usj",
                name: "Journey set",
                application: { value: "JOURNEYSYS" },
                state: "in progress",
              },
            ];
          if (query === "sys_id=usc")
            return [
              {
                sys_id: "usc",
                name: "Closed Journey set",
                application: { value: "JOURNEYSYS" },
                state: "complete",
              },
            ];
          if (query === "sys_id=usa")
            return [
              {
                sys_id: "usa",
                name: "Automate set",
                application: { value: "AUTOSYS" },
                state: "in progress",
              },
            ];
          return [];
        }
        if (table === "sys_scope_design_access") {
          if (query === "sys_id=DASYS") {
            var made = calls.creates[calls.creates.length - 1];
            return [
              {
                sys_id: "DASYS",
                source_scope: {
                  value:
                    opts.readBackSource !== undefined
                      ? opts.readBackSource
                      : made.fields.source_scope,
                },
                target_package: { value: made.fields.target_package },
                sys_scope: {
                  value:
                    opts.readBackScope !== undefined
                      ? opts.readBackScope
                      : made.fields.source_scope,
                },
              },
            ];
          }
          if (
            opts.present &&
            query === "source_scope=JOURNEYSYS^target_package=AUTOSYS"
          ) {
            return [{ sys_id: "DAEXIST" }];
          }
          return [];
        }
        return [];
      },
    },
    claude: {
      createRecord: async function (p: {
        table: string;
        scope?: string;
        update_set_sys_id?: string;
        fields: Record<string, string>;
      }) {
        if (opts.insertThrows) throw new Error("ACL denied");
        calls.creates.push({
          table: p.table,
          scope: p.scope || "",
          updateSet: p.update_set_sys_id || "",
          fields: p.fields,
        });
        return { sys_id: opts.noSysId ? "" : "DASYS" };
      },
    },
  };
  return { client: client as unknown as ServiceNowClient, calls: calls };
}

var PAIR = { sourceScope: "x_cadso_journey", targetScope: "x_cadso_automate" };

describe("ensureDesignAccess", function () {
  it("reports an existing record and writes nothing", async function () {
    var s = stub({ present: true });
    var r = await ensureDesignAccess(
      Object.assign({ client: s.client, updateSetSysId: "usj" }, PAIR),
    );
    expect(r.status).toBe("exists");
    expect(r.present).toBe(true);
    expect(r.sysId).toBe("DAEXIST");
    expect(s.calls.creates).toHaveLength(0);
  });
  it("creates the record in the SOURCE scope + update set and verifies it", async function () {
    var s = stub({});
    var r = await ensureDesignAccess(
      Object.assign({ client: s.client, updateSetSysId: "usj" }, PAIR),
    );
    expect(r.status).toBe("created");
    expect(r.present).toBe(true);
    expect(r.sysId).toBe("DASYS");
    expect(s.calls.creates).toEqual([
      {
        table: "sys_scope_design_access",
        scope: "x_cadso_journey",
        updateSet: "usj",
        fields: { source_scope: "JOURNEYSYS", target_package: "AUTOSYS" },
      },
    ]);
  });
  it("dry-run reports MISSING and writes nothing", async function () {
    var s = stub({});
    var r = await ensureDesignAccess(
      Object.assign({ client: s.client, dryRun: true }, PAIR),
    );
    expect(r.status).toBe("dry-run");
    expect(r.present).toBe(false);
    expect(r.note).toMatch(/MISSING/);
    expect(s.calls.creates).toHaveLength(0);
  });
  it("refuses an update set from the TARGET scope", async function () {
    var s = stub({});
    await expect(
      ensureDesignAccess(
        Object.assign({ client: s.client, updateSetSysId: "usa" }, PAIR),
      ),
    ).rejects.toThrow(/does not belong to the source scope 'x_cadso_journey'/);
    expect(s.calls.creates).toHaveLength(0);
  });
  it("refuses a closed update set on the live path and writes nothing", async function () {
    var s = stub({});
    await expect(
      ensureDesignAccess(
        Object.assign({ client: s.client, updateSetSysId: "usc" }, PAIR),
      ),
    ).rejects.toThrow(/'Closed Journey set' is 'complete', not 'in progress'/);
    expect(s.calls.creates).toHaveLength(0);
  });
  it("refuses a closed update set on dry-run too", async function () {
    var s = stub({});
    await expect(
      ensureDesignAccess(
        Object.assign(
          { client: s.client, updateSetSysId: "usc", dryRun: true },
          PAIR,
        ),
      ),
    ).rejects.toThrow(/not 'in progress'/);
    expect(s.calls.creates).toHaveLength(0);
  });
  it("requires an update set on the live path", async function () {
    var s = stub({});
    await expect(
      ensureDesignAccess(Object.assign({ client: s.client }, PAIR)),
    ).rejects.toThrow(/updateSetSysId is required on the live path/);
  });
  it("refuses an unknown scope and the same scope twice", async function () {
    var s = stub({});
    await expect(
      ensureDesignAccess({
        client: s.client,
        sourceScope: "x_nope",
        targetScope: "x_cadso_automate",
        dryRun: true,
      }),
    ).rejects.toThrow(/source scope 'x_nope' was not found/);
    await expect(
      ensureDesignAccess({
        client: s.client,
        sourceScope: "x_cadso_journey",
        targetScope: "x_cadso_journey",
        dryRun: true,
      }),
    ).rejects.toThrow(/same scope/);
  });
  it("refuses a scope argument carrying query operators", async function () {
    var s = stub({});
    await expect(
      ensureDesignAccess({
        client: s.client,
        sourceScope: "x^ORsys_id!=",
        targetScope: "x_cadso_automate",
        dryRun: true,
      }),
    ).rejects.toThrow(/is not a scope name or sys_scope sys_id/);
  });
  it("returns failed (not a throw) when the insert fails", async function () {
    var s = stub({ insertThrows: true });
    var r = await ensureDesignAccess(
      Object.assign({ client: s.client, updateSetSysId: "usj" }, PAIR),
    );
    expect(r.status).toBe("failed");
    expect(r.present).toBe(false);
    expect(r.note).toMatch(/insert failed: ACL denied/);
  });
  it("returns failed when the insert returns no sys_id", async function () {
    var s = stub({ noSysId: true });
    var r = await ensureDesignAccess(
      Object.assign({ client: s.client, updateSetSysId: "usj" }, PAIR),
    );
    expect(r.status).toBe("failed");
    expect(r.note).toMatch(/returned no sys_id/);
  });
  it("returns failed when the read-back shows the wrong source", async function () {
    var s = stub({ readBackSource: "AUTOSYS" });
    var r = await ensureDesignAccess(
      Object.assign({ client: s.client, updateSetSysId: "usj" }, PAIR),
    );
    expect(r.status).toBe("failed");
    expect(r.sysId).toBe("DASYS");
    expect(r.note).toMatch(/read back as source_scope 'AUTOSYS'/);
  });
  it("returns failed (with the sys_id) when the record is owned by the wrong scope", async function () {
    var s = stub({ readBackScope: "AUTOSYS" });
    var r = await ensureDesignAccess(
      Object.assign({ client: s.client, updateSetSysId: "usj" }, PAIR),
    );
    expect(r.status).toBe("failed");
    expect(r.present).toBe(false);
    expect(r.sysId).toBe("DASYS");
    expect(r.note).toMatch(/owned by sys_scope 'AUTOSYS'/);
  });
});

describe("findDesignAccess", function () {
  it("never queries on an id that could carry an encoded-query operator", async function () {
    var s = stub({ present: true });
    var id = await findDesignAccess({
      client: s.client,
      sourceScopeSysId: "JOURNEYSYS^ORsys_idISNOTEMPTY",
      targetScopeSysId: "AUTOSYS",
    });
    expect(id).toBe("");
    expect(s.calls.queries).toHaveLength(0);
  });
});
