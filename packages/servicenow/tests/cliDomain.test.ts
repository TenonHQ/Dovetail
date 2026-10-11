/**
 * dove-sn --domain on set-field / create-record / add-choices / remove-choices — flag
 * parsing, the global default, refusal of a bare or invalid value (exit 1, before any
 * client exists), and exit 2 when the domain read-back fails.
 *
 * The client factory is mocked to hand back an in-memory client and the env loader is
 * mocked out, so no credentials are read and nothing reaches the network.
 */
import type { ServiceNowClient } from "../src/client";
import { makeMockClient } from "./mockClient";

var mockClientRef: { current: ServiceNowClient | null } = { current: null };
var createClientCalls = { count: 0 };

jest.mock("../src/client", () => ({
  createClient: jest.fn(() => {
    createClientCalls.count += 1;
    if (!mockClientRef.current) throw new Error("test did not install a mock client");
    return mockClientRef.current;
  }),
  resolveFlowAuth: jest.fn(),
  isProcessflowPath: jest.fn(),
  PROCESSFLOW_PATH_PREFIX: "/api/now/processflow/",
}));
jest.mock("../src/loadEnv", () => ({
  loadEnvFile: jest.fn(),
  SN_CONNECTION_KEYS: [],
}));
jest.mock("../src/mcp/server", () => ({
  runStdio: jest.fn(),
  runSmoke: jest.fn(),
}));

import { main, parseArgs, domainFlag } from "../src/cli";

var US = "059d29ea47bb4310357690d3706d43c7";
var BR = "a01405ee33d8e2107b18bc534d5c7baa";
var CHILD = "09ff3d105f231000b12e3572f2b4775d";
var OVERRIDE = "33ad616647f38310276209d3706d4319";

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: Array<string>): Promise<Captured> {
  var out = { stdout: "", stderr: "" };
  var outSpy = jest.spyOn(process.stdout, "write").mockImplementation(function (chunk: string | Uint8Array): boolean {
    out.stdout += String(chunk);
    return true;
  });
  var errSpy = jest.spyOn(process.stderr, "write").mockImplementation(function (chunk: string | Uint8Array): boolean {
    out.stderr += String(chunk);
    return true;
  });
  try {
    var code = await main(argv);
    return { code: code, stdout: out.stdout, stderr: out.stderr };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

/** A global BR; `override` makes every write spawn a child-domain override (the incident). */
function installBr(override: boolean) {
  var record: Record<string, any> = { sys_id: BR, script: "old", sys_domain: "global", sys_overrides: "" };
  var overrides: Array<any> = [];
  var ctx = makeMockClient({
    query: async function (_t: string, query?: string) {
      if (query === "sys_id=" + BR) return [Object.assign({}, record)];
      if (query === "sys_overridesIN" + BR) return overrides.slice();
      return [];
    },
    write: function (_op: string, params: any) {
      if (override) {
        overrides.push({ sys_id: OVERRIDE, sys_domain: CHILD, sys_overrides: BR });
      } else {
        Object.assign(record, params.fields);
      }
      return { sys_id: BR, domain: { requested: params.domain, applied: params.domain, previous: CHILD } };
    },
  });
  mockClientRef.current = ctx.client;
  return ctx;
}

beforeEach(function () {
  mockClientRef.current = null;
  createClientCalls.count = 0;
});

describe("domainFlag", function () {
  it("absent → no domain (the verb defaults to global)", function () {
    var p = parseArgs(["set-field", "--table", "t"]);
    expect(domainFlag("set-field", p.flags, p.bare)).toEqual({});
  });

  it("normalises global / a sys_id", function () {
    var p = parseArgs(["set-field", "--domain", "GLOBAL"]);
    expect(domainFlag("set-field", p.flags, p.bare)).toEqual({ domain: "global" });
    var q = parseArgs(["set-field", "--domain=" + CHILD.toUpperCase()]);
    expect(domainFlag("set-field", q.flags, q.bare)).toEqual({ domain: CHILD });
  });

  it("refuses a bare --domain (it would otherwise arrive as the string \"true\")", function () {
    var p = parseArgs(["set-field", "--domain", "--table", "t"]);
    expect(domainFlag("set-field", p.flags, p.bare).error).toMatch(/--domain needs a value/);
  });

  it("refuses a value that is neither global nor a sys_id", function () {
    var p = parseArgs(["set-field", "--domain", "Default"]);
    expect(domainFlag("set-field", p.flags, p.bare).error).toMatch(/set-field: --domain must be "global" or a 32-character domain sys_id/);
  });
});

describe("dove-sn set-field --domain", function () {
  var base = ["set-field", "--table", "sys_script", "--sys-id", BR, "--fields", "script=new", "--update-set", US];

  it("defaults to global in the request and exits 0 on an in-place update", async function () {
    var ctx = installBr(false);
    var r = await run(base);
    expect(r.code).toBe(0);
    expect(ctx.calls.pushWithUpdateSet[0].domain).toBe("global");
  });

  it("passes --domain through", async function () {
    var ctx = installBr(false);
    var r = await run(base.concat(["--domain", CHILD]));
    expect(ctx.calls.pushWithUpdateSet[0].domain).toBe(CHILD);
    expect(r.code).toBe(0);
  });

  it("exits 2 with a DOMAIN CHECK message when an override is created", async function () {
    installBr(true);
    var r = await run(base.concat(["--domain", CHILD]));
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/\[failed\]/);
    expect(r.stdout).toMatch(/DOMAIN CHECK FAILED/);
  });

  it("exits 1 on a bad --domain before any client is built", async function () {
    var r = await run(base.concat(["--domain", "Default"]));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--domain must be/);
    expect(createClientCalls.count).toBe(0);
  });

  it("exits 1 on a bare --domain", async function () {
    var r = await run(base.concat(["--domain"]));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--domain needs a value/);
  });
});

describe("dove-sn create-record --domain", function () {
  var NEW = "1234567890abcdef1234567890abcdef";
  function install(stored: string) {
    var ctx = makeMockClient({
      query: async function (_t: string, query?: string) {
        return query === "sys_id=" + NEW ? [{ sys_id: NEW, name: "rule", sys_domain: stored }] : [];
      },
      write: function () {
        return { sys_id: NEW, domain: { requested: "global", applied: "global", previous: CHILD } };
      },
    });
    mockClientRef.current = ctx.client;
    return ctx;
  }
  var base = ["create-record", "--table", "sys_script", "--scope", "x_s", "--fields", "name=rule", "--update-set", US];

  it("defaults to global and exits 0 when the row lands there", async function () {
    var ctx = install("global");
    var r = await run(base);
    expect(r.code).toBe(0);
    expect(ctx.calls.createRecord[0].domain).toBe("global");
  });

  it("exits 2 when the row lands in another domain", async function () {
    install(CHILD);
    var r = await run(base);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/landed in sys_domain/);
  });

  it("exits 1 on a bad --domain", async function () {
    var r = await run(base.concat(["--domain", "x"]));
    expect(r.code).toBe(1);
    expect(createClientCalls.count).toBe(0);
  });
});

describe("dove-sn add-choices --domain", function () {
  var NEWCH = "dddddddddddddddddddddddddddddddd";
  function install(createdDomain: string) {
    var ctx = makeMockClient({
      query: async function (table: string, query?: string) {
        if (table === "sys_dictionary") return [{ sys_id: "dict1", name: "x_t", element: "state", choice: "3", sys_scope: "scope_core" }];
        if (table === "sys_update_set") return [{ sys_id: "us1", name: "set", state: "in progress", application: "scope_core" }];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_s", name: "x_s" }];
        if (table === "sys_choice" && query === "sys_idIN" + NEWCH) return [{ sys_id: NEWCH, sys_domain: createdDomain }];
        return [];
      },
      write: function (_op: string, params: any) {
        return { sys_id: NEWCH, domain: { requested: params.domain, applied: params.domain, previous: CHILD } };
      },
    });
    mockClientRef.current = ctx.client;
    return ctx;
  }
  var base = ["add-choices", "--table", "x_t", "--column", "state", "--update-set", "us1", "--choices", "b=B"];

  it("defaults to global and exits 0", async function () {
    var ctx = install("global");
    var r = await run(base);
    expect(r.code).toBe(0);
    expect(ctx.calls.createRecord[0].domain).toBe("global");
    expect(r.stdout).toMatch(/Session domain: global/);
  });

  it("exits 2 and names the problem when a choice lands in another domain", async function () {
    install(CHILD);
    var r = await run(base.concat(["--domain", "global"]));
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/\[DOMAIN PROBLEM\]/);
    expect(r.stderr).toMatch(/DOMAIN CHECK FAILED/);
  });

  it("exits 1 on a bare --domain", async function () {
    var r = await run(base.concat(["--domain"]));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--domain needs a value/);
  });
});
