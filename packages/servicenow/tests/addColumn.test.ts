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
  } = {
    createRecordScope: "",
    createRecordFields: {},
    maxLengthWrites: [],
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
            return [
              {
                sys_id: "NEWSYS",
                element: "url",
                internal_type: reportedType,
                max_length: reported,
              },
            ];
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
