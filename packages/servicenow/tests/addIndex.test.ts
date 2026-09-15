/**
 * addIndex — RED-phase spec for the `dove-sn add-index` capability (Story 04 / US-002).
 *
 * The ONLY headless lever for an index is `sys_dictionary.unique = true` on the column:
 * the platform builds the physical index off that flag. `sys_index` is API-level-ACL 403
 * to EVERY identity (so it is never read), and `sys_index_column` does not exist. The
 * read-back surface is the `v_db_index` VIEW (`table_name`, `column_names` as a bracketed
 * string like "[occurrence_key]", `index_name`, `access_method`) — which proves an index
 * is PRESENT over the right column and can NEVER prove it is UNIQUE. Uniqueness therefore
 * always lands in `unverified`.
 *
 * The flag is NOT self-verifying: x_cadso_core_metric_point.idempotency_key reads
 * unique=true in the dictionary with no index on the table — a lying row. Read-back is
 * mandatory, and a lying row is a FAILURE, never a success with a soft note.
 *
 * Mocked-client pattern mirrors tests/addColumn.test.ts line for line:
 *   - `noNetworkClient()` (addColumn.test.ts:5-69) — every method throws, so any test using
 *     it proves the code path touched no network.
 *   - `liveClient(opts)` (addColumn.test.ts:76-225) — routes on table name, records writes
 *     into a `_calls` bag, and serves a distinct sys_dictionary read-back branch.
 *
 * CANONICAL STRINGS this suite pins (the implementation must emit these; they are the
 * spec, not a guess):
 *   - every thrown validation error is prefixed "add-index: "
 *   - composite request ......... "exactly one column"
 *   - unique:false .............. "only a unique index"
 *   - missing update set ........ "updateSetSysId is required"
 *   - missing table ............. "table is required"
 *   - non-string column ......... "must be a non-empty string"
 *   - duplicate preflight ....... "duplicate", the colliding value, the colliding ROW count
 *   - index not seen in v_db_index ... "not observed"
 *   - v_db_index unreadable .......... "403" and "v_db_index"
 *   - `unverified` ALWAYS contains "uniqueness-enforced", on EVERY status.
 *
 * `verified.indexPresent` is three-valued on purpose:
 *   true  — a v_db_index row over exactly these columns was read back
 *   false — v_db_index WAS read and holds no such row (the lying-row case)
 *   null  — v_db_index could not be read at all (403) or was never read (dry-run).
 * Collapsing null into false would report "the index is absent" when the truth is
 * "the instrument is blind" — the exact class of lie this verb exists to prevent.
 */

import { addIndex } from "../src/table/addIndex";
import type { AddIndexParams, AddIndexResult } from "../src/table/addIndex";
import * as tableBarrel from "../src/table";
import type { ServiceNowClient } from "../src/client";

var TABLE = "x_cadso_journey_instance";
var COLUMN = "occurrence_key";
// Deliberately NOT the table name — a scope assertion must fail if addIndex ever passes
// the table name where the resolved scope name belongs.
var SCOPE_NAME = "x_cadso_journey_app";
var DICT_SYS_ID = "DICT1";
var INDEX_NAME = "index_occurrence_key";

interface IndexRow {
  table_name: string;
  column_names: string;
  index_name: string;
  access_method: string;
}

/** The v_db_index row a healthy single-column unique index produces. */
function okIndexRow(): IndexRow {
  return {
    table_name: TABLE,
    column_names: "[" + COLUMN + "]",
    index_name: INDEX_NAME,
    access_method: "btree",
  };
}

/** A client whose every call throws — proves dryRun + validation touch no network. */
function noNetworkClient(): ServiceNowClient {
  function boom(): never {
    throw new Error("network call not allowed");
  }
  return {
    table: {
      query: async function () {
        return boom();
      },
    },
    buildAgent: {
      runQuery: async function () {
        return boom();
      },
      getTableSchema: async function () {
        return boom();
      },
    },
    claude: {
      createRecord: async function () {
        return boom();
      },
      pushWithUpdateSet: async function () {
        return boom();
      },
      currentUpdateSet: async function () {
        return boom();
      },
      changeUpdateSet: async function () {
        return boom();
      },
      deleteRecord: async function () {
        return boom();
      },
    },
    attachment: {
      listFor: async function () {
        return [];
      },
      upload: async function () {
        return { sys_id: "att", file_name: "", content_type: "" };
      },
      remove: async function () {
        return undefined;
      },
    },
    now: {
      get: async function () {
        return boom();
      },
      post: async function () {
        return boom();
      },
      put: async function () {
        return boom();
      },
      delete: async function () {
        return boom();
      },
      invoke: async function () {
        return boom();
      },
    },
  } as ServiceNowClient;
}

interface PushCall {
  update_set_sys_id: string;
  table: string;
  record_sys_id: string;
  fields: Record<string, unknown>;
}

interface IndexCalls {
  queries: Array<{ table: string; query: string }>;
  pushes: Array<PushCall>;
  createRecords: Array<Record<string, unknown>>;
}

interface LiveOpts {
  /** Scope NAME the sys_scope lookup returns. "" simulates an unresolvable scope. */
  scopeName?: string;
  /** sys_dictionary.unique BEFORE any write. "true" = the flag is already set. */
  dictionaryUnique?: string;
  /** Pin what the read-back reports no matter what was written (the lying row). */
  readBackUnique?: string;
  /** Rows v_db_index returns for the table. Default: one btree index over [occurrence_key]. */
  indexRows?: Array<IndexRow>;
  /** Make the v_db_index read throw — the 403 case. */
  indexReadError?: string;
  /** internal_type of the column's sys_dictionary row. Default "string". */
  columnType?: string;
  /** Omit the column from sys_dictionary entirely. */
  columnMissing?: boolean;
  /** Values the column holds on the target table, for the duplicate preflight. */
  dataValues?: Array<string>;
}

/**
 * Stub client for the LIVE path. Resolves TABLE in scope SCOPE_NAME, serves the column's
 * sys_dictionary row (the same row for the name^element lookup and the sys_id read-back),
 * serves v_db_index, and pages the target table ONCE for the duplicate preflight —
 * a second read of the same table returns [] so a paging loop terminates.
 */
function liveClient(opts: LiveOpts): ServiceNowClient {
  var scopeName = opts.scopeName === undefined ? SCOPE_NAME : opts.scopeName;
  var columnType = opts.columnType === undefined ? "string" : opts.columnType;
  var dictionaryUnique =
    opts.dictionaryUnique === undefined ? "false" : opts.dictionaryUnique;
  var indexRows = opts.indexRows === undefined ? [okIndexRow()] : opts.indexRows;
  var dataValues = opts.dataValues === undefined ? [] : opts.dataValues;
  var dataServed = false;
  var calls: IndexCalls = { queries: [], pushes: [], createRecords: [] };

  function currentUnique(): string {
    if (opts.readBackUnique !== undefined) return opts.readBackUnique;
    var written = "";
    calls.pushes.forEach(function (p) {
      if (p.fields && p.fields.unique !== undefined) {
        written = String(p.fields.unique);
      }
    });
    return written ? written : dictionaryUnique;
  }

  async function route(
    table: string,
    query: string,
  ): Promise<Array<Record<string, unknown>>> {
    calls.queries.push({ table: table, query: query });
    if (table === "sys_index" || table === "sys_index_column") {
      // sys_index is API-level-ACL 403 to every identity and sys_index_column does not
      // exist (HTTP 400 "Invalid table"). Reading either is a design error, not a runtime
      // one — fail the test loudly rather than let the verb depend on a blind table.
      throw new Error(
        "addIndex must never read " + table + " — 403/nonexistent on the instance",
      );
    }
    if (table === "sys_db_object") {
      return [{ sys_id: "TBL", name: TABLE, sys_scope: { value: "SCOPESYS" } }];
    }
    if (table === "sys_scope") {
      return scopeName ? [{ scope: scopeName }] : [];
    }
    if (table === "sys_dictionary") {
      if (opts.columnMissing) return [];
      return [
        {
          sys_id: DICT_SYS_ID,
          name: TABLE,
          element: COLUMN,
          internal_type: columnType,
          unique: currentUnique(),
        },
      ];
    }
    if (table === "v_db_index") {
      if (opts.indexReadError) throw new Error(opts.indexReadError);
      return indexRows as unknown as Array<Record<string, unknown>>;
    }
    if (table === TABLE) {
      if (dataServed) return [];
      dataServed = true;
      return dataValues.map(function (v, i) {
        var row: Record<string, unknown> = { sys_id: "ROW" + i };
        row[COLUMN] = v;
        return row;
      });
    }
    return [];
  }

  var c = {
    _calls: calls,
    table: {
      query: async function (table: string, query: string) {
        return route(table, query);
      },
    },
    buildAgent: {
      // Routed through the same store so a preflight written against buildAgent.runQuery
      // is served (and recorded) identically to one written against table.query.
      runQuery: async function (p: { table: string; query: string }) {
        return route(p.table, p.query);
      },
      getTableSchema: async function () {
        throw new Error("nope");
      },
    },
    claude: {
      createRecord: async function (p: Record<string, unknown>) {
        calls.createRecords.push(p);
        return { sys_id: "NEWSYS" };
      },
      pushWithUpdateSet: async function (p: PushCall) {
        calls.pushes.push(p);
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
        return { sys_id: "att", file_name: "", content_type: "" };
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
  return c as unknown as ServiceNowClient;
}

function callsOf(client: ServiceNowClient): IndexCalls {
  return (client as unknown as { _calls: IndexCalls })._calls;
}

/** Did anything read `table` at all (via table.query OR buildAgent.runQuery)? */
function queriedTable(client: ServiceNowClient, table: string): boolean {
  return callsOf(client).queries.some(function (q) {
    return q.table === table;
  });
}

function liveParams(client: ServiceNowClient): AddIndexParams {
  return {
    client: client,
    table: TABLE,
    columns: [COLUMN],
    unique: true,
    updateSetSysId: "us1",
  };
}

// ---------------------------------------------------------------------------
// AC 2 + AC 3 — the verb takes a column LIST but REFUSES what the dictionary
// lever cannot deliver, and refuses a live run with no update set, before any
// network call.
// ---------------------------------------------------------------------------
describe("addIndex validation (nothing may touch the network)", function () {
  it("refuses a composite column list rather than silently narrowing it", async function () {
    // sys_dictionary.unique is per-COLUMN; there is no dictionary lever for a multi-column
    // index. Taking the first column and building a different index than was asked for is
    // the worst available outcome.
    await expect(
      addIndex({
        client: noNetworkClient(),
        table: TABLE,
        columns: [COLUMN, "journey"],
        unique: true,
        updateSetSysId: "us1",
      }),
    ).rejects.toThrow(/^add-index: /);
    await expect(
      addIndex({
        client: noNetworkClient(),
        table: TABLE,
        columns: [COLUMN, "journey"],
        unique: true,
        updateSetSysId: "us1",
      }),
    ).rejects.toThrow(/exactly one column/i);
  });

  it("refuses unique:false — there is no dictionary lever for a plain index", async function () {
    // unique:false is outside the declared literal type on purpose: the CLI and MCP
    // boundaries hand over unvalidated JSON, so the refusal must be a RUNTIME guard.
    var params = {
      client: noNetworkClient(),
      table: TABLE,
      columns: [COLUMN],
      unique: false,
      updateSetSysId: "us1",
    } as unknown as AddIndexParams;
    await expect(addIndex(params)).rejects.toThrow(/^add-index: /);
    await expect(addIndex(params)).rejects.toThrow(/only a unique index/i);
  });

  it("requires an update set on the live path BEFORE any network call", async function () {
    // noNetworkClient throws "network call not allowed"; matching the update-set message
    // instead is what proves the gate fires first.
    await expect(
      addIndex({
        client: noNetworkClient(),
        table: TABLE,
        columns: [COLUMN],
        unique: true,
      }),
    ).rejects.toThrow(/updateSetSysId is required/);
  });

  it("requires a table", async function () {
    await expect(
      addIndex({
        client: noNetworkClient(),
        table: "",
        columns: [COLUMN],
        unique: true,
        updateSetSysId: "us1",
        dryRun: true,
      }),
    ).rejects.toThrow(/table is required/);
  });

  it("refuses an empty column list", async function () {
    await expect(
      addIndex({
        client: noNetworkClient(),
        table: TABLE,
        columns: [],
        unique: true,
        updateSetSysId: "us1",
        dryRun: true,
      }),
    ).rejects.toThrow(/exactly one column/i);
  });

  it("refuses a non-string column name", async function () {
    var params = {
      client: noNetworkClient(),
      table: TABLE,
      columns: [123],
      unique: true,
      updateSetSysId: "us1",
      dryRun: true,
    } as unknown as AddIndexParams;
    await expect(addIndex(params)).rejects.toThrow(/must be a non-empty string/i);
  });
});

// ---------------------------------------------------------------------------
// AC 3 — two-phase: the dry-run prints the plan and writes nothing.
// ---------------------------------------------------------------------------
describe("addIndex dryRun", function () {
  it("returns a pure plan with no network call at all", async function () {
    var result: AddIndexResult = await addIndex({
      client: noNetworkClient(),
      table: TABLE,
      columns: [COLUMN],
      unique: true,
      updateSetSysId: "us1",
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    expect(result.table).toBe(TABLE);
    expect(result.columns).toEqual([COLUMN]);
    expect(result.updateSetSysId).toBe("us1");
    expect(result.indexName).toBe("");
    expect(result.verified.dictionaryUnique).toBe(false);
    // NOT false: nothing was read, so "absent" would be a claim the run never made.
    expect(result.verified.indexPresent).toBeNull();
    expect(result.verified.indexColumns).toBe("");
    expect(result.unverified).toContain("uniqueness-enforced");
  });

  it("plans without an update set (only the live path needs one)", async function () {
    var result: AddIndexResult = await addIndex({
      client: noNetworkClient(),
      table: TABLE,
      columns: [COLUMN],
      unique: true,
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    expect(result.updateSetSysId).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The duplicate preflight — the x_cadso_core_metric_point.idempotency_key trap.
// A unique index cannot build over colliding values; the platform leaves the
// dictionary row claiming unique=true and no index behind. Abort BEFORE writing.
// ---------------------------------------------------------------------------
describe("addIndex duplicate preflight", function () {
  it("aborts, names the colliding value and the colliding row count, and writes nothing", async function () {
    // Two rows share "dup-key", one row is clean -> 2 colliding ROWS over 1 value.
    var client = liveClient({ dataValues: ["dup-key", "dup-key", "clean-1"] });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/duplicate/i);
    expect(result.note).toContain("dup-key");
    expect(result.note).toMatch(/\b2\b/);
    // Nothing was written: no dictionary patch, no record insert.
    expect(callsOf(client).pushes).toEqual([]);
    expect(callsOf(client).createRecords).toEqual([]);
    expect(result.verified.dictionaryUnique).toBe(false);
    expect(result.unverified).toContain("uniqueness-enforced");
  });

  it("counts EMPTY values as collisions — the 498-rows-with-a-new-empty-column trap", async function () {
    var client = liveClient({ dataValues: ["", "", "x"] });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/duplicate/i);
    expect(result.note).toMatch(/empty/i);
    expect(result.note).toMatch(/\b2\b/);
    expect(callsOf(client).pushes).toEqual([]);
  });

  it("actually reads the target table before deciding", async function () {
    var client = liveClient({ dataValues: ["k1", "k2", "k3"] });
    await addIndex(liveParams(client));
    expect(queriedTable(client, TABLE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC 2 + AC 4 — the live path writes exactly one dictionary patch, reads back
// through v_db_index, and never claims what it could not read.
// ---------------------------------------------------------------------------
describe("addIndex live (stubbed)", function () {
  it("patches sys_dictionary.unique through the scope-aware update-set path, exactly once", async function () {
    var client = liveClient({ dataValues: ["k1", "k2", "k3"] });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("created");
    // The exact request shape: the dictionary ROW (by sys_id), captured in the update set.
    expect(callsOf(client).pushes).toEqual([
      {
        update_set_sys_id: "us1",
        table: "sys_dictionary",
        record_sys_id: DICT_SYS_ID,
        fields: { unique: "true" },
      },
    ]);
    // An index is a column-flag transition, never a new record.
    expect(callsOf(client).createRecords).toEqual([]);
  });

  it("verifies through v_db_index and reports uniqueness as UNVERIFIED", async function () {
    var client = liveClient({ dataValues: ["k1", "k2", "k3"] });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("created");
    expect(result.table).toBe(TABLE);
    expect(result.columns).toEqual([COLUMN]);
    expect(result.indexName).toBe(INDEX_NAME);
    expect(result.verified.dictionaryUnique).toBe(true);
    expect(result.verified.indexPresent).toBe(true);
    // Verbatim from the row — v_db_index stores the column list bracketed.
    expect(result.verified.indexColumns).toBe("[" + COLUMN + "]");
    // v_db_index has NO uniqueness field; every row reads access_method btree whether
    // unique or not. Enforcement is provable only by a duplicate-insert test.
    expect(result.unverified).toContain("uniqueness-enforced");
    expect(result.updateSetSysId).toBe("us1");
  });

  it("reads v_db_index filtered to the table, and NEVER reads sys_index", async function () {
    var client = liveClient({ dataValues: ["k1", "k2"] });
    await addIndex(liveParams(client));
    var viewReads = callsOf(client).queries.filter(function (q) {
      return q.table === "v_db_index";
    });
    expect(viewReads.length).toBeGreaterThan(0);
    expect(
      viewReads.some(function (q) {
        return q.query.indexOf("table_name=" + TABLE) >= 0;
      }),
    ).toBe(true);
    expect(queriedTable(client, "sys_index")).toBe(false);
  });

  it("re-reads the dictionary row by sys_id after the patch", async function () {
    var client = liveClient({ dataValues: ["k1"] });
    await addIndex(liveParams(client));
    var dictReads = callsOf(client).queries.filter(function (q) {
      return q.table === "sys_dictionary";
    });
    expect(
      dictReads.some(function (q) {
        return q.query.indexOf("sys_id=" + DICT_SYS_ID) >= 0;
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC 4 — "must never report success it cannot read back". These are the tests
// the whole story exists for.
// ---------------------------------------------------------------------------
describe("addIndex honest failure", function () {
  it("FAILS when the dictionary patch lands but no index appears in v_db_index", async function () {
    // The lying row: x_cadso_core_metric_point.idempotency_key reads unique=true with no
    // index on the table. status must NOT be a green "created" — a CLI exits 0 on created,
    // so a green here is an automated false success, which is exactly AC 4's prohibition.
    var client = liveClient({ dataValues: ["k1", "k2"], indexRows: [] });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("failed");
    expect(result.verified.dictionaryUnique).toBe(true);
    expect(result.verified.indexPresent).toBe(false);
    expect(result.verified.indexColumns).toBe("");
    expect(result.indexName).toBe("");
    expect(result.note).toMatch(/not observed/i);
    expect(result.unverified).toContain("uniqueness-enforced");
  });

  it("reports indexPresent UNKNOWN (null), not false, when v_db_index cannot be read", async function () {
    // A 403 on the read-back instrument is not evidence of absence. Collapsing it to
    // false would report "no index" when the truth is "I am blind".
    var client = liveClient({
      dataValues: ["k1", "k2"],
      indexReadError: "Request failed with status code 403: User Not Authorized",
    });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("failed");
    expect(result.verified.indexPresent).toBeNull();
    expect(result.note).toContain("403");
    expect(result.note).toContain("v_db_index");
    expect(result.unverified).toContain("uniqueness-enforced");
  });

  it("does not count an index over a DIFFERENT column as the one that was asked for", async function () {
    // x_cadso_journey_instance already carries btree indexes on journey, parent_instance,
    // trigger_parent, trigger_document_id, sys_domain. Presence of "an index on the table"
    // is not presence of THIS index.
    var client = liveClient({
      dataValues: ["k1", "k2"],
      indexRows: [
        {
          table_name: TABLE,
          column_names: "[journey]",
          index_name: "index_journey",
          access_method: "btree",
        },
      ],
    });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("failed");
    expect(result.verified.indexPresent).toBe(false);
    expect(result.note).toMatch(/not observed/i);
  });

  it("parses column_names rather than substring-matching it", async function () {
    // "[occurrence_key_extra]" CONTAINS "occurrence_key". An indexOf-based match would
    // green-light an index over the wrong column.
    var client = liveClient({
      dataValues: ["k1", "k2"],
      indexRows: [
        {
          table_name: TABLE,
          column_names: "[" + COLUMN + "_extra]",
          index_name: "index_occurrence_key_extra",
          access_method: "btree",
        },
      ],
    });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.verified.indexPresent).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("refuses to treat a pre-existing unique=true flag with no index as done", async function () {
    // The flag is already set, so writing "true" over "true" fires no ALTER — there is
    // nothing this verb can do to fix it. It must say so, not skip green and not write.
    var client = liveClient({
      dataValues: ["k1", "k2"],
      dictionaryUnique: "true",
      indexRows: [],
    });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("failed");
    expect(result.verified.dictionaryUnique).toBe(true);
    expect(result.verified.indexPresent).toBe(false);
    expect(result.note).toMatch(/not observed/i);
    expect(callsOf(client).pushes).toEqual([]);
  });

  it("returns a structured failure (never throws) when the dictionary write blows up", async function () {
    var client = liveClient({ dataValues: ["k1", "k2"] });
    (
      client as unknown as {
        claude: { pushWithUpdateSet: () => Promise<never> };
      }
    ).claude.pushWithUpdateSet = async function () {
      throw new Error("instance exploded");
    };
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("failed");
    expect(result.note).toContain("instance exploded");
    expect(result.verified.dictionaryUnique).toBe(false);
    expect(result.unverified).toContain("uniqueness-enforced");
  });

  it("fails when the column does not exist on the table, without writing", async function () {
    var client = liveClient({ dataValues: [], columnMissing: true });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("failed");
    expect(result.note).toContain(COLUMN);
    expect(callsOf(client).pushes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Idempotency + scope, mirroring addColumn's skip path and scope guard.
// ---------------------------------------------------------------------------
describe("addIndex idempotency and scope", function () {
  it("skips (no second write) when the flag is set AND the index is really there", async function () {
    var client = liveClient({
      dataValues: ["k1", "k2"],
      dictionaryUnique: "true",
      indexRows: [okIndexRow()],
    });
    var result: AddIndexResult = await addIndex(liveParams(client));
    expect(result.status).toBe("skipped");
    expect(result.verified.dictionaryUnique).toBe(true);
    expect(result.verified.indexPresent).toBe(true);
    expect(result.indexName).toBe(INDEX_NAME);
    expect(callsOf(client).pushes).toEqual([]);
    // Uniqueness is unverifiable on EVERY status, success and skip included.
    expect(result.unverified).toContain("uniqueness-enforced");
  });

  it("rejects a --scope that does not match the table's own scope", async function () {
    await expect(
      addIndex({
        client: liveClient({ dataValues: ["k1"] }),
        table: TABLE,
        columns: [COLUMN],
        unique: true,
        scope: "x_cadso_other",
        updateSetSysId: "us1",
      }),
    ).rejects.toThrow(/does not match table/);
  });
});

// ---------------------------------------------------------------------------
// The CLI (cli.ts) and the MCP registry both import the table verbs from the
// ../src/table barrel — addColumn is exported there at table/index.ts:53.
// ---------------------------------------------------------------------------
describe("table barrel", function () {
  it("re-exports addIndex so cli.ts and the MCP registry can import it", function () {
    var barrel = tableBarrel as unknown as Record<string, unknown>;
    expect(typeof barrel.addIndex).toBe("function");
  });
});
