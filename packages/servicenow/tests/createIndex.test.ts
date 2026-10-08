/**
 * createIndex — the write side of the index capability.
 *
 * The form session is MOCKED here on purpose. The xmlhttp.do processor calls are
 * privileged platform behaviour a unit test cannot exercise; what a unit test CAN pin
 * is every decision around them — validation, the dry-run/confirm gate, the update-set
 * pin, idempotency, the exact field maps the two processors receive, and the refusal
 * to call anything created that was not read back. Those are the parts that go wrong
 * silently.
 *
 * The contract this pins (HAR of the Studio Database Indexes dialog, 2026-10-08):
 *   - DRY-RUN IS THE DEFAULT and is PURE: without confirm:true nothing is sent and
 *     nothing is even READ.
 *   - identifiers are validated before anything touches a query or a processor's
 *     comma-separated field list.
 *   - updateSetSysId is REQUIRED on the live path; the set must exist, be in the
 *     table's application scope and be 'in progress'.
 *   - an index over exactly those columns already present short-circuits to
 *     `already-exists` with NO form session opened and NO pin.
 *   - the update set is pinned (changeUpdateSet) and READ BACK (currentUpdateSet)
 *     before the session opens; a pin that did not take stops the run.
 *   - call 1 is IndexCreatorErrorChecker.canCreate; a canCreate:false verdict stops
 *     the run with its errorCode and ScheduleCreator is never called.
 *   - call 2 is ScheduleCreator.createSchedule with sysparm_unique "true"/"false",
 *     empty sysparm_email and sysparm_schedule_name.
 *   - a read-back that never sees the index is a FAILURE, not a caveat.
 *   - the capture row (sys_update_xml, type=Indexes) is read back from the pinned
 *     set; missing → created:true, captured:false, "update-set-capture" unverified.
 *   - `name` is REFUSED, because the dialog has no name input.
 *   - "uniqueness-enforced" is in `unverified` on every status.
 */

import { makeMockClient } from "./mockClient";
import type { ServiceNowClient } from "../src/client";

var openFormSession = jest.fn();
var postForm = jest.fn();

jest.mock("../src/table/formSession", function () {
  var actual = jest.requireActual("../src/table/formSession");
  return {
    __esModule: true,
    ...actual,
    resolveFormAuth: function () {
      return {
        host: "example-instance.service-now.com",
        user: "u",
        password: "p",
      };
    },
    openFormSession: function (...args: Array<unknown>) {
      return openFormSession(...args);
    },
    postForm: function (...args: Array<unknown>) {
      return postForm(...args);
    },
  };
});

// Imported AFTER the mock is registered.
/* eslint-disable @typescript-eslint/no-var-requires */
import {
  createIndex,
  captureRowName,
  parseAjaxAnswer,
  parseCanCreate,
  readCurrentSet,
} from "../src/table/createIndex";
import type { CreateIndexParams } from "../src/table/createIndex";

var TABLE = "x_cadso_core_u_smoke_test_ct4";
var HOST = "example-instance.service-now.com";
var SCOPE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
var OTHER_SCOPE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
var SET = "0123456789abcdef0123456789abcdef";
var SET_NAME = "Tenon - Core - Index smoke";

function indexRow(name: string, columns: string, table: string = TABLE) {
  return {
    table_name: table,
    index_name: name,
    column_names: columns,
    access_method: "btree",
  };
}

var CAN_CREATE_OK =
  '<?xml version="1.0" encoding="UTF-8"?><xml answer="{&quot;canCreate&quot;:true,&quot;errorCode&quot;:null}" sysparm_name="canCreate" sysparm_processor="IndexCreatorErrorChecker"/>';
var CAN_CREATE_NO =
  '<xml answer="{&quot;canCreate&quot;:false,&quot;errorCode&quot;:&quot;Field status is not indexable&quot;}"/>';
var SCHEDULE_OK =
  '<?xml version="1.0" encoding="UTF-8"?><xml sysparm_name="createSchedule" sysparm_processor="ScheduleCreator"/>';

function okSession() {
  openFormSession.mockResolvedValue({ ck: "CK", jar: {} });
  postForm
    .mockResolvedValueOnce({ status: 200, location: "", body: CAN_CREATE_OK })
    .mockResolvedValueOnce({ status: 200, location: "", body: SCHEDULE_OK });
}

/**
 * A table-aware live-path client. `indexes` is served per v_db_index read (the
 * last entry repeats), `captures` per sys_update_xml read. sys_db_object and
 * sys_update_set answer from the fixture shape unless overridden.
 */
function liveClient(opts: {
  indexes: Array<Array<Record<string, string>>>;
  captures?: Array<Array<Record<string, unknown>>>;
  tableRows?: Array<Record<string, string>>;
  setRows?: Array<Record<string, string>>;
  indexError?: Error;
  captureError?: Error;
}) {
  var indexCall = 0;
  var captureCall = 0;
  var tableRows =
    opts.tableRows !== undefined
      ? opts.tableRows
      : [{ sys_id: "t1", name: TABLE, sys_scope: SCOPE }];
  var setRows =
    opts.setRows !== undefined
      ? opts.setRows
      : [{ sys_id: SET, name: SET_NAME, application: SCOPE, state: "in progress" }];
  var ctx = makeMockClient({
    query: async function (table: string) {
      if (table === "sys_db_object") return tableRows;
      if (table === "sys_update_set") return setRows;
      if (table === "v_db_index") {
        if (opts.indexError) throw opts.indexError;
        var rows =
          opts.indexes[Math.min(indexCall, opts.indexes.length - 1)];
        indexCall += 1;
        return rows;
      }
      if (table === "sys_update_xml") {
        if (opts.captureError) throw opts.captureError;
        var caps = opts.captures || [];
        if (caps.length === 0) return [];
        var crow = caps[Math.min(captureCall, caps.length - 1)];
        captureCall += 1;
        return crow;
      }
      throw new Error("unexpected table " + table);
    },
  });
  // The pin is read back against the requested set; the shared mock answers "cur".
  ctx.client.claude.currentUpdateSet = async function () {
    return { sys_id: SET, name: SET_NAME };
  };
  return ctx;
}

function captureRow(columns: Array<string>, set: string = SET) {
  return {
    sys_id: "ux1",
    name: captureRowName(TABLE, columns),
    type: "Indexes",
    update_set: { value: set },
  };
}

/** Every method throws — proves a path touched no network. */
function noNetworkClient(): ServiceNowClient {
  var boom = function (): never {
    throw new Error("no network call expected");
  };
  return {
    table: { query: boom },
    buildAgent: { runQuery: boom, getTableSchema: boom },
    claude: {
      createRecord: boom,
      pushWithUpdateSet: boom,
      currentUpdateSet: boom,
      changeUpdateSet: boom,
      deleteRecord: boom,
    },
    now: { get: boom, post: boom, put: boom, delete: boom, invoke: boom },
    attachment: { listFor: boom, upload: boom, remove: boom },
  } as unknown as ServiceNowClient;
}

function base(over: Partial<CreateIndexParams> = {}): CreateIndexParams {
  return Object.assign(
    {
      client: noNetworkClient(),
      table: TABLE,
      columns: ["owner"],
      updateSetSysId: SET,
      // The poll is exercised with a zero-ish wall clock so the suite stays fast.
      pollAttempts: 2,
      pollIntervalMs: 1,
    },
    over,
  ) as CreateIndexParams;
}

function fieldsOfCall(n: number): Record<string, string> {
  return postForm.mock.calls[n][3] as Record<string, string>;
}

beforeEach(function () {
  openFormSession.mockReset();
  postForm.mockReset();
});

describe("createIndex — identifier validation", function () {
  var badColumns = [
    "phone;DROP",
    "created on",
    "x_cadso.phone",
    "phone^ORsys_id!=1",
    "phone=1",
    "1phone",
    "",
  ];

  badColumns.forEach(function (value) {
    it(
      "refuses the injection-shaped column " + JSON.stringify(value),
      async function () {
        await expect(
          createIndex(base({ columns: [value], confirm: true })),
        ).rejects.toThrow(/index-create:/);
      },
    );
  });

  it("refuses an injection-shaped TABLE name", async function () {
    await expect(
      createIndex(base({ table: "phone;DROP", confirm: true })),
    ).rejects.toThrow(/index-create:/);
  });

  it("refuses an empty column list", async function () {
    await expect(
      createIndex(base({ columns: [], confirm: true })),
    ).rejects.toThrow(/at least one column/);
  });

  it("refuses the same column twice", async function () {
    await expect(
      createIndex(base({ columns: ["a", "A"], confirm: true })),
    ).rejects.toThrow(/listed twice/);
  });

  it("refuses --name, because the dialog has no name input", async function () {
    await expect(
      createIndex(base({ name: "idx_owner", confirm: true })),
    ).rejects.toThrow(/refusing to set an index name/);
  });

  it("requires updateSetSysId on the live path", async function () {
    await expect(
      createIndex(base({ updateSetSysId: undefined, confirm: true })),
    ).rejects.toThrow(/updateSetSysId is required on the live path/);
  });

  it("refuses a malformed updateSetSysId before any request", async function () {
    await expect(
      createIndex(base({ updateSetSysId: "not-a-sys-id", confirm: true })),
    ).rejects.toThrow(/not a 32-char sys_id/);
  });

  it("validates before ANY request, even on the live path", async function () {
    okSession();
    var ctx = liveClient({ indexes: [[]] });
    await expect(
      createIndex(
        base({ client: ctx.client, columns: ["phone;DROP"], confirm: true }),
      ),
    ).rejects.toThrow();
    expect(ctx.calls.tableQuery).toHaveLength(0);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
    expect(openFormSession).not.toHaveBeenCalled();
  });

  it("refuses a non-integer poll setting rather than running unbounded", async function () {
    await expect(
      createIndex(base({ confirm: true, pollAttempts: 0 })),
    ).rejects.toThrow(/positive integers/);
  });
});

describe("createIndex — the dry-run / confirm gate", function () {
  it("is a dry-run by default and issues NO request at all", async function () {
    var ctx = liveClient({ indexes: [[]] });
    var result = await createIndex(base({ client: ctx.client }));
    expect(result.status).toBe("dry-run");
    expect(result.created).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.captured).toBe(false);
    expect(ctx.calls.tableQuery).toHaveLength(0);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
    expect(openFormSession).not.toHaveBeenCalled();
    expect(postForm).not.toHaveBeenCalled();
  });

  it("a dry-run does not need an update set", async function () {
    var result = await createIndex(base({ updateSetSysId: undefined }));
    expect(result.status).toBe("dry-run");
    expect(result.updateSet).toBeNull();
    expect(result.note).toMatch(/required on the live path/);
  });

  it("dryRun:true wins over confirm:true", async function () {
    okSession();
    var ctx = liveClient({ indexes: [[]] });
    var result = await createIndex(
      base({ client: ctx.client, confirm: true, dryRun: true }),
    );
    expect(result.status).toBe("dry-run");
    expect(ctx.calls.tableQuery).toHaveLength(0);
    expect(postForm).not.toHaveBeenCalled();
  });

  it("the dry-run note states the index IS captured into the pinned set", async function () {
    var result = await createIndex(base());
    expect(result.note).toMatch(/IS captured in an update set/);
    expect(result.note).toMatch(/ScheduleCreator\.createSchedule/);
    expect(result.unverified).toContain("uniqueness-enforced");
  });
});

describe("createIndex — target checks", function () {
  it("fails when the table is unknown, before pinning or opening a session", async function () {
    okSession();
    var ctx = liveClient({ indexes: [[]], tableRows: [] });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/not found in sys_db_object/);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
    expect(openFormSession).not.toHaveBeenCalled();
  });

  it("fails when the update set is unknown", async function () {
    okSession();
    var ctx = liveClient({ indexes: [[]], setRows: [] });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/not found in sys_update_set/);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
  });

  it("refuses an update set outside the table's application scope", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[]],
      setRows: [
        { sys_id: SET, name: SET_NAME, application: OTHER_SCOPE, state: "in progress" },
      ],
    });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/wrong scope/);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
    expect(postForm).not.toHaveBeenCalled();
  });

  it("refuses an update set that is not in progress", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[]],
      setRows: [{ sys_id: SET, name: SET_NAME, application: SCOPE, state: "complete" }],
    });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/not 'in progress'/);
    expect(postForm).not.toHaveBeenCalled();
  });
});

describe("createIndex — idempotency", function () {
  it("short-circuits to already-exists without pinning or opening a session", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[indexRow("owner", "[owner]"), indexRow("PRIMARY", "[sys_id]")]],
    });
    var result = await createIndex(
      base({ client: ctx.client, columns: ["owner"], confirm: true }),
    );
    expect(result.status).toBe("already-exists");
    expect(result.created).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.name).toBe("owner");
    expect(result.updateSet).toEqual({ sysId: SET, name: SET_NAME });
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
    expect(openFormSession).not.toHaveBeenCalled();
    expect(postForm).not.toHaveBeenCalled();
  });

  it("matches a composite index in the view's SEMICOLON form", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[indexRow("sys_created_on", "[sys_created_on;status;version]")]],
    });
    var result = await createIndex(
      base({
        client: ctx.client,
        columns: ["sys_created_on", "status", "version"],
        confirm: true,
      }),
    );
    expect(result.status).toBe("already-exists");
    expect(result.name).toBe("sys_created_on");
    expect(postForm).not.toHaveBeenCalled();
  });

  it("matches on the EXACT parsed column list, not a substring", async function () {
    okSession();
    // "[owner_id]" contains "owner" — a substring test would green-light it.
    var ctx = liveClient({
      indexes: [[indexRow("owner_id", "[owner_id]")], [indexRow("owner", "[owner]")]],
      captures: [[captureRow(["owner"])]],
    });
    var result = await createIndex(
      base({ client: ctx.client, columns: ["owner"], confirm: true }),
    );
    expect(result.status).toBe("created");
    expect(postForm).toHaveBeenCalledTimes(2);
  });

  it("treats a different column ORDER as a different index", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[indexRow("ba", "[b;a]")], [indexRow("a", "[a;b]")]],
      captures: [[captureRow(["a", "b"])]],
    });
    var result = await createIndex(
      base({ client: ctx.client, columns: ["a", "b"], confirm: true }),
    );
    expect(result.status).toBe("created");
  });

  it("refuses to write when v_db_index cannot be read", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[]],
      indexError: new Error("HTTP 403 Failed API level ACL Validation"),
    });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/403/);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
    expect(postForm).not.toHaveBeenCalled();
  });
});

describe("createIndex — the update-set pin", function () {
  it("pins the set via changeUpdateSet BEFORE the session opens, and reads it back", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[], [indexRow("owner", "[owner]")]],
      captures: [[captureRow(["owner"])]],
    });
    var order: Array<string> = [];
    var origChange = ctx.client.claude.changeUpdateSet;
    ctx.client.claude.changeUpdateSet = async function (p) {
      order.push("pin");
      return origChange(p);
    };
    ctx.client.claude.currentUpdateSet = async function () {
      order.push("read-back");
      return { sys_id: SET, name: SET_NAME };
    };
    openFormSession.mockImplementation(async function () {
      order.push("session");
      return { ck: "CK", jar: {} };
    });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("created");
    expect(ctx.calls.changeUpdateSet).toEqual([{ sysId: SET }]);
    expect(order).toEqual(["pin", "read-back", "session"]);
  });

  it("stops when the pin did not take — the current set reads back as another", async function () {
    okSession();
    var ctx = liveClient({ indexes: [[]] });
    ctx.client.claude.currentUpdateSet = async function () {
      return { sys_id: "ffffffffffffffffffffffffffffffff", name: "Default" };
    };
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/read back as 'Default'/);
    expect(openFormSession).not.toHaveBeenCalled();
    expect(postForm).not.toHaveBeenCalled();
  });

  it("stops when changeUpdateSet throws", async function () {
    okSession();
    var ctx = liveClient({ indexes: [[]] });
    ctx.client.claude.changeUpdateSet = async function () {
      throw new Error("HTTP 500 changeUpdateSet");
    };
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/could not be pinned/);
    expect(postForm).not.toHaveBeenCalled();
  });
});

describe("createIndex — the processor calls", function () {
  it("call 1 is IndexCreatorErrorChecker.canCreate with the dialog's exact fields", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[], [indexRow("a", "[a;b]")]],
      captures: [[captureRow(["a", "b"])]],
    });
    var result = await createIndex(
      base({ client: ctx.client, columns: ["a", "b"], confirm: true }),
    );
    expect(result.status).toBe("created");
    expect(postForm.mock.calls[0][2]).toBe("/xmlhttp.do");
    var f = fieldsOfCall(0);
    expect(f.sysparm_processor).toBe("IndexCreatorErrorChecker");
    expect(f.sysparm_name).toBe("canCreate");
    expect(f.sysparm_table_name).toBe(TABLE);
    expect(f.sysparm_field_names).toBe("a,b");
    expect(f.sysparm_unique).toBe("");
    expect(f.sysparm_access_method).toBe("btree");
    expect(f.sysparm_scope).toBe("global");
  });

  it("call 2 is ScheduleCreator.createSchedule with the dialog's exact fields", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[], [indexRow("a", "[a;b]")]],
      captures: [[captureRow(["a", "b"])]],
    });
    await createIndex(
      base({ client: ctx.client, columns: ["a", "b"], confirm: true }),
    );
    expect(postForm.mock.calls[1][2]).toBe("/xmlhttp.do");
    var f = fieldsOfCall(1);
    expect(f.sysparm_processor).toBe("ScheduleCreator");
    expect(f.sysparm_name).toBe("createSchedule");
    expect(f.sysparm_table).toBe(TABLE);
    expect(f.sysparm_fields).toBe("a,b");
    expect(f.sysparm_access_method).toBe("btree");
    expect(f.sysparm_unique).toBe("false");
    expect(f.sysparm_email).toBe("");
    expect(f.sysparm_schedule_name).toBe("");
  });

  it("sends unique as 'true' on the pre-flight and 'true' on the schedule", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[], [indexRow("owner", "[owner]")]],
      captures: [[captureRow(["owner"])]],
    });
    await createIndex(base({ client: ctx.client, confirm: true, unique: true }));
    expect(fieldsOfCall(0).sysparm_unique).toBe("true");
    expect(fieldsOfCall(1).sysparm_unique).toBe("true");
  });

  it("passes an explicit access method to both calls", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[], [indexRow("owner", "[owner]")]],
      captures: [[captureRow(["owner"])]],
    });
    await createIndex(
      base({ client: ctx.client, confirm: true, accessMethod: "hash" }),
    );
    expect(fieldsOfCall(0).sysparm_access_method).toBe("hash");
    expect(fieldsOfCall(1).sysparm_access_method).toBe("hash");
  });

  it("a canCreate:false verdict stops the run with its errorCode; ScheduleCreator is never called", async function () {
    openFormSession.mockResolvedValue({ ck: "CK", jar: {} });
    postForm.mockResolvedValueOnce({ status: 200, location: "", body: CAN_CREATE_NO });
    var ctx = liveClient({ indexes: [[]] });
    var result = await createIndex(
      base({ client: ctx.client, columns: ["status"], confirm: true }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/canCreate=false/);
    expect(result.note).toMatch(/Field status is not indexable/);
    expect(postForm).toHaveBeenCalledTimes(1);
  });

  it("a redirect on the pre-flight is reported as a session problem, nothing scheduled", async function () {
    openFormSession.mockResolvedValue({ ck: "CK", jar: {} });
    postForm.mockResolvedValueOnce({
      status: 302,
      location: "/session_timeout.do",
      body: "",
    });
    var ctx = liveClient({ indexes: [[]] });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(302);
    expect(result.note).toMatch(/session_timeout/);
    expect(postForm).toHaveBeenCalledTimes(1);
  });

  it("a non-2xx on the schedule call is a failure that tells the caller to re-read", async function () {
    openFormSession.mockResolvedValue({ ck: "CK", jar: {} });
    postForm
      .mockResolvedValueOnce({ status: 200, location: "", body: CAN_CREATE_OK })
      .mockResolvedValueOnce({ status: 500, location: "", body: "boom" });
    var ctx = liveClient({ indexes: [[]] });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(500);
    expect(result.note).toMatch(/NOT scheduled/);
  });

  it("fails with the login diagnosis when the form session cannot be opened", async function () {
    openFormSession.mockRejectedValue(
      new Error("form login failed — the instance bounced to '/session_timeout.do'"),
    );
    var ctx = liveClient({ indexes: [[]] });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/session_timeout/);
    expect(postForm).not.toHaveBeenCalled();
  });
});

describe("createIndex — the read-back is the proof", function () {
  it("fails when the index never appears within the poll budget", async function () {
    okSession();
    var ctx = liveClient({ indexes: [[indexRow("PRIMARY", "[sys_id]")]] });
    var result = await createIndex(
      base({ client: ctx.client, confirm: true, pollAttempts: 3, pollIntervalMs: 1 }),
    );
    expect(result.status).toBe("failed");
    expect(result.created).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.note).toMatch(/NO matching index appeared/);
    expect(result.note).toMatch(/3 checks/);
  });

  it("reports created with the INSTANCE's name and the capture row read back", async function () {
    okSession();
    var ctx = liveClient({
      // Absent on the idempotency read and the first poll; present on the second.
      indexes: [[], [], [indexRow("owner", "[owner]")]],
      captures: [[captureRow(["owner"])]],
    });
    var result = await createIndex(
      base({ client: ctx.client, confirm: true, pollAttempts: 4, pollIntervalMs: 1 }),
    );
    expect(result.status).toBe("created");
    expect(result.created).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.captured).toBe(true);
    expect(result.name).toBe("owner");
    expect(result.instance).toBe(HOST);
    expect(result.updateSet).toEqual({ sysId: SET, name: SET_NAME });
    expect(result.note).toMatch(/Capture row 'sys_index_/);
    expect(result.unverified).toEqual(["uniqueness-enforced"]);
  });

  it("an index that exists but was not captured is created:true, captured:false", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[], [indexRow("owner", "[owner]")]],
      captures: [[]],
    });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("created");
    expect(result.captured).toBe(false);
    expect(result.unverified).toContain("update-set-capture");
    expect(result.note).toMatch(/NOT found in update set/);
  });

  it("a capture row in a DIFFERENT set does not count", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[], [indexRow("owner", "[owner]")]],
      captures: [[captureRow(["owner"], "ffffffffffffffffffffffffffffffff")]],
    });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.captured).toBe(false);
  });

  it("a failed capture read is reported, not thrown", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[], [indexRow("owner", "[owner]")]],
      captureError: new Error("HTTP 403"),
    });
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("created");
    expect(result.captured).toBe(false);
    expect(result.note).toMatch(/HTTP 403/);
  });
});

describe("createIndex — helpers", function () {
  it("readCurrentSet accepts sys_id, sysId, nested and name-only shapes", function () {
    expect(readCurrentSet({ sys_id: SET, name: "x" })).toEqual({ sysId: SET, name: "x" });
    expect(readCurrentSet({ sysId: SET })).toEqual({ sysId: SET, name: "" });
    expect(readCurrentSet({ result: { update_set: { value: SET, display_value: "y" } } })).toEqual({ sysId: SET, name: "y" });
    expect(readCurrentSet({ name: "only" })).toEqual({ sysId: "", name: "only" });
    expect(readCurrentSet(null)).toEqual({ sysId: "", name: "" });
    expect(readCurrentSet("str")).toEqual({ sysId: "", name: "" });
  });

  it("a name-only read-back that matches the requested set counts as pinned", async function () {
    okSession();
    var ctx = liveClient({
      indexes: [[], [indexRow("owner", "[owner]")]],
      captures: [[captureRow(["owner"])]],
    });
    ctx.client.claude.currentUpdateSet = async function () {
      return { sys_id: "", name: SET_NAME };
    };
    var result = await createIndex(base({ client: ctx.client, confirm: true }));
    expect(result.status).toBe("created");
  });

  it("captureRowName follows the platform's sys_index_<table>_<cols> form", function () {
    expect(
      captureRowName("x_cadso_journey_instance_step", [
        "sys_created_on",
        "status",
        "version_step",
        "version",
      ]),
    ).toBe(
      "sys_index_x_cadso_journey_instance_step_sys_created_on_status_version_step_version",
    );
  });

  it("parseAjaxAnswer entity-decodes the answer attribute", function () {
    expect(parseAjaxAnswer(CAN_CREATE_OK)).toBe('{"canCreate":true,"errorCode":null}');
    expect(parseAjaxAnswer(SCHEDULE_OK)).toBe("");
    expect(parseAjaxAnswer("")).toBe("");
  });

  it("parseCanCreate never throws on garbage", function () {
    expect(parseCanCreate("").parseError).toMatch(/empty/);
    expect(parseCanCreate("<html>").parseError).toMatch(/not JSON/);
    expect(parseCanCreate("[]").canCreate).toBe(false);
    expect(parseCanCreate('{"canCreate":"true"}').canCreate).toBe(false);
    var ok = parseCanCreate('{"canCreate":true,"errorCode":null}');
    expect(ok.canCreate).toBe(true);
    expect(ok.errorCode).toBe("");
    expect(ok.parseError).toBe("");
  });
});
