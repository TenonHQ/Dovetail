import { setColumn, resolveAttributes, toStoredValue } from "../src/table";
import type { ServiceNowClient } from "../src/client";

/**
 * A stub instance. `dict` is the sys_dictionary row as stored; a pushWithUpdateSet
 * write mutates it, the way a healthy instance would. `ignoreWrites` simulates the
 * ServiceNow behaviour that makes this verb necessary: HTTP 200, nothing changes.
 */
function liveClient(opts: {
  dict?: Record<string, string> | null;
  captured?: boolean;
  ignoreWrites?: boolean;
}) {
  var dict =
    opts.dict === undefined
      ? {
          sys_id: "COL1",
          element: "description",
          internal_type: "string_full_utf8",
          column_label: "Description",
          mandatory: "false",
          default_value: "",
          read_only: "false",
          max_length: "40",
        }
      : opts.dict;
  var calls: { pushes: Array<Record<string, unknown>> } = { pushes: [] };
  var c = {
    _calls: calls,
    _dict: function () {
      return dict;
    },
    table: {
      query: async function (table: string, query: string) {
        if (table === "sys_dictionary") {
          return dict ? [dict] : [];
        }
        if (table === "sys_update_xml") {
          return opts.captured === false
            ? []
            : [{ sys_id: "UX1", name: query }];
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
      createRecord: async function () {
        return { sys_id: "NEW" };
      },
      pushWithUpdateSet: async function (p: {
        fields: Record<string, string>;
      }) {
        calls.pushes.push(p);
        // A healthy instance applies the write. ServiceNow silently ignores some
        // dictionary changes — that's `ignoreWrites`, and it must NOT read as success.
        if (!opts.ignoreWrites && dict) {
          Object.keys(p.fields).forEach(function (k) {
            (dict as Record<string, string>)[k] = p.fields[k];
          });
        }
        return { sys_id: "COL1" };
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
  return c as unknown as ServiceNowClient & {
    _calls: { pushes: Array<Record<string, unknown>> };
  };
}

function pushesOf(client: ServiceNowClient): Array<Record<string, unknown>> {
  return (
    client as unknown as { _calls: { pushes: Array<Record<string, unknown>> } }
  )._calls.pushes;
}

describe("toStoredValue", function () {
  it("renders values the way ServiceNow stores them, so the diff compares like with like", function () {
    expect(toStoredValue(true)).toBe("true");
    expect(toStoredValue(false)).toBe("false");
    expect(toStoredValue(4000)).toBe("4000");
    expect(toStoredValue("Description")).toBe("Description");
  });
});

describe("resolveAttributes", function () {
  it("maps friendly attributes onto their sys_dictionary columns", function () {
    expect(
      resolveAttributes({
        label: "Desc",
        mandatory: true,
        default: "n/a",
        readOnly: false,
        maxLength: 4000,
      }),
    ).toEqual({
      column_label: "Desc",
      mandatory: "true",
      default_value: "n/a",
      read_only: "false",
      max_length: "4000",
    });
  });

  it("REFUSES internal_type — ServiceNow returns 200 and silently ignores it", function () {
    expect(function () {
      resolveAttributes({ internalType: "integer" } as never);
    }).toThrow(/silently ignores an internal_type change/);
  });

  it("REFUSES a rename — element is immutable (delete + recreate)", function () {
    expect(function () {
      resolveAttributes({ element: "new_name" } as never);
    }).toThrow(/cannot be renamed/);
  });

  it("refuses an attribute that is not on the allowlist", function () {
    // An open field map on sys_dictionary lets a caller quietly corrupt the schema.
    expect(function () {
      resolveAttributes({ choice: "3" } as never);
    }).toThrow(/is not a settable column attribute/);
  });

  it("requires at least one attribute", function () {
    expect(function () {
      resolveAttributes({});
    }).toThrow(/at least one attribute/);
  });

  it("ignores undefined attributes rather than writing them as empty", function () {
    expect(resolveAttributes({ label: "X", default: undefined })).toEqual({
      column_label: "X",
    });
  });
});

describe("setColumn validation", function () {
  it("requires table and column", async function () {
    await expect(
      setColumn({
        client: liveClient({}),
        table: "",
        column: "c",
        attributes: { label: "X" },
      }),
    ).rejects.toThrow(/--table is required/);
    await expect(
      setColumn({
        client: liveClient({}),
        table: "t",
        column: "",
        attributes: { label: "X" },
      }),
    ).rejects.toThrow(/--column is required/);
  });

  it("requires an update set on the live path — an uncaptured change cannot be promoted", async function () {
    var client = liveClient({});
    await expect(
      setColumn({
        client: client,
        table: "x_t",
        column: "description",
        attributes: { maxLength: 4000 },
      }),
    ).rejects.toThrow(/--update-set <sys_id> is required/);
    expect(pushesOf(client)).toHaveLength(0);
  });

  it("throws when the column does not exist", async function () {
    await expect(
      setColumn({
        client: liveClient({ dict: null }),
        table: "x_t",
        column: "nope",
        attributes: { label: "X" },
        updateSetSysId: "us1",
      }),
    ).rejects.toThrow(/no column 'nope' on table 'x_t'/);
  });

  it("refuses a bad attribute BEFORE touching the instance, even on a dry-run", async function () {
    var client = liveClient({});
    await expect(
      setColumn({
        client: client,
        table: "x_t",
        column: "description",
        attributes: { internalType: "integer" } as never,
        dryRun: true,
      }),
    ).rejects.toThrow(/silently ignores an internal_type change/);
    expect(pushesOf(client)).toHaveLength(0);
  });
});

describe("setColumn dry-run", function () {
  it("diffs against the instance and writes nothing", async function () {
    var client = liveClient({});
    var result = await setColumn({
      client: client,
      table: "x_t",
      column: "description",
      attributes: { maxLength: 4000, mandatory: true },
      updateSetSysId: "us1",
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    // Order follows the order the caller supplied the attributes in.
    expect(result.changes).toEqual([
      { attribute: "max_length", from: "40", to: "4000" },
      { attribute: "mandatory", from: "false", to: "true" },
    ]);
    expect(pushesOf(client)).toHaveLength(0);
  });

  it("reports a dry-run that would change nothing", async function () {
    var result = await setColumn({
      client: liveClient({}),
      table: "x_t",
      column: "description",
      attributes: { maxLength: 40 },
      updateSetSysId: "us1",
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    expect(result.changes).toEqual([]);
    expect(result.note).toMatch(/already holds every requested value/);
  });
});

describe("setColumn live", function () {
  it("writes only the attributes that actually differ", async function () {
    var client = liveClient({});
    var result = await setColumn({
      client: client,
      table: "x_t",
      column: "description",
      attributes: { maxLength: 4000, label: "Description" }, // label already matches
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("applied");
    expect(result.verified).toBe(true);
    expect(result.capturedInUpdateSet).toBe(true);
    expect(result.changes).toEqual([
      { attribute: "max_length", from: "40", to: "4000" },
    ]);
    // The unchanged label is not written: a same-value write is a no-op that would
    // still report success.
    expect(pushesOf(client)).toHaveLength(1);
    expect(pushesOf(client)[0].fields).toEqual({
      max_length: "4000",
      column_label: "Description",
    });
    expect(pushesOf(client)[0].table).toBe("sys_dictionary");
    expect(pushesOf(client)[0].update_set_sys_id).toBe("us1");
  });

  it("sets the non-physical attributes (label, mandatory, default, read_only)", async function () {
    var client = liveClient({});
    var result = await setColumn({
      client: client,
      table: "x_t",
      column: "description",
      attributes: {
        label: "Long Description",
        mandatory: true,
        default: "none",
        readOnly: true,
      },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("applied");
    expect(result.verified).toBe(true);
    expect(pushesOf(client)[0].fields).toEqual({
      column_label: "Long Description",
      mandatory: "true",
      default_value: "none",
      read_only: "true",
    });
  });

  it("reports 'unchanged' and writes NOTHING when every value already matches", async function () {
    // An ALTER fires on a CHANGE, not on a write. Writing 40 over 40 does nothing but
    // would still return success — so we must not call it 'applied'.
    var client = liveClient({});
    var result = await setColumn({
      client: client,
      table: "x_t",
      column: "description",
      attributes: { maxLength: 40, mandatory: false },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("unchanged");
    expect(result.changes).toEqual([]);
    expect(pushesOf(client)).toHaveLength(0);
    // And it says plainly that metadata equality does not prove the physical column.
    expect(result.note).toMatch(/does not prove the physical column/);
  });

  it("FAILS when the instance accepts the write but does not change — the silent no-op", async function () {
    // This is the internal_type failure mode, and the reason a 200 is never evidence.
    var client = liveClient({ ignoreWrites: true });
    var result = await setColumn({
      client: client,
      table: "x_t",
      column: "description",
      attributes: { maxLength: 4000 },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
    expect(result.note).toMatch(/did NOT change/);
    expect(result.note).toMatch(/max_length reads back as '40', not '4000'/);
  });

  it("flags a write that landed but was NOT captured in the update set", async function () {
    // Live on the instance but absent from the set = unpromotable. Not a success.
    var client = liveClient({ captured: false });
    var result = await setColumn({
      client: client,
      table: "x_t",
      column: "description",
      attributes: { maxLength: 4000 },
      updateSetSysId: "us1",
    });
    expect(result.status).toBe("applied");
    expect(result.verified).toBe(true);
    expect(result.capturedInUpdateSet).toBe(false);
    expect(result.note).toMatch(/is NOT captured, so it cannot be promoted/);
  });
});
