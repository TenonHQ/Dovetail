/**
 * dove-sn delete-record — CLI exit codes.
 *
 * The client factory is mocked to hand back an in-memory client and the env loader is
 * mocked out, so no credentials are read and nothing reaches the network. Exit 1 means
 * "bad args / no such record / unusable update set"; a delete the server refused (row
 * still present), a pin that did not take, a delete captured outside the requested update
 * set, and an unreadable capture are exit 2. A delete verified gone AND captured in the set
 * is exit 0, and so is one on a table that writes no update-set capture at all (note only).
 */
import type { ServiceNowClient } from "../src/client";
import { makeMockClient } from "./mockClient";

var mockClientRef: { current: ServiceNowClient | null } = { current: null };

jest.mock("../src/client", () => ({
  createClient: jest.fn(() => {
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

import { main } from "../src/cli";

var US = "20756100334a03107b18bc534d5c7b2b";
var ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
var DEFAULT_SET = "fedcba9876543210fedcba9876543210";

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: Array<string>): Promise<Captured> {
  var out = { stdout: "", stderr: "" };
  var outSpy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation(function (chunk: string | Uint8Array): boolean {
      out.stdout += String(chunk);
      return true;
    });
  var errSpy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation(function (chunk: string | Uint8Array): boolean {
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

interface Scenario {
  /** The delete call throws this after (maybe) landing. */
  deleteThrows?: string;
  /** Whether the delete removes the row (and writes its capture row). Default true. */
  removes?: boolean;
  /** changeUpdateSet answers but the current set does not move. */
  pinIgnored?: boolean;
  /** The DELETE capture row lands here whatever the pin says. */
  captureInto?: string;
  /** The table writes no sys_update_xml capture row at all. */
  noCapture?: boolean;
  /** Reading sys_update_xml throws. */
  captureReadThrows?: boolean;
}

/**
 * An in-memory instance: one record on x_t, the requested set (in progress) plus Default,
 * a shared "current set" for changeUpdateSet / currentUpdateSet, and a DELETE capture row
 * written into the current (or forced) set when the delete lands.
 */
function scenarioClient(sc: Scenario) {
  var present = true;
  var current = DEFAULT_SET;
  var captures: Array<Record<string, unknown>> = [];
  var names: Record<string, string> = {};
  names[US] = "Journey set";
  names[DEFAULT_SET] = "Default";
  var ctx = makeMockClient({
    query: async function (table: string, query?: string) {
      if (table === "sys_update_set") {
        var id = (query || "").replace(/^sys_id=/, "");
        return names[id] ? [{ sys_id: id, name: names[id], state: "in progress" }] : [];
      }
      if (table === "sys_update_xml") {
        if (sc.captureReadThrows) throw new Error("SN 403 reading sys_update_xml");
        return captures.slice().reverse();
      }
      if (present && query === "sys_id=" + ID) return [{ sys_id: ID, name: "a" }];
      return [];
    },
  });
  ctx.client.claude.changeUpdateSet = async function (params) {
    ctx.calls.changeUpdateSet.push(params);
    if (!sc.pinIgnored) current = params.sysId;
    return { sys_id: params.sysId };
  };
  ctx.client.claude.currentUpdateSet = async function () {
    return { sys_id: current, name: names[current] || "" };
  };
  ctx.client.claude.deleteRecord = async function (params) {
    ctx.calls.deleteRecord.push(params);
    if (sc.removes !== false) {
      present = false;
      if (!sc.noCapture) captures.push({ name: params.table + "_" + params.sys_id, action: "DELETE", update_set: sc.captureInto || current });
    }
    if (sc.deleteThrows) throw new Error(sc.deleteThrows);
    return { sys_id: params.sys_id };
  };
  return ctx;
}

var ARGS = ["delete-record", "--table", "x_t", "--sys-id", ID, "--update-set", US, "--apply", "--json"];

afterEach(function () {
  mockClientRef.current = null;
});

describe("dove-sn delete-record — exit codes when the delete call throws", function () {
  it("server refusal (SN 500) with the record still present → exit 2, status failed", async function () {
    var ctx = scenarioClient({ deleteThrows: "SN 500 on claude.deleteRecord(x_t) — retries exhausted.", removes: false });
    mockClientRef.current = ctx.client;
    var r = await run(ARGS);
    expect(r.code).toBe(2);
    var parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("failed");
    expect(parsed.verified).toBe(false);
    expect(parsed.note).toContain("SN 500");
    expect(ctx.calls.deleteRecord.length).toBe(1);
  });

  it("transport error (ECONNRESET) after the delete landed → exit 0, status deleted", async function () {
    var ctx = scenarioClient({ deleteThrows: "SN network error on claude.deleteRecord(x_t): read ECONNRESET" });
    mockClientRef.current = ctx.client;
    var r = await run(ARGS);
    expect(r.code).toBe(0);
    var parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("deleted");
    expect(parsed.verified).toBe(true);
    expect(parsed.note).toContain("ECONNRESET");
  });
});

describe("dove-sn delete-record — update set pinned and the capture read back", function () {
  it("deleted AND captured in the requested set → exit 0", async function () {
    var ctx = scenarioClient({});
    mockClientRef.current = ctx.client;
    var r = await run(ARGS);
    expect(r.code).toBe(0);
    var parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("deleted");
    expect(parsed.captured).toBe(true);
    expect(parsed.capturedInto).toEqual({ sysId: US, name: "Journey set" });
    expect(parsed.captureState).toBe("in-set");
  });

  it("deleted but the DELETE row is in another set → exit 2, captured:false", async function () {
    var ctx = scenarioClient({ captureInto: DEFAULT_SET });
    mockClientRef.current = ctx.client;
    var r = await run(ARGS);
    expect(r.code).toBe(2);
    var parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("deleted");
    expect(parsed.captured).toBe(false);
    expect(parsed.capturedInto).toEqual({ sysId: DEFAULT_SET, name: "Default" });
    expect(parsed.captureState).toBe("other-set");
  });

  it("a table with no update-set capture at all → exit 0, captureState none", async function () {
    var ctx = scenarioClient({ noCapture: true });
    mockClientRef.current = ctx.client;
    var r = await run(ARGS);
    expect(r.code).toBe(0);
    var parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("deleted");
    expect(parsed.captured).toBe(false);
    expect(parsed.captureState).toBe("none");
    expect(parsed.note).toMatch(/NOT CAPTURED/);
  });

  it("the capture read-back fails → exit 2, captureState unverified", async function () {
    var ctx = scenarioClient({ captureReadThrows: true });
    mockClientRef.current = ctx.client;
    var r = await run(ARGS);
    expect(r.code).toBe(2);
    var parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("deleted");
    expect(parsed.captureState).toBe("unverified");
  });

  it("the pin does not read back → exit 2 and no delete call", async function () {
    var ctx = scenarioClient({ pinIgnored: true });
    mockClientRef.current = ctx.client;
    var r = await run(ARGS);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).status).toBe("failed");
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("an unknown update set fails the DRY-RUN with exit 1", async function () {
    var ctx = scenarioClient({});
    mockClientRef.current = ctx.client;
    var r = await run(["delete-record", "--table", "x_t", "--sys-id", ID, "--update-set", "99999999999999999999999999999999"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/update set 9+ not found/);
    expect(ctx.calls.changeUpdateSet.length).toBe(0);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("the human-readable line says whether the capture was verified", async function () {
    var ctx = scenarioClient({ captureInto: DEFAULT_SET });
    mockClientRef.current = ctx.client;
    var r = await run(["delete-record", "--table", "x_t", "--sys-id", ID, "--update-set", US, "--apply"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("(Journey set)");
    expect(r.stdout).toContain("NOT captured in that set");
  });
});
