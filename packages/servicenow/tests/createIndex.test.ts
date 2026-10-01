/**
 * createIndex — the write side of the index capability.
 *
 * The form session is MOCKED here on purpose. Replaying `.do` forms is privileged
 * platform behaviour a unit test cannot exercise; what a unit test CAN pin is every
 * decision around it — validation, the dry-run/confirm gate, idempotency, the field
 * overlay the form receives, and the refusal to call anything created that was not
 * read back. Those are the parts that go wrong silently.
 *
 * The contract this pins:
 *   - DRY-RUN IS THE DEFAULT and is PURE: without confirm:true nothing is sent and
 *     nothing is even READ.
 *   - identifiers are validated before anything touches a query or the form's
 *     comma-separated field list.
 *   - an index over exactly those columns already present short-circuits to
 *     `already-exists` with NO form session opened.
 *   - the POST carries the instance's own contract: sys_action=create_index,
 *     sysparm_index_table, sysparm_fields, and sysparm_unique_index_SKIP present
 *     ONLY when unique (an unticked checkbox is absent, never "off").
 *   - a read-back that never sees the index is a FAILURE, not a caveat.
 *   - `name` is REFUSED, because the platform form has no name input.
 *   - "uniqueness-enforced" is in `unverified` on every status.
 */

import { makeMockClient } from "./mockClient";
import type { ServiceNowClient } from "../src/client";

var openFormSession = jest.fn();
var getFormPage = jest.fn();
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
    getFormPage: function (...args: Array<unknown>) {
      return getFormPage(...args);
    },
    postForm: function (...args: Array<unknown>) {
      return postForm(...args);
    },
  };
});

// Imported AFTER the mock is registered.
/* eslint-disable @typescript-eslint/no-var-requires */
import { createIndex } from "../src/table/createIndex";
import type { CreateIndexParams } from "../src/table/createIndex";

var TABLE = "x_cadso_core_u_smoke_test_ct4";
var HOST = "example-instance.service-now.com";

function indexRow(name: string, columns: string, table: string = TABLE) {
  return {
    table_name: table,
    index_name: name,
    column_names: columns,
    access_method: "btree",
  };
}

function okSession() {
  openFormSession.mockResolvedValue({ ck: "CK", jar: {} });
  getFormPage.mockResolvedValue({
    status: 200,
    location: "",
    fields: { sysparm_ck: "FRESHCK", sysparm_stack: "no" },
    formAction: "/index_creator_dialog.do",
    html: "<form action=\"/index_creator_dialog.do\"></form>",
  });
  postForm.mockResolvedValue({ status: 200, location: "", body: "ok" });
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
      // The poll is exercised with a zero-ish wall clock so the suite stays fast.
      pollAttempts: 2,
      pollIntervalMs: 1,
    },
    over,
  ) as CreateIndexParams;
}

beforeEach(function () {
  openFormSession.mockReset();
  getFormPage.mockReset();
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

  it("refuses --name, because the platform form has no name input", async function () {
    await expect(
      createIndex(base({ name: "idx_owner", confirm: true })),
    ).rejects.toThrow(/refusing to set an index name/);
  });

  it("validates before ANY request, even on the live path", async function () {
    okSession();
    var ctx = makeMockClient({
      query: async function () {
        return [];
      },
    });
    await expect(
      createIndex(
        base({ client: ctx.client, columns: ["phone;DROP"], confirm: true }),
      ),
    ).rejects.toThrow();
    expect(ctx.calls.tableQuery).toHaveLength(0);
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
    var ctx = makeMockClient({
      query: async function () {
        return [];
      },
    });
    var result = await createIndex(base({ client: ctx.client }));
    expect(result.status).toBe("dry-run");
    expect(result.created).toBe(false);
    expect(result.verified).toBe(false);
    expect(ctx.calls.tableQuery).toHaveLength(0);
    expect(openFormSession).not.toHaveBeenCalled();
    expect(postForm).not.toHaveBeenCalled();
  });

  it("dryRun:true wins over confirm:true", async function () {
    okSession();
    var ctx = makeMockClient({
      query: async function () {
        return [];
      },
    });
    var result = await createIndex(
      base({ client: ctx.client, confirm: true, dryRun: true }),
    );
    expect(result.status).toBe("dry-run");
    expect(ctx.calls.tableQuery).toHaveLength(0);
    expect(postForm).not.toHaveBeenCalled();
  });

  it("the dry-run note states the index is not captured in an update set", async function () {
    var result = await createIndex(base());
    expect(result.note).toMatch(/NOT captured in an update set/);
    expect(result.unverified).toContain("uniqueness-enforced");
  });
});

describe("createIndex — idempotency", function () {
  it("short-circuits to already-exists without opening a form session", async function () {
    okSession();
    var ctx = makeMockClient({
      query: async function () {
        return [indexRow("owner", "[owner]"), indexRow("PRIMARY", "[sys_id]")];
      },
    });
    var result = await createIndex(
      base({ client: ctx.client, columns: ["owner"], confirm: true }),
    );
    expect(result.status).toBe("already-exists");
    expect(result.created).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.name).toBe("owner");
    expect(openFormSession).not.toHaveBeenCalled();
    expect(postForm).not.toHaveBeenCalled();
  });

  it("matches on the EXACT parsed column list, not a substring", async function () {
    okSession();
    var ctx = makeMockClient({
      query: async function () {
        // "[owner_id]" contains "owner" — a substring test would green-light it.
        return [indexRow("owner_id", "[owner_id]")];
      },
    });
    postForm.mockResolvedValue({ status: 200, location: "", body: "ok" });
    var result = await createIndex(
      base({
        client: ctx.client,
        columns: ["owner"],
        confirm: true,
        pollAttempts: 1,
        pollIntervalMs: 1,
      }),
    );
    expect(result.status).not.toBe("already-exists");
    expect(postForm).toHaveBeenCalled();
  });

  it("treats a different column ORDER as a different index", async function () {
    okSession();
    var ctx = makeMockClient({
      query: async function () {
        return [indexRow("ba", "[b,a]")];
      },
    });
    var result = await createIndex(
      base({
        client: ctx.client,
        columns: ["a", "b"],
        confirm: true,
        pollAttempts: 1,
        pollIntervalMs: 1,
      }),
    );
    expect(result.status).not.toBe("already-exists");
  });

  it("refuses to write when v_db_index cannot be read", async function () {
    okSession();
    var ctx = makeMockClient({
      query: async function () {
        throw new Error("HTTP 403 Failed API level ACL Validation");
      },
    });
    var result = await createIndex(
      base({ client: ctx.client, confirm: true }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/403/);
    expect(postForm).not.toHaveBeenCalled();
  });
});

describe("createIndex — the form payload", function () {
  function clientSeeing(sequence: Array<Array<Record<string, string>>>) {
    var call = 0;
    return makeMockClient({
      query: async function () {
        var rows = sequence[Math.min(call, sequence.length - 1)];
        call += 1;
        return rows;
      },
    });
  }

  it("posts the instance's own create_index contract", async function () {
    okSession();
    var ctx = clientSeeing([[], [indexRow("a_b", "[a,b]")]]);
    var result = await createIndex(
      base({
        client: ctx.client,
        columns: ["a", "b"],
        confirm: true,
        pollAttempts: 2,
        pollIntervalMs: 1,
      }),
    );
    expect(result.status).toBe("created");
    var fields = postForm.mock.calls[0][3] as Record<string, string>;
    expect(fields.sys_action).toBe("create_index");
    expect(fields.sysparm_index_table).toBe(TABLE);
    expect(fields.sysparm_table_name).toBe(TABLE);
    expect(fields.sysparm_fields).toBe("a,b");
    // The harvested token must ride the POST — a form save without it is rejected.
    expect(fields.sysparm_ck).toBe("FRESHCK");
  });

  it("omits the unique checkbox entirely when the index is not unique", async function () {
    okSession();
    var ctx = clientSeeing([[], [indexRow("owner", "[owner]")]]);
    await createIndex(base({ client: ctx.client, confirm: true }));
    var fields = postForm.mock.calls[0][3] as Record<string, string>;
    expect(
      Object.prototype.hasOwnProperty.call(fields, "sysparm_unique_index_SKIP"),
    ).toBe(false);
  });

  it("sends the unique checkbox as 'on' when unique is requested", async function () {
    okSession();
    var ctx = clientSeeing([[], [indexRow("owner", "[owner]")]]);
    await createIndex(
      base({ client: ctx.client, confirm: true, unique: true }),
    );
    var fields = postForm.mock.calls[0][3] as Record<string, string>;
    expect(fields.sysparm_unique_index_SKIP).toBe("on");
  });

  it("sends the access method only when one is given", async function () {
    okSession();
    var ctx = clientSeeing([[], [indexRow("owner", "[owner]")]]);
    await createIndex(
      base({ client: ctx.client, confirm: true, accessMethod: "btree" }),
    );
    var fields = postForm.mock.calls[0][3] as Record<string, string>;
    expect(fields.sysparm_access_method).toBe("btree");
  });

  it("never posts to an absolute form action — the session must stay on-instance", async function () {
    openFormSession.mockResolvedValue({ ck: "CK", jar: {} });
    getFormPage.mockResolvedValue({
      status: 200,
      location: "",
      fields: { sysparm_ck: "FRESHCK" },
      formAction: "https://evil.example/steal",
      html: "",
    });
    postForm.mockResolvedValue({ status: 200, location: "", body: "ok" });
    var ctx = clientSeeing([[], [indexRow("owner", "[owner]")]]);
    await createIndex(base({ client: ctx.client, confirm: true }));
    expect(postForm.mock.calls[0][2]).toBe("/index_creator_dialog.do");
  });
});

describe("createIndex — the read-back is the proof", function () {
  it("fails when the index never appears within the poll budget", async function () {
    okSession();
    var ctx = makeMockClient({
      query: async function () {
        return [indexRow("PRIMARY", "[sys_id]")];
      },
    });
    var result = await createIndex(
      base({
        client: ctx.client,
        confirm: true,
        pollAttempts: 3,
        pollIntervalMs: 1,
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.created).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.note).toMatch(/NO matching index appeared/);
    expect(result.note).toMatch(/3 checks/);
  });

  it("reports created only with a read-back row, and uses the INSTANCE's name", async function () {
    okSession();
    var call = 0;
    var ctx = makeMockClient({
      query: async function () {
        call += 1;
        // Absent on the idempotency read and the first poll; present on the second.
        return call >= 3 ? [indexRow("owner", "[owner]")] : [];
      },
    });
    var result = await createIndex(
      base({
        client: ctx.client,
        confirm: true,
        pollAttempts: 4,
        pollIntervalMs: 1,
      }),
    );
    expect(result.status).toBe("created");
    expect(result.created).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.name).toBe("owner");
    expect(result.instance).toBe(HOST);
    expect(result.note).toMatch(/NOT captured in an update set/);
    expect(result.unverified).toContain("uniqueness-enforced");
  });

  it("fails with the login diagnosis when the form session cannot be opened", async function () {
    openFormSession.mockRejectedValue(
      new Error("form login failed — the instance bounced to '/session_timeout.do'"),
    );
    var ctx = makeMockClient({
      query: async function () {
        return [];
      },
    });
    var result = await createIndex(
      base({ client: ctx.client, confirm: true }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/session_timeout/);
    expect(postForm).not.toHaveBeenCalled();
  });

  it("fails when the creator page does not render", async function () {
    openFormSession.mockResolvedValue({ ck: "CK", jar: {} });
    getFormPage.mockResolvedValue({
      status: 302,
      location: "/welcome.do",
      fields: {},
      formAction: "",
      html: "",
    });
    var ctx = makeMockClient({
      query: async function () {
        return [];
      },
    });
    var result = await createIndex(
      base({ client: ctx.client, confirm: true }),
    );
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(302);
    expect(result.note).toMatch(/welcome\.do/);
    expect(postForm).not.toHaveBeenCalled();
  });

  it("never claims uniqueness on any status", async function () {
    okSession();
    var ctx = makeMockClient({
      query: async function () {
        return [indexRow("owner", "[owner]")];
      },
    });
    var dry = await createIndex(base());
    var exists = await createIndex(base({ client: ctx.client, confirm: true }));
    [dry, exists].forEach(function (r) {
      expect(r.unverified).toContain("uniqueness-enforced");
    });
  });
});
