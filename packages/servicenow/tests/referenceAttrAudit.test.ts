import { referenceAttrAudit } from "../src/table";
import type { ServiceNowClient } from "../src/client";

function auditClient(rows: Array<Record<string, string>>) {
  var calls: Array<{
    table: string;
    query: string;
    offset: number;
    limit: number;
  }> = [];
  var c = {
    table: {
      query: async function (
        table: string,
        query: string,
        opts: { limit: number; offset: number },
      ) {
        calls.push({
          table: table,
          query: query,
          offset: opts.offset,
          limit: opts.limit,
        });
        return rows.slice(opts.offset, opts.offset + opts.limit);
      },
    },
  };
  return { client: c as unknown as ServiceNowClient, calls: calls };
}

function refRow(i: number, attributes: string): Record<string, string> {
  return {
    sys_id: "S" + i,
    name: "x_cadso_t" + (i % 3),
    element: "ref_" + i,
    sys_scope: "SCOPE",
    reference: "sys_user",
    attributes: attributes,
  };
}

describe("referenceAttrAudit", function () {
  it("lists the reference columns that lack readonly_clickthrough=true", async function () {
    var t = auditClient([
      refRow(1, "readonly_clickthrough=true"),
      refRow(2, ""),
      refRow(3, "ref_auto_completer=X,readonly_clickthrough=false"),
      refRow(4, "no_sort,readonly_clickthrough=true"),
    ]);
    var result = await referenceAttrAudit({
      client: t.client,
      scopePrefix: "x_cadso_",
    });
    expect(result.total).toBe(4);
    expect(result.compliant).toBe(2);
    expect(result.attribute).toBe("readonly_clickthrough=true");
    expect(
      result.missing.map(function (m) {
        return m.element;
      }),
    ).toEqual(["ref_2", "ref_3"]);
    expect(t.calls[0].query).toBe(
      "internal_type=reference^nameSTARTSWITHx_cadso_^active=true^ORDERBYsys_id",
    );
  });
  it("pages past the 1000-row cap with a stable order", async function () {
    var rows: Array<Record<string, string>> = [];
    for (var i = 0; i < 2350; i += 1)
      rows.push(refRow(i, i % 2 === 0 ? "readonly_clickthrough=true" : ""));
    var t = auditClient(rows);
    var result = await referenceAttrAudit({
      client: t.client,
      scopePrefix: "x_cadso_",
    });
    expect(
      t.calls.map(function (c) {
        return c.offset;
      }),
    ).toEqual([0, 1000, 2000]);
    expect(result.total).toBe(2350);
    expect(result.missing).toHaveLength(1175);
    expect(result.truncated).toBe(false);
  });
  it("skips the table's own collection row (empty element)", async function () {
    var t = auditClient([
      { sys_id: "C", name: "x_cadso_t", element: "", attributes: "" },
      refRow(1, ""),
    ]);
    var result = await referenceAttrAudit({
      client: t.client,
      scopePrefix: "x_cadso_",
    });
    expect(result.total).toBe(1);
  });
  it("audits a custom attribute", async function () {
    var t = auditClient([
      refRow(1, "readonly_clickthrough=true"),
      refRow(2, "no_sort=true"),
    ]);
    var result = await referenceAttrAudit({
      client: t.client,
      scopePrefix: "x_cadso_",
      attribute: "no_sort=true",
    });
    expect(
      result.missing.map(function (m) {
        return m.element;
      }),
    ).toEqual(["ref_1"]);
  });
  it("refuses a prefix that could rewrite the query, before any network call", async function () {
    var t = auditClient([]);
    await expect(
      referenceAttrAudit({ client: t.client, scopePrefix: "x_^ORname!=" }),
    ).rejects.toThrow(/must be a table-name prefix/);
    await expect(
      referenceAttrAudit({ client: t.client, scopePrefix: "" }),
    ).rejects.toThrow(/must be a table-name prefix/);
    expect(t.calls).toHaveLength(0);
  });
});
