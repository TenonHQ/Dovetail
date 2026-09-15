/**
 * export-update-set unit tests.
 *
 * No network: reads go through makeMockClient with a scripted now.invoke, and
 * the complete-mode servlet is driven through the ExportTransport seam. Record
 * payloads are synthetic but shaped exactly like real captures (entity-encoded
 * record XML inside <payload>) and carry fixture values only.
 */

import {
  exportUpdateSet,
  renderUpdateXmlRow,
  renderUnload,
  countUnloadRecords,
  parseStatsCount,
  formatUnloadDate,
  xmlEscape,
  UPDATE_XML_FIELDS,
} from "../src/exportUpdateSet";
import type { ExportUpdateSetParams } from "../src/exportUpdateSet";
import { SENTINEL } from "../src/secrets/secretRules";
import { makeMockClient } from "./mockClient";
import type { ServiceNowClient } from "../src/client";

var SET_SYS_ID = "0123456789abcdef0123456789abcdef";
var SET_ROW = {
  sys_id: SET_SYS_ID,
  name: "Tenon - Automate - fixture",
  application: "x_cadso_automate",
  description: "fixture set",
  state: "in progress",
};

var SECRET_VALUE = "FIXTURE-CLIENT-SECRET";

/**
 * A record payload exactly as the Table API returns it: RAW record XML. The
 * document renderer escapes it on the way into the unload.
 */
function payload(table: string, inner: string): string {
  return (
    '<record_update table="' +
    table +
    '"><' +
    table +
    ' action="INSERT_OR_UPDATE">' +
    inner +
    "</" +
    table +
    "></record_update>"
  );
}

/** The same payload as it appears INSIDE a document, i.e. entity-encoded. */
function encodedPayload(table: string, inner: string): string {
  return xmlEscape(payload(table, inner));
}

function oauthRow(sysId: string): Record<string, string> {
  return {
    action: "INSERT_OR_UPDATE",
    application: "x_cadso_automate",
    name: "oauth_entity_" + sysId,
    payload: payload(
      "oauth_entity",
      "<client_id>fixture-id</client_id><client_secret>" +
        SECRET_VALUE +
        "</client_secret><name>Incoming Messages Webhook</name><sys_id>" +
        sysId +
        "</sys_id>",
    ),
    target_name: "Incoming Messages Webhook",
    type: "OAuth Entity",
    sys_id: "u" + sysId.slice(1),
  };
}

function scriptRow(sysId: string): Record<string, string> {
  return {
    action: "INSERT_OR_UPDATE",
    application: "x_cadso_automate",
    name: "sys_script_include_" + sysId,
    payload: payload(
      "sys_script_include",
      "<name>SettingsMS</name><script>var x = 1;</script><sys_id>" + sysId + "</sys_id>",
    ),
    target_name: "SettingsMS",
    type: "Script Include",
    sys_id: "u" + sysId.slice(1),
  };
}

interface Harness {
  client: ServiceNowClient;
  invokes: Array<string>;
}

/**
 * Mock client whose now.invoke answers the stats count and pages the given rows.
 * `dictionaryRows` drives the L1 refresh read; [] leaves the baseline rules.
 */
function harness(options: {
  rows?: Array<Record<string, string>>;
  count?: number;
  setRows?: Array<Record<string, string>>;
  dictionaryThrows?: boolean;
  statsStatus?: number;
  pageStatus?: number;
}): Harness {
  var rows = options.rows || [];
  var ctx = makeMockClient({
    query: async function (table: string) {
      if (table === "sys_update_set") {
        return options.setRows === undefined ? [SET_ROW] : options.setRows;
      }
      if (table === "sys_dictionary") {
        if (options.dictionaryThrows) {
          throw new Error("dictionary unavailable");
        }
        return [];
      }
      return [];
    },
  });
  var invokes: Array<string> = [];
  ctx.client.now.invoke = async function (params: { method: string; path: string }) {
    invokes.push(params.method + " " + params.path);
    if (params.path.indexOf("/api/now/stats/") === 0) {
      var count = options.count === undefined ? rows.length : options.count;
      return {
        status: options.statsStatus === undefined ? 200 : options.statsStatus,
        body: { result: { stats: { count: String(count) } } },
      };
    }
    if (params.path.indexOf("/api/now/table/sys_update_xml") === 0) {
      if (options.pageStatus !== undefined) {
        return { status: options.pageStatus, body: {} };
      }
      var limit = parseInt((params.path.match(/sysparm_limit=(\d+)/) || ["", "0"])[1], 10);
      var offset = parseInt((params.path.match(/sysparm_offset=(\d+)/) || ["", "0"])[1], 10);
      return { status: 200, body: { result: rows.slice(offset, offset + limit) } };
    }
    return { status: 200, body: {} };
  } as ServiceNowClient["now"]["invoke"];
  return { client: ctx.client, invokes: invokes };
}

function params(overrides: Partial<ExportUpdateSetParams>): ExportUpdateSetParams {
  var base: ExportUpdateSetParams = { updateSet: SET_SYS_ID };
  return Object.assign(base, overrides) as ExportUpdateSetParams;
}

describe("pure helpers", function () {
  it("renders a row with the servlet's field order, skipping absent fields", function () {
    var xml = renderUpdateXmlRow({ name: "a", action: "INSERT_OR_UPDATE" });
    expect(xml).toBe(
      '<sys_update_xml action="INSERT_OR_UPDATE"><action>INSERT_OR_UPDATE</action><name>a</name></sys_update_xml>',
    );
    expect(UPDATE_XML_FIELDS.indexOf("payload")).toBeGreaterThan(-1);
  });

  it("escapes values it renders", function () {
    expect(renderUpdateXmlRow({ name: "a&b<c" })).toContain("<name>a&amp;b&lt;c</name>");
  });

  it("flattens a reference field to its value", function () {
    expect(renderUpdateXmlRow({ application: { value: "x_cadso_core", link: "http://x" } })).toContain(
      "<application>x_cadso_core</application>",
    );
  });

  it("wraps rows in an unload envelope", function () {
    var xml = renderUnload("<header/>", ["<sys_update_xml/>"], "2026-09-15 00:00:00");
    expect(xml.indexOf('<?xml version="1.0" encoding="UTF-8"?><unload unload_date="2026-09-15 00:00:00">')).toBe(0);
    expect(xml).toContain("</unload>");
  });

  it("counts records in an unload", function () {
    expect(countUnloadRecords('<unload><sys_update_xml a="1"></sys_update_xml><sys_update_xml/></unload>')).toBe(2);
    expect(countUnloadRecords("<unload/>")).toBe(0);
  });

  it("parses the aggregate count and rejects an unreadable one", function () {
    expect(parseStatsCount({ result: { stats: { count: "42" } } })).toBe(42);
    expect(function () {
      parseStatsCount({ result: {} });
    }).toThrow(/unreadable record count/);
  });

  it("formats an instance-style timestamp", function () {
    expect(formatUnloadDate(new Date(Date.UTC(2026, 8, 15, 18, 40, 2)))).toBe("2026-09-15 18:40:02");
  });
});

describe("exportUpdateSet — validation", function () {
  it("requires an update set selector", async function () {
    await expect(exportUpdateSet(params({ updateSet: "  " }))).rejects.toThrow(/updateSet is required/);
  });

  it("rejects an out-of-range pageSize", async function () {
    await expect(
      exportUpdateSet(params({ pageSize: 5000, client: harness({}).client })),
    ).rejects.toThrow(/pageSize must be an integer between 1 and 1000/);
  });

  it("fails clearly when nothing matches", async function () {
    var h = harness({ setRows: [] });
    await expect(exportUpdateSet(params({ client: h.client }))).rejects.toThrow(/no update set matches/);
  });

  it("refuses an ambiguous name", async function () {
    var h = harness({ setRows: [SET_ROW, SET_ROW] });
    await expect(
      exportUpdateSet(params({ updateSet: "Tenon - Automate - fixture", client: h.client })),
    ).rejects.toThrow(/matches more than one update set/);
  });
});

describe("exportUpdateSet — dry-run", function () {
  it("plans without reading records", async function () {
    var h = harness({ rows: [oauthRow("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")] });
    var result = await exportUpdateSet(params({ client: h.client, dryRun: true }));
    expect(result.status).toBe("dry-run");
    expect(result.xml).toBeUndefined();
    expect(h.invokes).toEqual([]);
    expect(result.note).toContain("Nothing was read or written");
  });

  it("refuses complete mode without confirm and says why", async function () {
    var h = harness({ rows: [] });
    var result = await exportUpdateSet(params({ client: h.client, mode: "complete" }));
    expect(result.status).toBe("dry-run");
    expect(result.note).toContain("a real write");
    expect(h.invokes).toEqual([]);
  });
});

describe("exportUpdateSet — assemble mode", function () {
  it("exports every record with secrets replaced", async function () {
    var h = harness({
      rows: [oauthRow("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), scriptRow("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
    });
    var result = await exportUpdateSet(params({ client: h.client }));
    expect(result.status).toBe("exported");
    expect(result.recordCount).toBe(2);
    expect(result.expectedRecords).toBe(2);
    expect(result.xml).toBeDefined();
    expect(result.xml).not.toContain(SECRET_VALUE);
    expect(result.xml).toContain(SENTINEL);
    expect(result.xml).toContain("var x = 1;");
    expect(result.secretFields.length).toBe(1);
    expect(result.secretFields[0].field).toBe("client_secret");
    expect(result.note).toContain("1 secret value(s) replaced");
  });

  it("writes nothing to the instance", async function () {
    var h = harness({ rows: [scriptRow("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")] });
    await exportUpdateSet(params({ client: h.client }));
    for (var i = 0; i < h.invokes.length; i += 1) {
      expect(h.invokes[i].indexOf("GET ")).toBe(0);
    }
  });

  it("pages until the set is exhausted", async function () {
    var rows = [
      oauthRow("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      scriptRow("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      scriptRow("cccccccccccccccccccccccccccccccc"),
    ];
    var h = harness({ rows: rows });
    var result = await exportUpdateSet(params({ client: h.client, pageSize: 2 }));
    expect(result.status).toBe("exported");
    expect(result.recordCount).toBe(3);
    var pageCalls = h.invokes.filter(function (c: string) {
      return c.indexOf("/api/now/table/sys_update_xml") !== -1;
    });
    expect(pageCalls.length).toBe(2);
  });

  it("refuses to write when the row count does not match the set", async function () {
    var h = harness({ rows: [scriptRow("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")], count: 7 });
    var result = await exportUpdateSet(params({ client: h.client }));
    expect(result.status).toBe("failed");
    expect(result.xml).toBeUndefined();
    expect(result.note).toContain("may be truncated");
  });

  it("stops at maxRows rather than truncating silently", async function () {
    var many: Array<Record<string, string>> = [];
    for (var i = 0; i < 6; i += 1) {
      many.push(scriptRow("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" + String(i)));
    }
    var h = harness({ rows: many });
    await expect(
      exportUpdateSet(params({ client: h.client, pageSize: 2, maxRows: 3 })),
    ).rejects.toThrow(/exceeds maxRows/);
  });

  it("reports an empty set instead of writing an empty document", async function () {
    var h = harness({ rows: [] });
    var result = await exportUpdateSet(params({ client: h.client }));
    expect(result.status).toBe("failed");
    expect(result.note).toContain("no records");
  });

  it("fails when the count call fails", async function () {
    var h = harness({ rows: [scriptRow("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")], statsStatus: 403 });
    await expect(exportUpdateSet(params({ client: h.client }))).rejects.toThrow(/could not count/);
  });

  it("fails when a page read fails", async function () {
    var h = harness({ rows: [scriptRow("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")], pageStatus: 500 });
    await expect(exportUpdateSet(params({ client: h.client }))).rejects.toThrow(/Nothing was written/);
  });

  it("keeps the baseline rules when the dictionary cannot be read", async function () {
    var h = harness({
      rows: [oauthRow("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
      dictionaryThrows: true,
    });
    var result = await exportUpdateSet(params({ client: h.client }));
    expect(result.status).toBe("exported");
    expect(result.xml).not.toContain(SECRET_VALUE);
  });
});

describe("exportUpdateSet — complete mode", function () {
  function servletHarness(body: string, status: number) {
    var h = harness({ rows: [oauthRow("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")] });
    var gets: Array<string> = [];
    var transport = {
      openSession: async function () {
        return { ck: "c".repeat(72), jar: {} };
      },
      get: async function (_auth: unknown, _session: unknown, path: string) {
        gets.push(path);
        return { status: status, location: "", body: body };
      },
    };
    return { h: h, transport: transport, gets: gets };
  }

  var unloadBody =
    '<?xml version="1.0" encoding="UTF-8"?><unload unload_date="2026-09-15 00:00:00">' +
    '<sys_update_xml action="INSERT_OR_UPDATE"><name>oauth_entity_a</name><payload>' +
    encodedPayload(
      "oauth_entity",
      "<client_secret>" + SECRET_VALUE + "</client_secret><sys_id>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</sys_id>",
    ) +
    "</payload></sys_update_xml></unload>";

  it("completes the set, reads the servlet and strips the document", async function () {
    var s = servletHarness(unloadBody, 200);
    var result = await exportUpdateSet(
      params({
        client: s.h.client,
        mode: "complete",
        confirm: true,
        instance: "example.service-now.com",
        user: "svc",
        password: "svc-pass",
        transport: s.transport,
      }),
    );
    expect(result.status).toBe("exported");
    expect(result.xml).not.toContain(SECRET_VALUE);
    expect(result.recordCount).toBe(1);
    expect(s.gets[0]).toContain("/export_update_set.do?sysparm_sys_id=" + SET_SYS_ID);
    expect(s.gets[0]).toContain("sysparm_delete_when_done=false");
    var puts = s.h.invokes.filter(function (c: string) {
      return c.indexOf("PUT ") === 0;
    });
    expect(puts.length).toBe(1);
    expect(puts[0]).toContain("/api/now/table/sys_update_set/" + SET_SYS_ID);
  });

  it("detects the in-progress empty 200 instead of writing an empty file", async function () {
    var s = servletHarness("", 200);
    var result = await exportUpdateSet(
      params({
        client: s.h.client,
        mode: "complete",
        confirm: true,
        instance: "example.service-now.com",
        user: "svc",
        password: "svc-pass",
        transport: s.transport,
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toContain("still in progress");
    expect(result.xml).toBeUndefined();
  });

  it("reports a servlet error status", async function () {
    var s = servletHarness("nope", 401);
    var result = await exportUpdateSet(
      params({
        client: s.h.client,
        mode: "complete",
        confirm: true,
        instance: "example.service-now.com",
        user: "svc",
        password: "svc-pass",
        transport: s.transport,
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toContain("HTTP 401");
  });
});
