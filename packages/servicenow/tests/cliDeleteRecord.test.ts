/**
 * dove-sn delete-record — CLI exit codes when the delete call itself throws (R-2).
 *
 * The client factory is mocked to hand back an in-memory client and the env loader is
 * mocked out, so no credentials are read and nothing reaches the network. Exit 1 means
 * "bad args / no such record"; a delete the server refused (row still present) must be
 * exit 2, and a delete that landed despite a transport error must be exit 0.
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

/** A client whose delete always throws `message`; `removes` decides if the row goes first. */
function throwingDeleteClient(message: string, removes: boolean) {
  var present = true;
  var ctx = makeMockClient({
    query: async function (_table: string, query?: string) {
      if (present && query === "sys_id=" + ID) return [{ sys_id: ID, name: "a" }];
      return [];
    },
  });
  ctx.client.claude.deleteRecord = async function (params) {
    ctx.calls.deleteRecord.push(params);
    if (removes) present = false;
    throw new Error(message);
  };
  return ctx;
}

var ARGS = ["delete-record", "--table", "x_t", "--sys-id", ID, "--update-set", US, "--apply", "--json"];

afterEach(function () {
  mockClientRef.current = null;
});

describe("dove-sn delete-record — exit codes when the delete call throws", function () {
  it("server refusal (SN 500) with the record still present → exit 2, status failed", async function () {
    var ctx = throwingDeleteClient("SN 500 on claude.deleteRecord(x_t) — retries exhausted.", false);
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
    var ctx = throwingDeleteClient("SN network error on claude.deleteRecord(x_t): read ECONNRESET", true);
    mockClientRef.current = ctx.client;
    var r = await run(ARGS);
    expect(r.code).toBe(0);
    var parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("deleted");
    expect(parsed.verified).toBe(true);
    expect(parsed.note).toContain("ECONNRESET");
  });
});
