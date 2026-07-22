import { setTable, resolveTableAttributes } from "../src/table";
import type { ServiceNowClient } from "../src/client";

var US = "20756100334a03107b18bc534d5c7b2b";

/**
 * A stub instance holding one collection dictionary row. A pushWithUpdateSet write
 * mutates it the way a healthy instance would; `ignoreWrites` simulates the failure
 * this verb has to catch — HTTP 200, nothing actually changes.
 */
function liveClient(opts: {
  dict?: Record<string, string> | null;
  captured?: boolean;
  ignoreWrites?: boolean;
  updateSetState?: string;
  pushThrows?: boolean;
} = {}) {
  var dict =
    opts.dict === undefined
      ? {
          sys_id: "DICT1",
          name: "x_cadso_core_setting",
          element: "",
          internal_type: "collection",
          audit: "false",
        }
      : opts.dict;
  var calls: { pushes: Array<Record<string, unknown>>; queries: Array<string> } = {
    pushes: [],
    queries: [],
  };
  var c = {
    _calls: calls,
    _dict: function () {
      return dict;
    },
    table: {
      query: async function (table: string, query: string) {
        calls.queries.push(table + "?" + query);
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
        if (table === "sys_dictionary") {
          return dict ? [dict] : [];
        }
        if (table === "sys_update_xml") {
          return opts.captured === false ? [] : [{ sys_id: "UX1", name: query }];
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
      pushWithUpdateSet: async function (p: { fields: Record<string, string> }) {
        calls.pushes.push(p);
        if (opts.pushThrows) throw new Error("network exploded");
        if (opts.ignoreWrites) return {};
        if (dict) {
          var keys = Object.keys(p.fields);
          for (var i = 0; i < keys.length; i += 1) {
            dict[keys[i]] = p.fields[keys[i]];
          }
        }
        return {};
      },
    },
  };
  return c as unknown as ServiceNowClient & {
    _calls: typeof calls;
    _dict: () => Record<string, string> | null;
  };
}

describe("resolveTableAttributes", function () {
  it("maps audit onto the dictionary column", function () {
    expect(resolveTableAttributes({ audit: true })).toEqual({ audit: "true" });
    expect(resolveTableAttributes({ audit: false })).toEqual({ audit: "false" });
  });

  it("requires at least one attribute", function () {
    expect(function () {
      resolveTableAttributes({});
    }).toThrow(/at least one attribute/);
    expect(function () {
      resolveTableAttributes({ audit: undefined });
    }).toThrow(/at least one attribute/);
  });

  it("requires an attributes object", function () {
    expect(function () {
      resolveTableAttributes(null as never);
    }).toThrow(/attributes object is required/);
  });

  it("redirects column attributes to set-column by name", function () {
    var columnAttrs = ["label", "mandatory", "default", "maxLength", "readOnly", "element", "internalType"];
    for (var i = 0; i < columnAttrs.length; i += 1) {
      var attrs = {} as Record<string, unknown>;
      attrs[columnAttrs[i]] = "x";
      expect(function () {
        resolveTableAttributes(attrs as never);
      }).toThrow(/Use set-column/);
    }
  });

  it("refuses an unknown attribute and names what is settable", function () {
    expect(function () {
      resolveTableAttributes({ nonsense: true } as never);
    }).toThrow(/not a settable table attribute[\s\S]*audit/);
  });
});

describe("setTable", function () {
  it("requires a client and a table", async function () {
    await expect(setTable({ attributes: { audit: true } } as never)).rejects.toThrow(
      /client is required/,
    );
    await expect(
      setTable({ client: liveClient(), table: "", attributes: { audit: true } }),
    ).rejects.toThrow(/--table is required/);
  });

  it("targets the COLLECTION row, not a column row", async function () {
    var c = liveClient();
    await setTable({
      client: c,
      table: "x_cadso_core_setting",
      attributes: { audit: true },
      updateSetSysId: US,
    });
    var dictQuery = c._calls.queries.filter(function (q) {
      return q.indexOf("sys_dictionary?") === 0;
    })[0];
    expect(dictQuery).toContain("name=x_cadso_core_setting");
    expect(dictQuery).toContain("elementISEMPTY");
  });

  it("dry-run diffs and writes nothing", async function () {
    var c = liveClient();
    var r = await setTable({
      client: c,
      table: "x_cadso_core_setting",
      attributes: { audit: true },
      updateSetSysId: US,
      dryRun: true,
    });
    expect(r.status).toBe("dry-run");
    expect(r.changes).toEqual([{ attribute: "audit", from: "false", to: "true" }]);
    expect(c._calls.pushes.length).toBe(0);
  });

  it("dry-run works without an update set", async function () {
    var c = liveClient();
    var r = await setTable({
      client: c,
      table: "x_cadso_core_setting",
      attributes: { audit: true },
      dryRun: true,
    });
    expect(r.status).toBe("dry-run");
    expect(r.note).toContain("(none provided)");
  });

  it("applies, reads back, and confirms capture", async function () {
    var c = liveClient();
    var r = await setTable({
      client: c,
      table: "x_cadso_core_setting",
      attributes: { audit: true },
      updateSetSysId: US,
    });
    expect(r.status).toBe("applied");
    expect(r.verified).toBe(true);
    expect(r.capturedInUpdateSet).toBe(true);
    expect(r.tableSysId).toBe("DICT1");
    expect(c._calls.pushes.length).toBe(1);
    expect(c._calls.pushes[0]).toEqual({
      update_set_sys_id: US,
      table: "sys_dictionary",
      record_sys_id: "DICT1",
      fields: { audit: "true" },
    });
  });

  it("looks for the _null update name when verifying capture", async function () {
    var c = liveClient();
    await setTable({
      client: c,
      table: "x_cadso_core_setting",
      attributes: { audit: true },
      updateSetSysId: US,
    });
    var xmlQuery = c._calls.queries.filter(function (q) {
      return q.indexOf("sys_update_xml?") === 0;
    })[0];
    expect(xmlQuery).toContain("sys_dictionary_x_cadso_core_setting_null");
  });

  it("reports unchanged when the value already matches, and writes nothing", async function () {
    var c = liveClient({
      dict: {
        sys_id: "DICT1",
        name: "x_cadso_core_setting",
        element: "",
        internal_type: "collection",
        audit: "true",
      },
    });
    var r = await setTable({
      client: c,
      table: "x_cadso_core_setting",
      attributes: { audit: true },
      updateSetSysId: US,
    });
    expect(r.status).toBe("unchanged");
    expect(r.changes).toEqual([]);
    expect(c._calls.pushes.length).toBe(0);
    // An identical-value write captures nothing — the note must not imply otherwise.
    expect(r.capturedInUpdateSet).toBe(false);
  });

  it("requires an update set on the live path", async function () {
    await expect(
      setTable({
        client: liveClient(),
        table: "x_cadso_core_setting",
        attributes: { audit: true },
      }),
    ).rejects.toThrow(/--update-set <sys_id> is required/);
  });

  it("refuses a closed update set", async function () {
    var c = liveClient({ updateSetState: "complete" });
    await expect(
      setTable({
        client: c,
        table: "x_cadso_core_setting",
        attributes: { audit: true },
        updateSetSysId: US,
      }),
    ).rejects.toThrow(/not 'in progress'/);
    expect(c._calls.pushes.length).toBe(0);
  });

  it("throws a useful error when the table has no collection row", async function () {
    await expect(
      setTable({
        client: liveClient({ dict: null }),
        table: "x_nope",
        attributes: { audit: true },
        updateSetSysId: US,
      }),
    ).rejects.toThrow(/no collection dictionary row found/);
  });

  it("reports failed when the instance takes the write but ignores it", async function () {
    var c = liveClient({ ignoreWrites: true });
    var r = await setTable({
      client: c,
      table: "x_cadso_core_setting",
      attributes: { audit: true },
      updateSetSysId: US,
    });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
    expect(r.note).toContain("read-back does not match");
  });

  it("reports failed — not throws — when the transport dies", async function () {
    var c = liveClient({ pushThrows: true });
    var r = await setTable({
      client: c,
      table: "x_cadso_core_setting",
      attributes: { audit: true },
      updateSetSysId: US,
    });
    expect(r.status).toBe("failed");
    expect(r.note).toContain("failed in transport");
    expect(r.note).toContain("network exploded");
  });

  it("flags a verified write that was never captured", async function () {
    var c = liveClient({ captured: false });
    var r = await setTable({
      client: c,
      table: "x_cadso_core_setting",
      attributes: { audit: true },
      updateSetSysId: US,
    });
    expect(r.status).toBe("applied");
    expect(r.verified).toBe(true);
    expect(r.capturedInUpdateSet).toBe(false);
    expect(r.note).toContain("cannot be promoted");
  });

  it("turns auditing back off too", async function () {
    var c = liveClient({
      dict: {
        sys_id: "DICT1",
        name: "x_cadso_core_setting",
        element: "",
        internal_type: "collection",
        audit: "true",
      },
    });
    var r = await setTable({
      client: c,
      table: "x_cadso_core_setting",
      attributes: { audit: false },
      updateSetSysId: US,
    });
    expect(r.status).toBe("applied");
    expect(r.changes).toEqual([{ attribute: "audit", from: "true", to: "false" }]);
  });
});
