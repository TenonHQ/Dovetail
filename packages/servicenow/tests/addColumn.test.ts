import { addColumn, deriveElement } from "../src/table";
import type { ServiceNowClient } from "../src/client";

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

/**
 * A stub client for the LIVE path. Resolves a table in scope "x_cadso_journey",
 * returns `existing` for the pre-check, echoes `createdSysId` from createRecord, and
 * returns element "url" on the sys_id read-back.
 */
function liveClient(opts: {
  existing?: boolean;
  scopeName?: string;
  /** The max_length the column materialises at when the insert carries none — i.e.
   *  ServiceNow's platform default (255 for a string on tenonworkshed). */
  defaultLength?: string;
  /** internal_type / max_length of the ALREADY-EXISTING column, for drift tests. */
  existingType?: string;
  existingLength?: string;
  /** Pin the max_length the instance reports back no matter what is written, to
   *  simulate a column whose physical size never took. */
  readBackLength?: string;
  /** Pin the internal_type the read-back reports, to simulate an instance that
   *  stored a different type than was inserted. Default: echo the inserted type. */
  readBackType?: string;
  /** Whether the column named by dependent_on_field exists on the table. Default true. */
  dependencyExists?: boolean;
  /** Simulate an insert that drops dependent_on_field: the read-back reports it only
   *  once a pushWithUpdateSet write carries it. */
  insertDropsDependent?: boolean;
  /** Pin what the read-back reports for dependent_on_field no matter what is written. */
  readBackDependent?: string;
  /** dependent_on_field of the ALREADY-EXISTING column, for drift tests. */
  existingDependent?: string;
}): ServiceNowClient {
  // Deliberately NOT the table name — the scope assertion below must fail if
  // addColumn ever passes the table name where the resolved scope name belongs.
  var scopeName =
    opts.scopeName === undefined ? "x_cadso_journey_app" : opts.scopeName;
  var defaultLength =
    opts.defaultLength === undefined ? "255" : opts.defaultLength;
  var calls: {
    createRecordScope: string;
    createRecordFields: Record<string, unknown>;
    maxLengthWrites: Array<string>;
    dependentWrites: Array<string>;
  } = {
    createRecordScope: "",
    createRecordFields: {},
    maxLengthWrites: [],
    dependentWrites: [],
  };
  var c = {
    _calls: calls,
    table: {
      query: async function (table: string, query: string) {
        if (table === "sys_db_object") {
          return [
            {
              sys_id: "TBL",
              name: "x_cadso_journey",
              sys_scope: { value: "SCOPESYS" },
            },
          ];
        }
        if (table === "sys_scope") {
          return scopeName ? [{ scope: scopeName }] : [];
        }
        if (table === "sys_dictionary") {
          if (query.indexOf("sys_id=") === 0) {
            // A healthy instance reports the platform default until a max_length write
            // lands, then reports whatever was written. A sick one keeps reporting the
            // default forever — that's `readBackLength`.
            var written = calls.maxLengthWrites.length
              ? calls.maxLengthWrites[calls.maxLengthWrites.length - 1]
              : defaultLength;
            var reported =
              opts.readBackLength === undefined ? written : opts.readBackLength;
            // A healthy instance stores the type it was given; readBackType simulates
            // one that stored something else.
            var insertedType = calls.createRecordFields.internal_type;
            var reportedType =
              opts.readBackType !== undefined
                ? opts.readBackType
                : typeof insertedType === "string" && insertedType
                ? insertedType
                : "url";
            // dependent_on_field: a healthy instance keeps what the insert carried, or
            // what was last written; a sick one reports `readBackDependent` forever.
            var insertedDependent = opts.insertDropsDependent
              ? ""
              : typeof calls.createRecordFields.dependent_on_field === "string"
              ? String(calls.createRecordFields.dependent_on_field)
              : "";
            var writtenDependent = calls.dependentWrites.length
              ? calls.dependentWrites[calls.dependentWrites.length - 1]
              : insertedDependent;
            var reportedDependent =
              opts.readBackDependent === undefined
                ? writtenDependent
                : opts.readBackDependent;
            return [
              {
                sys_id: "NEWSYS",
                element: "url",
                internal_type: reportedType,
                max_length: reported,
                dependent_on_field: reportedDependent,
              },
            ];
          }
          // The dependency pre-flight: any element other than the column under test.
          var elementMatch = /\^element=(.+)$/.exec(query);
          if (elementMatch && elementMatch[1] !== "url") {
            return opts.dependencyExists === false
              ? []
              : [{ sys_id: "DEPSYS", element: elementMatch[1] }];
          }
          return opts.existing
            ? [
                {
                  sys_id: "EXIST",
                  element: "url",
                  internal_type:
                    opts.existingType === undefined ? "url" : opts.existingType,
                  max_length:
                    opts.existingLength === undefined
                      ? ""
                      : opts.existingLength,
                  dependent_on_field:
                    opts.existingDependent === undefined
                      ? ""
                      : opts.existingDependent,
                },
              ]
            : [];
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
        scope?: string;
        fields?: Record<string, unknown>;
      }) {
        calls.createRecordScope = p.scope || "";
        calls.createRecordFields = p.fields || {};
        return { sys_id: "NEWSYS" };
      },
      pushWithUpdateSet: async function (p: {
        fields: Record<string, unknown>;
      }) {
        if (p && p.fields && p.fields.max_length !== undefined) {
          calls.maxLengthWrites.push(String(p.fields.max_length));
        }
        if (p && p.fields && p.fields.dependent_on_field !== undefined) {
          calls.dependentWrites.push(String(p.fields.dependent_on_field));
        }
        return { sys_id: "" };
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
    expect(function () {
      deriveElement("!!!");
    }).toThrow(/cannot derive a column name/);
  });
});

describe("addColumn dryRun", function () {
  it("returns a pure plan with the resolved type + element, no network", async function () {
    var result = await addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "URL", type: "url", max_length: 1024 },
      updateSetSysId: "us1",
      dryRun: true,
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
      dryRun: true,
    });
    expect(result.element).toBe("url");
  });
  it("accepts mandatory + default on the column spec", async function () {
    var result = await addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: {
        label: "Status",
        type: "string",
        mandatory: true,
        default: "pending",
      },
      dryRun: true,
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
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("created");
    expect(result.verified).toBe(true);
    expect(result.element).toBe("url");
    expect(result.columnSysId).toBe("NEWSYS");
    // createRecord must receive the scope NAME — not the sys_scope sys_id, and not
    // the table name (the stub's scope name differs from the table name on purpose).
    expect(
      (client as unknown as { _calls: { createRecordScope: string } })._calls
        .createRecordScope,
    ).toBe("x_cadso_journey_app");
  });
  it("skips (no insert) when the column already exists", async function () {
    var result = await addColumn({
      client: liveClient({ existing: true }),
      table: "x_cadso_journey",
      column: { label: "URL", type: "url" },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("skipped");
    expect(result.verified).toBe(true);
    expect(result.columnSysId).toBe("EXIST");
  });
  it("fails (not verified-with-a-note) when the read-back internal_type is not the requested type", async function () {
    // readBackType simulates an instance that stored a different type than was
    // inserted. Same rule as max_length: the column that exists is not the column
    // that was asked for.
    var result = await addColumn({
      client: liveClient({ existing: false, readBackType: "url" }),
      table: "x_cadso_journey",
      column: { label: "URL", type: "string" },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
    expect(result.columnSysId).toBe("NEWSYS"); // the column DOES exist on the instance
    expect(result.note).toMatch(
      /internal_type read back as 'url', not the requested 'string_full_utf8'/,
    );
  });
  it("rejects a --scope that does not match the table's scope", async function () {
    await expect(
      addColumn({
        client: liveClient({ scopeName: "x_cadso_journey" }),
        table: "x_cadso_journey",
        column: { label: "URL", type: "url" },
        scope: "x_cadso_other",
        updateSetSysId: "us1",
      }),
    ).rejects.toThrow(/does not match table/);
  });
});

/**
 * A max_length on the INSERT sets the dictionary row but NOT the column ServiceNow
 * builds — that materialises at the platform default regardless, so an insert declaring
 * string(4000) leaves a varchar(255) behind a row claiming 4000, and anything longer is
 * silently truncated. Only an UPDATE fires the physical ALTER. These tests pin that
 * contract: insert bare, then update to the requested size.
 */
type Calls = {
  createRecordFields: Record<string, unknown>;
  maxLengthWrites: Array<string>;
};
function callsOf(client: ServiceNowClient): Calls {
  return (client as unknown as { _calls: Calls })._calls;
}

describe("addColumn physical sizing", function () {
  it("never carries max_length on the insert — it would set the row and not the column", async function () {
    var client = liveClient({ existing: false });
    await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: { label: "URL", type: "string", max_length: 4000 },
      updateSetSysId: "us1",
    });
    expect(callsOf(client).createRecordFields.max_length).toBeUndefined();
  });

  it("sizes the column with a single update when the declared length differs from the default", async function () {
    var client = liveClient({ existing: false, defaultLength: "255" });
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: { label: "URL", type: "string", max_length: 4000 },
      updateSetSysId: "us1",
    });
    // One ALTER, not two: the row reports the default after the bare insert, so a single
    // write to 4000 is already a real transition.
    expect(callsOf(client).maxLengthWrites).toEqual(["4000"]);
    expect(result.status).toBe("created");
    expect(result.verified).toBe(true);
  });

  it("writes nothing when the declared length IS the default — row and column already agree", async function () {
    var client = liveClient({ existing: false, defaultLength: "255" });
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: { label: "URL", type: "string", max_length: 255 },
      updateSetSysId: "us1",
    });
    expect(callsOf(client).maxLengthWrites).toEqual([]);
    expect(result.status).toBe("created");
    expect(result.verified).toBe(true);
  });

  it("fails loudly when the size does not take, rather than reporting a lying column", async function () {
    // The instance keeps reporting the default however many times we write the size —
    // i.e. the ALTER never fired. That must fail, not pass.
    var client = liveClient({ existing: false, readBackLength: "255" });
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: { label: "URL", type: "string", max_length: 4000 },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
    expect(result.note).toMatch(/NOT the size it was declared/);
    expect(result.note).toMatch(/silently truncated/);
  });

  it("leaves a column that declares no max_length alone (no sizing writes)", async function () {
    var client = liveClient({ existing: false });
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: { label: "URL", type: "url" },
      updateSetSysId: "us1",
    });
    expect(callsOf(client).maxLengthWrites).toEqual([]);
    expect(result.status).toBe("created");
  });

  it("returns a structured failure (never throws) when the sizing step blows up", async function () {
    // The column already exists on the instance at this point, so a bare throw would
    // leave the caller with no idea what landed. The failure must carry the sys_id.
    var client = liveClient({ existing: false, defaultLength: "255" });
    (
      client as unknown as {
        claude: { pushWithUpdateSet: () => Promise<never> };
      }
    ).claude.pushWithUpdateSet = async function () {
      throw new Error("instance exploded");
    };
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: { label: "URL", type: "string", max_length: 4000 },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
    expect(result.columnSysId).toBe("NEWSYS");
    expect(result.note).toMatch(/was created, but sizing\/verifying it failed/);
    expect(result.note).toMatch(/instance exploded/);
  });
});

/**
 * "Already there" is not "already what you asked for". A skip that reports verified
 * without comparing the existing column to the request is the same trust-the-label
 * failure as a column that lies about its length.
 */
describe("addColumn skip-path drift", function () {
  it("verifies a skip when the existing column matches the request", async function () {
    var result = await addColumn({
      client: liveClient({ existing: true, existingType: "url" }),
      table: "x_cadso_journey",
      column: { label: "URL", type: "url" },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("skipped");
    expect(result.verified).toBe(true);
    expect(result.note).toMatch(/matches the requested spec/);
  });

  it("refuses to verify a skip when the existing column is a different TYPE", async function () {
    var result = await addColumn({
      client: liveClient({ existing: true, existingType: "integer" }),
      table: "x_cadso_journey",
      column: { label: "URL", type: "url" },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("skipped");
    expect(result.verified).toBe(false);
    expect(result.note).toMatch(/DOES NOT match what was requested/);
    expect(result.note).toMatch(/type is 'integer', not the requested 'url'/);
    // It reports the column that EXISTS, not the one that was asked for.
    expect(result.internalType).toBe("integer");
  });

  it("refuses to verify a skip when the existing column is a different SIZE", async function () {
    var result = await addColumn({
      client: liveClient({
        existing: true,
        existingType: "string_full_utf8",
        existingLength: "40",
      }),
      table: "x_cadso_journey",
      column: { label: "URL", type: "string", max_length: 4000 },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("skipped");
    expect(result.verified).toBe(false);
    expect(result.note).toMatch(/max_length is 40, not the requested 4000/);
  });

  it("refuses to verify a skip when a size was requested but the existing column reports NONE", async function () {
    // existingLength defaults to "" in the stub — a row that reports no max_length
    // cannot be shown to match a requested one, so it must not verify.
    var result = await addColumn({
      client: liveClient({ existing: true, existingType: "string_full_utf8" }),
      table: "x_cadso_journey",
      column: { label: "URL", type: "string", max_length: 4000 },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("skipped");
    expect(result.verified).toBe(false);
    expect(result.note).toMatch(
      /max_length is \(empty\), not the requested 4000/,
    );
  });

  it("writes nothing on a drifted skip — it never silently alters an existing column", async function () {
    var client = liveClient({ existing: true, existingType: "integer" });
    await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: { label: "URL", type: "url" },
      updateSetSysId: "us1",
    });
    expect(callsOf(client).maxLengthWrites).toEqual([]);
    expect(callsOf(client).createRecordFields).toEqual({});
  });
});

describe("addColumn dependent_on_field", function () {
  function callsOf(client: ServiceNowClient) {
    return (
      client as unknown as {
        _calls: {
          createRecordFields: Record<string, unknown>;
          dependentWrites: Array<string>;
        };
      }
    )._calls;
  }
  var documentId = {
    label: "Record",
    type: "document_id",
    name: "url", // the stub's read-back element; the name itself is irrelevant here
    dependent_on_field: "table",
  };

  it("names the dependency in the dry-run plan, touching no network", async function () {
    var result = await addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: documentId,
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    expect(result.note).toMatch(/dependent on column 'table'/);
    expect(result.note).toMatch(/must already exist/);
  });

  it("refuses a column that depends on itself, before any network call", async function () {
    await expect(
      addColumn({
        client: noNetworkClient(),
        table: "x_cadso_journey",
        column: { label: "Table", type: "table_name", name: "table", dependent_on_field: "table" },
        dryRun: true,
      }),
    ).rejects.toThrow(/cannot depend on itself/);
  });

  it("carries dependent_on_field on the insert and verifies it on the read-back", async function () {
    var client = liveClient({});
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: documentId,
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("created");
    expect(result.verified).toBe(true);
    expect(callsOf(client).createRecordFields.dependent_on_field).toBe("table");
    // The insert carried it and the read-back agreed — no patch write was needed.
    expect(callsOf(client).dependentWrites).toEqual([]);
    expect(result.note).toMatch(/dependent on 'table'/);
  });

  it("refuses, writing nothing, when the dependency column does not exist on the table", async function () {
    var client = liveClient({ dependencyExists: false });
    await expect(
      addColumn({
        client: client,
        table: "x_cadso_journey",
        column: documentId,
        updateSetSysId: "us1",
      }),
    ).rejects.toThrow(/dependent_on_field 'table' is not a column on 'x_cadso_journey'/);
    expect(callsOf(client).createRecordFields).toEqual({});
  });

  it("patches the dependency ONCE when the insert dropped it, then trusts the read-back", async function () {
    var client = liveClient({ insertDropsDependent: true });
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: documentId,
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("created");
    expect(result.verified).toBe(true);
    expect(callsOf(client).dependentWrites).toEqual(["table"]);
  });

  it("fails loudly when the dependency never takes, rather than reporting a column that resolves against nothing", async function () {
    var client = liveClient({ readBackDependent: "" });
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: documentId,
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
    expect(result.columnSysId).toBe("NEWSYS");
    expect(result.note).toMatch(/dependent_on_field read back as \(empty\)/);
  });

  it("refuses to verify a skip when the existing column has a different dependency", async function () {
    var client = liveClient({ existing: true, existingType: "document_id", existingDependent: "" });
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: documentId,
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("skipped");
    expect(result.verified).toBe(false);
    expect(result.note).toMatch(/dependent_on_field is \(empty\), not the requested 'table'/);
    expect(callsOf(client).dependentWrites).toEqual([]);
  });

  it("verifies a skip when the existing column already carries the dependency", async function () {
    var client = liveClient({ existing: true, existingType: "document_id", existingDependent: "table" });
    var result = await addColumn({
      client: client,
      table: "x_cadso_journey",
      column: documentId,
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("skipped");
    expect(result.verified).toBe(true);
  });
});

describe("addColumn error prefixes", function () {
  it("re-prefixes a shared-helper error as add-column, not createTable", async function () {
    await expect(
      addColumn({
        client: noNetworkClient(),
        table: "x_cadso_journey",
        column: { label: "X", type: "frobnicate" },
        dryRun: true,
      }),
    ).rejects.toThrow(/^add-column: /);
  });
});

describe("addColumn validation", function () {
  it("requires a table", async function () {
    await expect(
      addColumn({
        client: noNetworkClient(),
        table: "",
        column: { label: "URL", type: "url" },
        dryRun: true,
      }),
    ).rejects.toThrow(/table is required/);
  });
  it("rejects an unknown column type via normalizeColumns", async function () {
    await expect(
      addColumn({
        client: noNetworkClient(),
        table: "x_cadso_journey",
        column: { label: "X", type: "frobnicate" },
        dryRun: true,
      }),
    ).rejects.toThrow(/unknown column type/);
  });
  it("rejects a reference column with no target", async function () {
    await expect(
      addColumn({
        client: noNetworkClient(),
        table: "x_cadso_journey",
        column: { label: "Owner", type: "reference" },
        dryRun: true,
      }),
    ).rejects.toThrow(/reference target/);
  });
  it("requires an update set on the live path (before any network call)", async function () {
    await expect(
      addColumn({
        client: noNetworkClient(),
        table: "x_cadso_journey",
        column: { label: "URL", type: "url" },
      }),
    ).rejects.toThrow(/updateSetSysId is required/);
  });
});

/**
 * CROSS-SCOPE COLUMNS. A Journey column on an Automate table: the dictionary row is
 * owned by x_cadso_journey, the element is prefixed `x_cadso_journey_`, the insert is
 * switched to the column's scope, and the capture lands in a Journey update set.
 * Opt-in only (`crossScope: true`); the guards run on dry-run and live alike.
 */
type CrossCalls = {
  createRecordScope: string;
  createRecordFields: Record<string, unknown>;
  createRecordCount: number;
  dictionaryQueries: Array<string>;
  designAccessCreates: Array<Record<string, unknown>>;
  designAccessUpdateSet: string;
};
function crossCallsOf(client: ServiceNowClient): CrossCalls {
  return (client as unknown as { _calls: CrossCalls })._calls;
}

/**
 * Stub instance: table x_cadso_automate_email_batch (scope AUTOSYS / x_cadso_automate,
 * alter_access per opts), scope x_cadso_journey (JOURNEYSYS), update set "usj" in
 * Journey and "usa" in Automate (both in progress), "usc" a COMPLETE set in Journey. The read-back echoes the inserted element + sys_scope
 * unless pinned by opts.
 */
function crossScopeClient(opts: {
  alterAccess?: string;
  existingPrefixed?: boolean;
  readBackScope?: string;
  readBackElement?: string;
  knownScope?: boolean;
  /** Design Access JOURNEY -> AUTOMATE: present, missing (default), or the query throws. */
  designAccess?: "present" | "missing" | "error";
  /** Make the design-access insert throw. */
  designAccessInsertFails?: boolean;
}): ServiceNowClient {
  var designAccess = opts.designAccess === undefined ? "missing" : opts.designAccess;
  var alterAccess = opts.alterAccess === undefined ? "true" : opts.alterAccess;
  var knownScope = opts.knownScope === undefined ? true : opts.knownScope;
  var calls: CrossCalls = {
    createRecordScope: "",
    createRecordFields: {},
    createRecordCount: 0,
    dictionaryQueries: [],
    designAccessCreates: [],
    designAccessUpdateSet: "",
  };
  var c = {
    _calls: calls,
    table: {
      query: async function (table: string, query: string) {
        if (table === "sys_db_object") {
          return [
            {
              sys_id: "TBL",
              name: "x_cadso_automate_email_batch",
              sys_scope: { value: "AUTOSYS" },
              alter_access: alterAccess,
            },
          ];
        }
        if (table === "sys_scope") {
          if (query === "sys_id=AUTOSYS" || query === "scope=x_cadso_automate") {
            return [{ sys_id: "AUTOSYS", scope: "x_cadso_automate" }];
          }
          if (query === "scope=x_cadso_journey" || query === "sys_id=JOURNEYSYS") {
            return knownScope ? [{ sys_id: "JOURNEYSYS", scope: "x_cadso_journey" }] : [];
          }
          return [];
        }
        if (table === "sys_scope_design_access") {
          if (query === "sys_id=DASYS") {
            var made = calls.designAccessCreates[calls.designAccessCreates.length - 1] || {};
            return [
              {
                sys_id: "DASYS",
                source_scope: { value: made.source_scope },
                target_package: { value: made.target_package },
              },
            ];
          }
          if (designAccess === "error") throw new Error("403 on sys_scope_design_access");
          if (query === "source_scope=JOURNEYSYS^target_package=AUTOSYS") {
            if (designAccess === "present") return [{ sys_id: "DAEXIST" }];
            if (calls.designAccessCreates.length > 0) return [{ sys_id: "DASYS" }];
          }
          return [];
        }
        if (table === "sys_update_set") {
          if (query === "sys_id=usj") return [{ sys_id: "usj", name: "Journey set", application: { value: "JOURNEYSYS" }, state: "in progress" }];
          if (query === "sys_id=usa") return [{ sys_id: "usa", name: "Automate set", application: { value: "AUTOSYS" }, state: "in progress" }];
          if (query === "sys_id=usc") return [{ sys_id: "usc", name: "Closed Journey set", application: { value: "JOURNEYSYS" }, state: "complete" }];
          return [];
        }
        if (table === "sys_dictionary") {
          calls.dictionaryQueries.push(query);
          if (query.indexOf("sys_id=") === 0) {
            var insertedElement = calls.createRecordFields.element;
            var insertedScope = calls.createRecordFields.sys_scope;
            return [
              {
                sys_id: "NEWSYS",
                element:
                  opts.readBackElement !== undefined
                    ? opts.readBackElement
                    : typeof insertedElement === "string"
                    ? insertedElement
                    : "",
                internal_type: calls.createRecordFields.internal_type,
                max_length: "",
                sys_scope: {
                  value:
                    opts.readBackScope !== undefined
                      ? opts.readBackScope
                      : typeof insertedScope === "string"
                      ? insertedScope
                      : "",
                },
              },
            ];
          }
          // Pre-check by name+element: only the PREFIXED element "exists".
          if (opts.existingPrefixed && query.indexOf("element=x_cadso_journey_instance_step") > 0) {
            return [
              {
                sys_id: "EXIST",
                element: "x_cadso_journey_instance_step",
                internal_type: "reference",
                max_length: "",
              },
            ];
          }
          return [];
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
        table?: string;
        scope?: string;
        fields?: Record<string, unknown>;
        update_set_sys_id?: string;
      }) {
        if (p.table === "sys_scope_design_access") {
          if (opts.designAccessInsertFails) throw new Error("ACL denied");
          calls.designAccessCreates.push(p.fields || {});
          calls.designAccessUpdateSet = p.update_set_sys_id || "";
          return { sys_id: "DASYS" };
        }
        calls.createRecordCount += 1;
        calls.createRecordScope = p.scope || "";
        calls.createRecordFields = p.fields || {};
        return { sys_id: "NEWSYS" };
      },
      pushWithUpdateSet: async function () {
        return { sys_id: "" };
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

var CROSS_COLUMN = {
  label: "Instance Step",
  name: "instance_step",
  type: "reference",
  reference: "x_cadso_journey_instance_step",
};

describe("addColumn cross-scope", function () {
  it("inserts in the COLUMN's scope with a prefixed element and verifies sys_scope", async function () {
    var client = crossScopeClient({});
    var result = await addColumn({
      client: client,
      table: "x_cadso_automate_email_batch",
      column: CROSS_COLUMN,
      scope: "x_cadso_journey",
      crossScope: true,
      updateSetSysId: "usj",
    });
    expect(result.status).toBe("created");
    expect(result.verified).toBe(true);
    expect(result.element).toBe("x_cadso_journey_instance_step");
    expect(result.scope).toBe("x_cadso_journey");
    var calls = crossCallsOf(client);
    expect(calls.createRecordScope).toBe("x_cadso_journey");
    expect(calls.createRecordFields.sys_scope).toBe("JOURNEYSYS");
    expect(calls.createRecordFields.element).toBe("x_cadso_journey_instance_step");
    expect(calls.createRecordFields.name).toBe("x_cadso_automate_email_batch");
    expect(result.note).toMatch(/owned by scope 'x_cadso_journey'/);
  });
  it("accepts an already-prefixed name without double-prefixing", async function () {
    var client = crossScopeClient({});
    var result = await addColumn({
      client: client,
      table: "x_cadso_automate_email_batch",
      column: { label: "Instance Step", name: "x_cadso_journey_instance_step", type: "reference", reference: "x_cadso_journey_instance_step" },
      scope: "x_cadso_journey",
      crossScope: true,
      updateSetSysId: "usj",
    });
    expect(result.status).toBe("created");
    expect(crossCallsOf(client).createRecordFields.element).toBe("x_cadso_journey_instance_step");
  });
  it("reports the element ServiceNow actually stored when it differs", async function () {
    var client = crossScopeClient({ readBackElement: "x_cadso_journey_instance_step_1" });
    var result = await addColumn({
      client: client,
      table: "x_cadso_automate_email_batch",
      column: CROSS_COLUMN,
      scope: "x_cadso_journey",
      crossScope: true,
      updateSetSysId: "usj",
    });
    expect(result.status).toBe("created");
    expect(result.element).toBe("x_cadso_journey_instance_step_1");
    expect(result.note).toMatch(/stored element 'x_cadso_journey_instance_step_1'/);
  });
  it("skips (no insert) when the PREFIXED column already exists", async function () {
    var client = crossScopeClient({ existingPrefixed: true });
    var result = await addColumn({
      client: client,
      table: "x_cadso_automate_email_batch",
      column: CROSS_COLUMN,
      scope: "x_cadso_journey",
      crossScope: true,
      updateSetSysId: "usj",
    });
    expect(result.status).toBe("skipped");
    expect(result.verified).toBe(true);
    expect(result.element).toBe("x_cadso_journey_instance_step");
    expect(crossCallsOf(client).createRecordCount).toBe(0);
  });
  it("fails (column exists) when the read-back sys_scope is the TABLE's scope, not the column's", async function () {
    var client = crossScopeClient({ readBackScope: "AUTOSYS" });
    var result = await addColumn({
      client: client,
      table: "x_cadso_automate_email_batch",
      column: CROSS_COLUMN,
      scope: "x_cadso_journey",
      crossScope: true,
      updateSetSysId: "usj",
    });
    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
    expect(result.columnSysId).toBe("NEWSYS");
    expect(result.note).toMatch(/sys_scope read back as 'AUTOSYS', not the requested 'JOURNEYSYS'/);
  });
  it("still refuses a mismatched --scope WITHOUT the opt-in, and names the flag", async function () {
    await expect(
      addColumn({
        client: crossScopeClient({}),
        table: "x_cadso_automate_email_batch",
        column: CROSS_COLUMN,
        scope: "x_cadso_journey",
        updateSetSysId: "usj",
      }),
    ).rejects.toThrow(/does not match table .* pass --cross-scope/);
  });
  it("refuses crossScope without a scope to own the column", async function () {
    await expect(
      addColumn({
        client: crossScopeClient({}),
        table: "x_cadso_automate_email_batch",
        column: CROSS_COLUMN,
        crossScope: true,
        updateSetSysId: "usj",
      }),
    ).rejects.toThrow(/crossScope requires --scope/);
  });
  it("refuses an owner scope that does not exist", async function () {
    await expect(
      addColumn({
        client: crossScopeClient({ knownScope: false }),
        table: "x_cadso_automate_email_batch",
        column: CROSS_COLUMN,
        scope: "x_cadso_journey",
        crossScope: true,
        updateSetSysId: "usj",
      }),
    ).rejects.toThrow(/was not found in sys_scope/);
  });
  it("refuses when the table does not allow new fields from other scopes", async function () {
    await expect(
      addColumn({
        client: crossScopeClient({ alterAccess: "false" }),
        table: "x_cadso_automate_email_batch",
        column: CROSS_COLUMN,
        scope: "x_cadso_journey",
        crossScope: true,
        updateSetSysId: "usj",
      }),
    ).rejects.toThrow(/does not allow new fields from other scopes/);
  });
  it("refuses an update set that belongs to the table's scope, not the column's", async function () {
    await expect(
      addColumn({
        client: crossScopeClient({}),
        table: "x_cadso_automate_email_batch",
        column: CROSS_COLUMN,
        scope: "x_cadso_journey",
        crossScope: true,
        updateSetSysId: "usa",
      }),
    ).rejects.toThrow(/does not belong to the column's scope 'x_cadso_journey'/);
  });
  it("refuses a closed update set in the column's scope and writes nothing", async function () {
    var client = crossScopeClient({});
    await expect(
      addColumn({
        client: client,
        table: "x_cadso_automate_email_batch",
        column: CROSS_COLUMN,
        scope: "x_cadso_journey",
        crossScope: true,
        ensureDesignAccess: true,
        updateSetSysId: "usc",
      }),
    ).rejects.toThrow(/'Closed Journey set' is 'complete', not 'in progress'/);
    expect(crossCallsOf(client).createRecordCount).toBe(0);
    expect(crossCallsOf(client).designAccessCreates).toHaveLength(0);
  });
  it("a cross-scope dry-run with a closed update set is refused too", async function () {
    var client = crossScopeClient({});
    await expect(
      addColumn({
        client: client,
        table: "x_cadso_automate_email_batch",
        column: CROSS_COLUMN,
        scope: "x_cadso_journey",
        crossScope: true,
        updateSetSysId: "usc",
        dryRun: true,
      }),
    ).rejects.toThrow(/not 'in progress'/);
    expect(crossCallsOf(client).createRecordCount).toBe(0);
    expect(crossCallsOf(client).designAccessCreates).toHaveLength(0);
  });
  it("treats crossScope + the table's OWN scope as a plain same-scope add", async function () {
    var client = crossScopeClient({});
    var result = await addColumn({
      client: client,
      table: "x_cadso_automate_email_batch",
      column: { label: "Note", name: "note", type: "string" },
      scope: "x_cadso_automate",
      crossScope: true,
      updateSetSysId: "usa",
    });
    expect(result.status).toBe("created");
    expect(result.element).toBe("note");
    expect(result.scope).toBe("x_cadso_automate");
    expect(crossCallsOf(client).createRecordScope).toBe("x_cadso_automate");
  });
});

describe("addColumn dry-run runs the scope guards", function () {
  it("a plain dry-run (no scope named) still touches no network", async function () {
    var result = await addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "URL", type: "url" },
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    expect(result.scope).toBe("");
  });
  it("a mismatched --scope fails the DRY-RUN the same way it fails live", async function () {
    await expect(
      addColumn({
        client: crossScopeClient({}),
        table: "x_cadso_automate_email_batch",
        column: CROSS_COLUMN,
        scope: "x_cadso_journey",
        dryRun: true,
      }),
    ).rejects.toThrow(/does not match table/);
  });
  it("a cross-scope dry-run plans the prefixed element + owner scope and writes nothing", async function () {
    var client = crossScopeClient({});
    var result = await addColumn({
      client: client,
      table: "x_cadso_automate_email_batch",
      column: CROSS_COLUMN,
      scope: "x_cadso_journey",
      crossScope: true,
      updateSetSysId: "usj",
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    expect(result.element).toBe("x_cadso_journey_instance_step");
    expect(result.scope).toBe("x_cadso_journey");
    expect(result.table).toBe("x_cadso_automate_email_batch");
    expect(result.note).toMatch(/OWNED BY scope 'x_cadso_journey'/);
    expect(crossCallsOf(client).createRecordCount).toBe(0);
  });
  it("a cross-scope dry-run refuses a table that disallows new fields", async function () {
    await expect(
      addColumn({
        client: crossScopeClient({ alterAccess: "false" }),
        table: "x_cadso_automate_email_batch",
        column: CROSS_COLUMN,
        scope: "x_cadso_journey",
        crossScope: true,
        dryRun: true,
      }),
    ).rejects.toThrow(/does not allow new fields/);
  });
  it("a cross-scope dry-run with a wrong-scope update set is refused too", async function () {
    await expect(
      addColumn({
        client: crossScopeClient({}),
        table: "x_cadso_automate_email_batch",
        column: CROSS_COLUMN,
        scope: "x_cadso_journey",
        crossScope: true,
        updateSetSysId: "usa",
        dryRun: true,
      }),
    ).rejects.toThrow(/does not belong to the column's scope/);
  });
});

describe("addColumn cross-scope Design Access", function () {
  var base = {
    table: "x_cadso_automate_email_batch",
    column: CROSS_COLUMN,
    scope: "x_cadso_journey",
    crossScope: true,
    updateSetSysId: "usj",
  };
  it("FLAGS a missing record without blocking the column", async function () {
    var client = crossScopeClient({});
    var result = await addColumn(Object.assign({ client: client }, base));
    expect(result.status).toBe("created");
    expect(result.designAccess).toEqual({
      required: true,
      present: false,
      sysId: "",
      sourceScope: "x_cadso_journey",
      targetScope: "x_cadso_automate",
      created: false,
    });
    expect(result.note).toMatch(/DESIGN ACCESS REQUIRED: 'x_cadso_journey' -> 'x_cadso_automate' is MISSING/);
    expect(result.note).toMatch(/--ensure-design-access/);
    expect(crossCallsOf(client).designAccessCreates).toHaveLength(0);
  });
  it("reports a present record and writes nothing for it", async function () {
    var client = crossScopeClient({ designAccess: "present" });
    var result = await addColumn(Object.assign({ client: client, ensureDesignAccess: true }, base));
    expect(result.designAccess && result.designAccess.present).toBe(true);
    expect(result.designAccess && result.designAccess.sysId).toBe("DAEXIST");
    expect(result.note).toMatch(/Design Access .* is present/);
    expect(crossCallsOf(client).designAccessCreates).toHaveLength(0);
  });
  it("ensureDesignAccess creates the record FIRST, in the column's update set, then adds the column", async function () {
    var client = crossScopeClient({});
    var result = await addColumn(Object.assign({ client: client, ensureDesignAccess: true }, base));
    expect(result.status).toBe("created");
    var calls = crossCallsOf(client);
    expect(calls.designAccessCreates).toEqual([{ source_scope: "JOURNEYSYS", target_package: "AUTOSYS" }]);
    expect(calls.designAccessUpdateSet).toBe("usj");
    expect(calls.createRecordCount).toBe(1);
    expect(result.designAccess && result.designAccess.created).toBe(true);
    expect(result.designAccess && result.designAccess.sysId).toBe("DASYS");
    expect(result.note).toMatch(/Design Access .* was created/);
  });
  it("does NOT add the column when the record cannot be created", async function () {
    var client = crossScopeClient({ designAccessInsertFails: true });
    var result = await addColumn(Object.assign({ client: client, ensureDesignAccess: true }, base));
    expect(result.status).toBe("failed");
    expect(result.columnSysId).toBe("");
    expect(result.note).toMatch(/column was NOT added/);
    expect(crossCallsOf(client).createRecordCount).toBe(0);
  });
  it("ensureDesignAccess writes nothing when the column's dependency is missing", async function () {
    var client = crossScopeClient({});
    await expect(
      addColumn(
        Object.assign({}, base, {
          client: client,
          ensureDesignAccess: true,
          column: {
            label: "Doc",
            name: "doc",
            type: "document_id",
            dependent_on_field: "no_such_column",
          },
        }),
      ),
    ).rejects.toThrow(/dependent_on_field 'no_such_column' is not a column .* Nothing was written/);
    expect(crossCallsOf(client).designAccessCreates).toHaveLength(0);
    expect(crossCallsOf(client).createRecordCount).toBe(0);
  });
  it("reports an unreadable record as UNKNOWN (null), not missing", async function () {
    var client = crossScopeClient({ designAccess: "error" });
    var result = await addColumn(Object.assign({ client: client }, base));
    expect(result.status).toBe("created");
    expect(result.designAccess && result.designAccess.present).toBe(null);
    expect(result.note).toMatch(/could NOT be read/);
  });
  it("dry-run flags it, and says it would create it when asked, writing nothing", async function () {
    var client = crossScopeClient({});
    var result = await addColumn(
      Object.assign({ client: client, ensureDesignAccess: true, dryRun: true }, base),
    );
    expect(result.status).toBe("dry-run");
    expect(result.designAccess && result.designAccess.present).toBe(false);
    expect(result.note).toMatch(/would create it first/);
    expect(crossCallsOf(client).designAccessCreates).toHaveLength(0);
    expect(crossCallsOf(client).createRecordCount).toBe(0);
  });
  it("a same-scope add carries no designAccess flag", async function () {
    var client = crossScopeClient({});
    var result = await addColumn({
      client: client,
      table: "x_cadso_automate_email_batch",
      column: { label: "Note", name: "note", type: "string" },
      updateSetSysId: "usa",
    });
    expect(result.designAccess).toBeUndefined();
    expect(result.note).not.toMatch(/DESIGN ACCESS/);
  });
});
