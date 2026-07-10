import { addColumn, deriveElement } from "../src/table";
import type { ServiceNowClient } from "../src/client";

/** A client whose every call throws — proves dryRun + validation touch no network. */
function noNetworkClient(): ServiceNowClient {
  function boom(): never { throw new Error("network call not allowed"); }
  return {
    table: { query: async function () { return boom(); } },
    buildAgent: {
      runQuery: async function () { return boom(); },
      getTableSchema: async function () { return boom(); }
    },
    claude: {
      createRecord: async function () { return boom(); },
      pushWithUpdateSet: async function () { return boom(); },
      currentUpdateSet: async function () { return boom(); },
      changeUpdateSet: async function () { return boom(); },
      deleteRecord: async function () { return boom(); }
    },
    attachment: {
      listFor: async function () { return []; },
      upload: async function () { return { sys_id: "att", file_name: "", content_type: "" }; },
      remove: async function () { return undefined; }
    },
    now: { get: async function () { return boom(); }, post: async function () { return boom(); } }
  } as ServiceNowClient;
}

/**
 * A stub client for the LIVE path. Resolves a table in scope "x_cadso_journey",
 * returns `existing` for the pre-check, echoes `createdSysId` from createRecord, and
 * returns element "url" on the sys_id read-back.
 */
function liveClient(opts: { existing?: boolean; scopeName?: string }): ServiceNowClient {
  var scopeName = opts.scopeName === undefined ? "x_cadso_journey" : opts.scopeName;
  var calls: { createRecordScope: string } = { createRecordScope: "" };
  var c = {
    _calls: calls,
    table: {
      query: async function (table: string, query: string) {
        if (table === "sys_db_object") {
          return [{ sys_id: "TBL", name: "x_cadso_journey", sys_scope: { value: "SCOPESYS" } }];
        }
        if (table === "sys_scope") {
          return scopeName ? [{ scope: scopeName }] : [];
        }
        if (table === "sys_dictionary") {
          if (query.indexOf("sys_id=") === 0) {
            return [{ sys_id: "NEWSYS", element: "url", internal_type: "url" }];
          }
          return opts.existing ? [{ sys_id: "EXIST", internal_type: "url" }] : [];
        }
        return [];
      }
    },
    buildAgent: {
      runQuery: async function () { return []; },
      getTableSchema: async function () { throw new Error("nope"); }
    },
    claude: {
      createRecord: async function (p: { scope?: string }) {
        calls.createRecordScope = p.scope || "";
        return { sys_id: "NEWSYS" };
      },
      pushWithUpdateSet: async function () { return { sys_id: "" }; },
      currentUpdateSet: async function () { return { sys_id: "", name: "" }; },
      changeUpdateSet: async function () { return {}; },
      deleteRecord: async function () { return {}; }
    },
    attachment: {
      listFor: async function () { return []; },
      upload: async function () { return { sys_id: "att", file_name: "", content_type: "" }; },
      remove: async function () { return undefined; }
    },
    now: { get: async function () { throw new Error("nope"); }, post: async function () { throw new Error("nope"); } }
  };
  return c as unknown as ServiceNowClient;
}

describe("deriveElement", function () {
  it("derives a scoped element from a label (no u_ prefix)", function () {
    expect(deriveElement("URL")).toBe("url");
    expect(deriveElement("First Seen On")).toBe("first_seen_on");
    expect(deriveElement("A & B!")).toBe("a_b");
  });
  it("prefers an explicit name over the derived label", function () {
    expect(deriveElement("Some Label", "my_field")).toBe("my_field");
  });
  it("throws when nothing usable can be derived", function () {
    expect(function () { deriveElement("!!!"); }).toThrow(/cannot derive a column name/);
  });
});

describe("addColumn dryRun", function () {
  it("returns a pure plan with the resolved type + element, no network", async function () {
    var result = await addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "URL", type: "url", max_length: 1024 },
      updateSetSysId: "us1",
      dryRun: true
    });
    expect(result.status).toBe("dry-run");
    expect(result.element).toBe("url");
    expect(result.internalType).toBe("url");
    expect(result.tableSysId).toBe("");
    expect(result.columnSysId).toBe("");
    expect(result.verified).toBe(false);
    expect(result.updateSetSysId).toBe("us1");
  });
  it("honours an explicit column name on dry-run", async function () {
    var result = await addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "Recipient URL", type: "url", name: "url" },
      dryRun: true
    });
    expect(result.element).toBe("url");
  });
  it("accepts mandatory + default on the column spec", async function () {
    var result = await addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "Status", type: "string", mandatory: true, default: "pending" },
      dryRun: true
    });
    expect(result.status).toBe("dry-run");
    expect(result.element).toBe("status");
    expect(result.internalType).toBe("string_full_utf8");
  });
});

describe("addColumn live (stubbed)", function () {
  it("inserts via a scope-aware sys_dictionary write and verifies by sys_id", async function () {
    var client = liveClient({ existing: false });
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: { label: "URL", type: "url" },
      updateSetSysId: "us1"
    });
    expect(result.status).toBe("created");
    expect(result.verified).toBe(true);
    expect(result.element).toBe("url");
    expect(result.columnSysId).toBe("NEWSYS");
    // createRecord must receive the scope NAME, not the sys_scope sys_id.
    expect((client as unknown as { _calls: { createRecordScope: string } })._calls.createRecordScope).toBe("x_cadso_journey");
  });
  it("skips (no insert) when the column already exists", async function () {
    var result = await addColumn({
      client: liveClient({ existing: true }),
      table: "x_cadso_journey",
      column: { label: "URL", type: "url" },
      updateSetSysId: "us1"
    });
    expect(result.status).toBe("skipped");
    expect(result.verified).toBe(true);
    expect(result.columnSysId).toBe("EXIST");
  });
  it("rejects a --scope that does not match the table's scope", async function () {
    await expect(addColumn({
      client: liveClient({ scopeName: "x_cadso_journey" }),
      table: "x_cadso_journey",
      column: { label: "URL", type: "url" },
      scope: "x_cadso_other",
      updateSetSysId: "us1"
    })).rejects.toThrow(/does not match table/);
  });
});

describe("addColumn validation", function () {
  it("requires a table", async function () {
    await expect(addColumn({
      client: noNetworkClient(),
      table: "",
      column: { label: "URL", type: "url" },
      dryRun: true
    })).rejects.toThrow(/table is required/);
  });
  it("rejects an unknown column type via normalizeColumns", async function () {
    await expect(addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "X", type: "frobnicate" },
      dryRun: true
    })).rejects.toThrow(/unknown column type/);
  });
  it("rejects a reference column with no target", async function () {
    await expect(addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "Owner", type: "reference" },
      dryRun: true
    })).rejects.toThrow(/reference target/);
  });
  it("requires an update set on the live path (before any network call)", async function () {
    await expect(addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "URL", type: "url" }
    })).rejects.toThrow(/updateSetSysId is required/);
  });
});
