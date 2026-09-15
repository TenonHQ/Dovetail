/**
 * export-app unit tests.
 *
 * The xmlhttp.do leg is driven through the ExportAppTransport seam with
 * scripted answers shaped like the HAR (answer attribute + entity-encoded
 * progress JSON); sleep is stubbed so the poll loop runs instantly. Reads go
 * through makeMockClient with a scripted now.invoke. No network, no fixtures
 * with real values.
 */

import {
  exportApp,
  buildCreateSetFields,
  buildPublishFields,
} from "../src/exportApp";
import type { ExportAppParams } from "../src/exportApp";
import { xmlEscape } from "../src/exportUpdateSet";
import { SENTINEL } from "../src/secrets/secretRules";
import { makeMockClient } from "./mockClient";
import type { ServiceNowClient } from "../src/client";

var APP_SYS_ID = "d4b29430871812d0369f33373cbb35a8";
var SET_SYS_ID = "6d90bbaa47990390192e4c1b116d43b4";
var WORKER_ID = "3990bbaa47990390192e4c1b116d43b6";
var SECRET_VALUE = "FIXTURE-CLIENT-SECRET";

var APP_ROW = {
  sys_id: APP_SYS_ID,
  scope: "x_cadso_automate",
  name: "Tenon Marketing Automation",
  version: "1.1.0",
};

var SET_ROW = {
  sys_id: SET_SYS_ID,
  name: "Tenon Marketing Automation",
  application: "x_cadso_automate",
  description: "fixture",
  state: "complete",
};

function answerXml(answer: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?><xml answer="' + answer + '"/>';
}

function progressXml(state: string, message: string): string {
  var json = JSON.stringify({
    state: state,
    message: message,
    percent_complete: "100",
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?><xml answer="' +
    xmlEscape(json) +
    '"/>'
  );
}

var UNLOAD =
  '<?xml version="1.0" encoding="UTF-8"?><unload unload_date="2026-09-15 00:00:00">' +
  '<sys_update_xml action="INSERT_OR_UPDATE"><name>oauth_entity_a</name><payload>' +
  xmlEscape(
    '<record_update table="oauth_entity"><oauth_entity action="INSERT_OR_UPDATE">' +
      "<client_secret>" +
      SECRET_VALUE +
      "</client_secret><sys_id>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</sys_id></oauth_entity></record_update>",
  ) +
  "</payload></sys_update_xml></unload>";

/** Client whose reads answer app/set lookups and the export's count call. */
function mockClient(options: {
  appRows?: Array<Record<string, string>>;
  count?: number;
}) {
  var ctx = makeMockClient({
    query: async function (table: string) {
      if (table === "sys_app") {
        return options.appRows === undefined ? [APP_ROW] : options.appRows;
      }
      if (table === "sys_update_set") {
        return [SET_ROW];
      }
      return [];
    },
  });
  ctx.client.now.invoke = async function (params: {
    method: string;
    path: string;
  }) {
    if (params.path.indexOf("/api/now/stats/") === 0) {
      var count = options.count === undefined ? 1 : options.count;
      return {
        status: 200,
        body: { result: { stats: { count: String(count) } } },
      };
    }
    return { status: 200, body: {} };
  } as ServiceNowClient["now"]["invoke"];
  return ctx.client;
}

/** Transport answering each xmlhttp.do POST from a queue. */
function scriptedTransport(
  bodies: Array<string>,
  servletBody: string,
  servletStatus: number,
) {
  var posts: Array<Record<string, string>> = [];
  var queue = bodies.slice();
  return {
    posts: posts,
    transport: {
      openSession: async function () {
        return { ck: "c".repeat(72), jar: {} };
      },
      post: async function (
        _auth: unknown,
        _session: unknown,
        _path: string,
        fields: Record<string, string>,
      ) {
        posts.push(fields);
        var body = queue.length > 0 ? (queue.shift() as string) : "";
        return { status: 200, location: "", body: body };
      },
      get: async function () {
        return { status: servletStatus, location: "", body: servletBody };
      },
      sleep: async function () {
        return undefined;
      },
    },
  };
}

function params(overrides: Partial<ExportAppParams>): ExportAppParams {
  var base: ExportAppParams = {
    app: APP_SYS_ID,
    instance: "example.service-now.com",
    user: "svc",
    password: "svc-pass",
  };
  return Object.assign(base, overrides) as ExportAppParams;
}

describe("field builders", function () {
  var app = {
    sysId: APP_SYS_ID,
    scope: "x_cadso_automate",
    name: "App",
    version: "1.1.0",
  };

  it("builds the createUpdateSet call the UI sends", function () {
    var fields = buildCreateSetFields(app, "");
    expect(fields.sysparm_function).toBe("createUpdateSet");
    expect(fields.sysparm_appid).toBe(APP_SYS_ID);
    expect(fields.sysparm_current).toBe("false");
    expect(fields.sysparm_description).toBe(" ");
  });

  it("builds the publish call, with data excluded unless asked", function () {
    var off = buildPublishFields(app, SET_SYS_ID, "1.2.0", "notes", false);
    expect(off.sysparm_function).toBe("publishToUpdateSet");
    expect(off.sysparm_update_set_id).toBe(SET_SYS_ID);
    expect(off.sysparm_version).toBe("1.2.0");
    expect(off.sysparm_include_data).toBe("");
    expect(
      buildPublishFields(app, SET_SYS_ID, "1.2.0", "notes", true)
        .sysparm_include_data,
    ).toBe("true");
  });
});

describe("exportApp — validation and dry-run", function () {
  it("requires an app selector", async function () {
    await expect(exportApp(params({ app: "" }))).rejects.toThrow(
      /app is required/,
    );
  });

  it("rejects a nonsense timeout", async function () {
    await expect(
      exportApp(params({ timeoutMs: Number.NaN, client: mockClient({}) })),
    ).rejects.toThrow(/timeoutMs must be a positive integer/);
  });

  it("fails clearly when no app matches", async function () {
    await expect(
      exportApp(params({ client: mockClient({ appRows: [] }) })),
    ).rejects.toThrow(/no application matches/);
  });

  it("publishes nothing without confirm", async function () {
    var s = scriptedTransport([], "", 200);
    var result = await exportApp(
      params({ client: mockClient({}), transport: s.transport }),
    );
    expect(result.status).toBe("dry-run");
    expect(result.note).toContain("a real instance write");
    expect(s.posts).toEqual([]);
  });

  it("defaults the version to the app's current one", async function () {
    var result = await exportApp(params({ client: mockClient({}) }));
    expect(result.version).toBe("1.1.0");
  });
});

describe("exportApp — live publish", function () {
  it("creates a set, publishes, polls to success and exports stripped XML", async function () {
    var s = scriptedTransport(
      [
        answerXml(SET_SYS_ID),
        answerXml(WORKER_ID),
        progressXml("1", "Publishing 400 of 1088 files"),
        progressXml("2", "Successfully published"),
      ],
      UNLOAD,
      200,
    );
    var result = await exportApp(
      params({ client: mockClient({}), confirm: true, transport: s.transport }),
    );
    expect(result.status).toBe("exported");
    expect(result.updateSetSysId).toBe(SET_SYS_ID);
    expect(result.polls).toBe(2);
    expect(result.recordCount).toBe(1);
    expect(result.xml).not.toContain(SECRET_VALUE);
    expect(result.xml).toContain(SENTINEL);
    expect(result.secretFields.length).toBe(1);
    expect(s.posts[0].sysparm_function).toBe("createUpdateSet");
    expect(s.posts[1].sysparm_function).toBe("publishToUpdateSet");
    expect(s.posts[2].sysparm_processor).toBe("AJAXProgressStatusChecker");
  });

  it("fails when the set could not be created", async function () {
    var s = scriptedTransport([answerXml("")], UNLOAD, 200);
    var result = await exportApp(
      params({ client: mockClient({}), confirm: true, transport: s.transport }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toContain("did not return an update set");
  });

  it("reports a failed publish and names the set it left behind", async function () {
    var s = scriptedTransport(
      [
        answerXml(SET_SYS_ID),
        answerXml(WORKER_ID),
        progressXml("3", "Publish failed"),
      ],
      UNLOAD,
      200,
    );
    var result = await exportApp(
      params({ client: mockClient({}), confirm: true, transport: s.transport }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toContain(SET_SYS_ID);
    expect(result.message).toBe("Publish failed");
  });

  it("keeps polling through an unrecognised state rather than calling it done", async function () {
    var s = scriptedTransport(
      [
        answerXml(SET_SYS_ID),
        answerXml(WORKER_ID),
        progressXml("0", "queued"),
        progressXml("9", "who knows"),
        progressXml("2", "Successfully published"),
      ],
      UNLOAD,
      200,
    );
    var result = await exportApp(
      params({ client: mockClient({}), confirm: true, transport: s.transport }),
    );
    expect(result.status).toBe("exported");
    expect(result.polls).toBe(3);
  });

  it("times out instead of hanging", async function () {
    var s = scriptedTransport(
      [answerXml(SET_SYS_ID), answerXml(WORKER_ID)],
      UNLOAD,
      200,
    );
    var result = await exportApp(
      params({
        client: mockClient({}),
        confirm: true,
        transport: s.transport,
        timeoutMs: 1,
      }),
    );
    expect(result.status).toBe("timeout");
    expect(result.note).toContain("export-update-set");
  });

  it("surfaces an export failure after a successful publish", async function () {
    var s = scriptedTransport(
      [
        answerXml(SET_SYS_ID),
        answerXml(WORKER_ID),
        progressXml("2", "Successfully published"),
      ],
      "",
      200,
    );
    var result = await exportApp(
      params({ client: mockClient({}), confirm: true, transport: s.transport }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toContain("still in progress");
    expect(result.updateSetSysId).toBe(SET_SYS_ID);
  });
});
