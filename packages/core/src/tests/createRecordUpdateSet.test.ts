// Tests for `dove create sys_update_set` (TenonHQ/Dovetail#231).
//
// A generic record insert into sys_update_set lets ServiceNow default
// `application` to the API session's current app, so `--scope` was silently
// ignored. `dove create` must instead:
//   1. route sys_update_set through snClient.createUpdateSet with the resolved
//      scope's sys_id — and NOT call the generic createRecord;
//   2. read the set back and exit non-zero, naming requested vs. actual scope
//      and the set sys_id, when the application does not match;
//   3. require --scope for sys_update_set in --ci mode;
//   4. leave every other table on the generic createRecord path.
//
// Everything is mocked — no instance is contacted.

var logMessages: { level: string; msg: string }[] = [];
function pushLog(level: string) {
  return jest.fn(function (msg: string) {
    logMessages.push({ level: level, msg: String(msg) });
  });
}

jest.mock("../Logger", function () {
  return {
    logger: {
      setLogLevel: jest.fn(),
      success: pushLog("success"),
      info: pushLog("info"),
      error: pushLog("error"),
      warn: pushLog("warn"),
      debug: jest.fn(),
      getLogLevel: function () { return "info"; },
    },
  };
});

jest.mock("../FileLogger", function () {
  return {
    fileLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
});

jest.mock("../commands", function () {
  return { setLogLevel: jest.fn() };
});

jest.mock("../config", function () {
  return {
    getManifest: jest.fn(function () { return undefined; }),
    isMultiScopeManifest: jest.fn(function () { return false; }),
    getConfig: jest.fn(function () { return {}; }),
    getSourcePathForScope: jest.fn(function () { return "/virtual/src"; }),
  };
});

var mockSyncManifest = jest.fn().mockResolvedValue(undefined);
jest.mock("../appUtils", function () {
  return { syncManifest: mockSyncManifest };
});

jest.mock("../projectFiles", function () {
  return {
    getUpdateSetsConfigPath: jest.fn(function () {
      return "/nonexistent/dove-create-update-set-test/.dove-update-sets.json";
    }),
  };
});

jest.mock("inquirer", function () {
  return { prompt: jest.fn() };
});

interface MockClient {
  getScopeId: jest.Mock;
  getScopeById: jest.Mock;
  getUpdateSetById: jest.Mock;
  getInProgressUpdateSetsByName: jest.Mock;
  createUpdateSet: jest.Mock;
  createRecord: jest.Mock;
}

var mockClient: MockClient = {
  getScopeId: jest.fn(),
  getScopeById: jest.fn(),
  getUpdateSetById: jest.fn(),
  getInProgressUpdateSetsByName: jest.fn(),
  createUpdateSet: jest.fn(),
  createRecord: jest.fn(),
};

jest.mock("../snClient", function () {
  return {
    defaultClient: jest.fn(function () { return mockClient; }),
    // Mirror the real unwrapSNResponse: await the axios promise, return .data.result
    unwrapSNResponse: jest.fn(async function (p: Promise<{ data: { result: unknown } }>) {
      var resp = await p;
      return resp.data.result;
    }),
  };
});

import { createRecordCommand, UpdateSetScopeMismatchError } from "../createRecordCommand";

function axiosResult<T>(result: T): Promise<{ status: number; data: { result: T } }> {
  return Promise.resolve({ status: 200, data: { result: result } });
}

var REQUESTED_SCOPE = "x_cadso_journey";
var REQUESTED_SCOPE_SYS_ID = "journeyScopeSysId0000000000000001";
var SESSION_SCOPE = "x_cadso_core";
var SESSION_SCOPE_SYS_ID = "coreScopeSysId00000000000000000002";
var SET_SYS_ID = "updateSetSysId000000000000000000ab";

class ExitSignal extends Error {
  code: number | undefined;
  constructor(code: number | undefined) {
    super("process.exit(" + code + ")");
    this.code = code;
  }
}

describe("dove create sys_update_set (#231)", function () {
  var exitSpy: jest.SpyInstance;

  beforeEach(function () {
    logMessages = [];
    jest.clearAllMocks();
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(function (code?: string | number | null) {
        throw new ExitSignal(typeof code === "number" ? code : undefined);
      });

    mockClient.getScopeId.mockImplementation(function (scopeName: string) {
      if (scopeName === REQUESTED_SCOPE) {
        return axiosResult([{ sys_id: REQUESTED_SCOPE_SYS_ID }]);
      }
      return axiosResult([]);
    });
    mockClient.getScopeById.mockImplementation(function (sysId: string) {
      if (sysId === SESSION_SCOPE_SYS_ID) {
        return axiosResult([{ sys_id: SESSION_SCOPE_SYS_ID, scope: SESSION_SCOPE }]);
      }
      if (sysId === REQUESTED_SCOPE_SYS_ID) {
        return axiosResult([{ sys_id: REQUESTED_SCOPE_SYS_ID, scope: REQUESTED_SCOPE }]);
      }
      return axiosResult([]);
    });
    mockClient.getInProgressUpdateSetsByName.mockImplementation(function () {
      return axiosResult([]);
    });
    mockClient.createUpdateSet.mockImplementation(function (name: string, scopeSysId: string) {
      return axiosResult({ sys_id: SET_SYS_ID, name: name, application: scopeSysId });
    });
    mockClient.createRecord.mockResolvedValue({
      status: 200,
      data: { result: { sys_id: "genericSysId", table: "sys_script_include", name: "Generic" } },
    });
  });

  afterEach(function () {
    exitSpy.mockRestore();
  });

  function errorText(): string {
    return logMessages
      .filter(function (m) { return m.level === "error"; })
      .map(function (m) { return m.msg; })
      .join("\n");
  }

  it("routes through createUpdateSet with the requested scope and never calls the generic insert", async function () {
    // Table API shape for a reference field without display values: { value, link }
    mockClient.getUpdateSetById.mockReturnValue(
      axiosResult([{ sys_id: SET_SYS_ID, application: { value: REQUESTED_SCOPE_SYS_ID, link: "ref-link" } }]),
    );

    await createRecordCommand({
      table: "sys_update_set",
      name: "Journey - Fix 231",
      scope: REQUESTED_SCOPE,
      field: ["description=Issue 231 regression set"],
      ci: true,
      logLevel: "info",
    });

    expect(mockClient.createUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockClient.createUpdateSet).toHaveBeenCalledWith(
      "Journey - Fix 231",
      REQUESTED_SCOPE_SYS_ID,
      "Issue 231 regression set",
    );
    expect(mockClient.createRecord).not.toHaveBeenCalled();
    expect(mockClient.getUpdateSetById).toHaveBeenCalledWith(SET_SYS_ID);
    expect(mockSyncManifest).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    var success = logMessages.filter(function (m) { return m.level === "success"; });
    expect(success.length).toBe(1);
    expect(success[0].msg).toContain(SET_SYS_ID);
    expect(success[0].msg).toContain(REQUESTED_SCOPE);
  });

  it("prints an activation hint keyed on the new set's sys_id, not its name", async function () {
    mockClient.getUpdateSetById.mockReturnValue(
      axiosResult([{ sys_id: SET_SYS_ID, application: { value: REQUESTED_SCOPE_SYS_ID } }]),
    );

    await createRecordCommand({
      table: "sys_update_set",
      name: "Journey - Fix 231",
      scope: REQUESTED_SCOPE,
      ci: true,
      logLevel: "info",
    });

    expect(mockClient.getInProgressUpdateSetsByName).toHaveBeenCalledWith(
      "Journey - Fix 231",
      REQUESTED_SCOPE_SYS_ID,
    );
    var hint = logMessages.filter(function (m) {
      return m.level === "info" && m.msg.indexOf("switchUpdateSet") !== -1;
    });
    expect(hint).toHaveLength(1);
    expect(hint[0].msg).toContain("--sysId " + SET_SYS_ID);
    expect(hint[0].msg).toContain("-s " + REQUESTED_SCOPE);
    expect(hint[0].msg).not.toContain("--name");
  });

  it("refuses (exit 1, no op call) when an in-progress set with the same name already exists in the scope", async function () {
    mockClient.getInProgressUpdateSetsByName.mockImplementation(function () {
      return axiosResult([{ sys_id: "existingSetSysId000000000000000cd", name: "Journey - Fix 231" }]);
    });

    await expect(
      createRecordCommand({
        table: "sys_update_set",
        name: "Journey - Fix 231",
        scope: REQUESTED_SCOPE,
        ci: true,
        logLevel: "info",
      }),
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockClient.createUpdateSet).not.toHaveBeenCalled();
    expect(mockClient.createRecord).not.toHaveBeenCalled();
    expect(logMessages.filter(function (m) { return m.level === "success"; })).toHaveLength(0);
    expect(errorText()).toContain("already exists");
    expect(errorText()).toContain("existingSetSysId000000000000000cd");
  });

  it("fails loudly (exit 1, no success) when the created set's application is not the requested scope", async function () {
    // The op "succeeded" but the set landed in the session's current app.
    mockClient.createUpdateSet.mockImplementation(function (name: string) {
      return axiosResult({ sys_id: SET_SYS_ID, name: name, application: SESSION_SCOPE_SYS_ID });
    });
    mockClient.getUpdateSetById.mockReturnValue(
      axiosResult([{ sys_id: SET_SYS_ID, application: { value: SESSION_SCOPE_SYS_ID } }]),
    );

    await expect(
      createRecordCommand({
        table: "sys_update_set",
        name: "Journey - Fix 231",
        scope: REQUESTED_SCOPE,
        ci: true,
        logLevel: "info",
      }),
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockClient.createRecord).not.toHaveBeenCalled();
    expect(logMessages.filter(function (m) { return m.level === "success"; })).toHaveLength(0);

    var errors = errorText();
    expect(errors).toContain(SET_SYS_ID);
    expect(errors).toContain(REQUESTED_SCOPE);
    expect(errors).toContain(SESSION_SCOPE);
    expect(errors).toContain(REQUESTED_SCOPE_SYS_ID);
    expect(errors).toContain(SESSION_SCOPE_SYS_ID);
  });

  it("falls back to the op response when read-back is unavailable, and still catches a mismatch", async function () {
    mockClient.createUpdateSet.mockImplementation(function (name: string) {
      return axiosResult({ sys_id: SET_SYS_ID, name: name, application: SESSION_SCOPE_SYS_ID });
    });
    mockClient.getUpdateSetById.mockReturnValue(Promise.reject(new Error("read denied")));

    await expect(
      createRecordCommand({
        table: "sys_update_set",
        name: "Journey - Fix 231",
        scope: REQUESTED_SCOPE,
        ci: true,
        logLevel: "info",
      }),
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorText()).toContain(SESSION_SCOPE);
    expect(errorText()).toContain(SET_SYS_ID);
  });

  it("refuses to verify-by-assumption: no application from any source is a failure, not a success", async function () {
    mockClient.createUpdateSet.mockImplementation(function (name: string) {
      return axiosResult({ sys_id: SET_SYS_ID, name: name });
    });
    mockClient.getUpdateSetById.mockReturnValue(axiosResult([{ sys_id: SET_SYS_ID }]));

    await expect(
      createRecordCommand({
        table: "sys_update_set",
        name: "Journey - Fix 231",
        scope: REQUESTED_SCOPE,
        ci: true,
        logLevel: "info",
      }),
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorText()).toContain("could not be verified");
    expect(logMessages.filter(function (m) { return m.level === "success"; })).toHaveLength(0);
  });

  it("requires --scope for sys_update_set in --ci mode before touching the instance", async function () {
    await expect(
      createRecordCommand({
        table: "sys_update_set",
        name: "No Scope Set",
        ci: true,
        logLevel: "info",
      }),
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockClient.createUpdateSet).not.toHaveBeenCalled();
    expect(mockClient.createRecord).not.toHaveBeenCalled();
    expect(mockClient.getScopeId).not.toHaveBeenCalled();
    expect(errorText()).toContain("--scope");
  });

  it("errors when the requested scope does not exist on the instance", async function () {
    await expect(
      createRecordCommand({
        table: "sys_update_set",
        name: "Ghost Scope Set",
        scope: "x_cadso_nope",
        ci: true,
        logLevel: "info",
      }),
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(mockClient.createUpdateSet).not.toHaveBeenCalled();
    expect(errorText()).toContain("x_cadso_nope");
  });

  it("keeps every other table on the generic createRecord path", async function () {
    await createRecordCommand({
      table: "sys_script_include",
      name: "Generic",
      scope: REQUESTED_SCOPE,
      ci: true,
      refresh: false,
      logLevel: "info",
    });

    expect(mockClient.createRecord).toHaveBeenCalledTimes(1);
    expect(mockClient.createRecord).toHaveBeenCalledWith({
      table: "sys_script_include",
      fields: { name: "Generic" },
      scope: REQUESTED_SCOPE,
      update_set_sys_id: undefined,
    });
    expect(mockClient.createUpdateSet).not.toHaveBeenCalled();
    expect(mockClient.getScopeId).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exposes a typed mismatch error carrying both scopes", function () {
    var err = new UpdateSetScopeMismatchError({
      updateSetName: "n",
      updateSetSysId: "s",
      requestedScope: REQUESTED_SCOPE,
      requestedScopeSysId: REQUESTED_SCOPE_SYS_ID,
      actualScope: SESSION_SCOPE,
      actualScopeSysId: SESSION_SCOPE_SYS_ID,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UpdateSetScopeMismatchError");
    expect(err.requestedScope).toBe(REQUESTED_SCOPE);
    expect(err.actualScope).toBe(SESSION_SCOPE);
    expect(err.message).toContain("MIS-SCOPED");
  });
});
