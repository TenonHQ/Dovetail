// `dove switchUpdateSet --sysId <id>` selects the in-progress set by exact
// sys_id, so two same-named sets can't be confused. Invalid ids are refused
// before any query; an id with no in-progress match is an error, not a prompt.

var mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
  getLogLevel: jest.fn().mockReturnValue("info"),
};

jest.mock("../Logger", function () {
  return { logger: mockLogger };
});

jest.mock("../commands", function () {
  return { setLogLevel: jest.fn() };
});

var mockWriteRouting = jest.fn().mockReturnValue(true);
jest.mock("../updateSetConfig", function () {
  return { writeUpdateSetRouting: mockWriteRouting };
});

jest.mock("inquirer", function () {
  return { prompt: jest.fn() };
});

var TARGET_ID = "0123456789abcdef0123456789abcdef";
var SCOPE_SYS_ID = "scopeSysId0000000000000000000001";

var mockGet = jest.fn();
var mockClient = {
  getScopeId: jest.fn(),
  changeUpdateSet: jest.fn(),
  getCurrentUpdateSet: jest.fn(),
  getScopeById: jest.fn(),
  client: { get: mockGet },
};

jest.mock("../snClient", function () {
  return {
    defaultClient: jest.fn(function () { return mockClient; }),
    unwrapSNResponse: jest.fn(async function (p: Promise<{ data: { result: unknown } }>) {
      var resp = await p;
      return resp.data.result;
    }),
    unwrapTableAPIFirstItem: jest.fn(),
  };
});

import inquirer from "inquirer";
import { switchUpdateSetCommand } from "../updateSetCommands";

function axiosResult<T>(result: T): Promise<{ data: { result: T } }> {
  return Promise.resolve({ data: { result: result } });
}

describe("switchUpdateSet --sysId", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    mockClient.getScopeId.mockReturnValue(axiosResult([{ sys_id: SCOPE_SYS_ID }]));
    mockClient.changeUpdateSet.mockResolvedValue({ data: { result: { message: "Success" } } });
    mockClient.getCurrentUpdateSet.mockResolvedValue({ data: { result: { sysId: TARGET_ID } } });
  });

  it("queries by exact sys_id within the scope and switches to that set", async function () {
    mockGet.mockReturnValue(
      axiosResult([{ sys_id: TARGET_ID, name: "Dup Name", application: { value: SCOPE_SYS_ID, display_value: "App" } }]),
    );

    await switchUpdateSetCommand({ sysId: TARGET_ID, scope: "x_app", logLevel: "info" });

    expect(mockGet).toHaveBeenCalledTimes(1);
    var query = mockGet.mock.calls[0][1].params.sysparm_query;
    expect(query).toBe("state=in progress^application=" + SCOPE_SYS_ID + "^sys_id=" + TARGET_ID);
    expect(mockClient.changeUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ sysId: TARGET_ID }),
    );
    expect(mockWriteRouting).toHaveBeenCalledWith({ scope: "x_app", sysId: TARGET_ID, name: "Dup Name" });
    expect(inquirer.prompt).not.toHaveBeenCalled();
  });

  it("refuses a malformed sys_id before querying", async function () {
    await expect(
      switchUpdateSetCommand({ sysId: "abc^name=x", scope: "x_app", logLevel: "info" }),
    ).rejects.toThrow(/No update set selected/);

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockClient.changeUpdateSet).not.toHaveBeenCalled();
  });

  it("errors (no prompt, no switch) when no in-progress set has that sys_id", async function () {
    mockGet.mockReturnValue(axiosResult([]));

    await expect(
      switchUpdateSetCommand({ sysId: TARGET_ID, scope: "x_app", logLevel: "info" }),
    ).rejects.toThrow(/No update set selected/);

    expect(mockClient.changeUpdateSet).not.toHaveBeenCalled();
    expect(inquirer.prompt).not.toHaveBeenCalled();
  });
});
