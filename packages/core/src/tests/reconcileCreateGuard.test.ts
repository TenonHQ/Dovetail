// `dove reconcile --apply` creates net-new branch records through
// snClient.createRecord. A sys_update_set record in the branch must not crash
// the apply or be silently created in the session app: the createRecord guard
// refuses it and the refusal surfaces as a named, per-record failure (which
// applyMode lists and turns into exit code 1).

jest.mock("../Logger", function () {
  return {
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      success: jest.fn(),
      getLogLevel: function () { return "debug"; },
    },
  };
});

jest.mock("../FileLogger", function () {
  return { fileLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
});

jest.mock("../config", function () {
  return {
    getSourcePathForScope: function () {
      return "/nonexistent-reconcile-source";
    },
  };
});

var mockPost = jest.fn();

jest.mock("../snClient", function () {
  var actual = jest.requireActual("../snClient");
  var client = actual.snClient("https://x.service-now.com/", "u", "p");
  client.client.post = mockPost;
  return Object.assign({}, actual, {
    defaultClient: function () {
      return client;
    },
  });
});

import { applyCreates } from "../reconcileCommand";
import { RecordChange } from "../reconcile/types";

describe("reconcile applyCreates with a sys_update_set record", function () {
  it("reports a clear per-record failure and never posts", async function () {
    var change: RecordChange = {
      kind: "create",
      table: "sys_update_set",
      scope: "x_s",
      sys_id: "abc123",
      name: "Foo",
      fieldDeltas: [],
    };

    var outcomes = await applyCreates("x_s", [change], "us1");

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].change.sys_id).toBe("abc123");
    expect(outcomes[0].error).toMatch(/Refusing to insert sys_update_set/);
    expect(outcomes[0].error).toMatch(/dove createUpdateSet/);
    expect(mockPost).not.toHaveBeenCalled();
  });
});
