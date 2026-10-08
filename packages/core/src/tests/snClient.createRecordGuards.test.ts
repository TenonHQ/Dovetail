// snClient.createRecord refuses tables the generic createRecord op cannot
// write correctly. sys_update_set: the op never sets `application`, so the set
// would land in the session app — callers must use createUpdateSet instead.
// The refusal happens before any HTTP call.

jest.mock("../Logger", function () {
  return {
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      getLogLevel: function () { return "debug"; },
    },
  };
});

jest.mock("../FileLogger", function () {
  return { fileLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
});

import { snClient } from "../snClient";

describe("snClient.createRecord guards", function () {
  it("rejects sys_update_set without posting, pointing at dove createUpdateSet", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    var post = jest.spyOn(c.client, "post");

    await expect(
      c.createRecord({ table: "sys_update_set", fields: { name: "Foo" }, scope: "x_s" }),
    ).rejects.toThrow(/dove createUpdateSet/);
    expect(post).not.toHaveBeenCalled();
  });

  it("still rejects sys_db_object without posting", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    var post = jest.spyOn(c.client, "post");

    await expect(
      c.createRecord({ table: "sys_db_object", fields: { name: "x_t" } }),
    ).rejects.toThrow(/sys_db_object/);
    expect(post).not.toHaveBeenCalled();
  });
});
