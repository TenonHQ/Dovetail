import {
  setField,
  decodeHtmlEntities,
  hasHtmlEntity,
  readBackMatches,
  verifyReadBack
} from "../src/setField";
import { makeMockClient } from "./mockClient";

var US = "20756100334a03107b18bc534d5c7b2b";

// Build a mock client whose reads are keyed by the exact encoded query string.
function ctxFor(rows: Record<string, Array<any>>) {
  return makeMockClient({
    query: async function (table: string, query?: string) {
      return rows[query || ""] || [];
    }
  });
}

describe("setField", function () {
  it("refuses schema tables", async function () {
    var ctx = ctxFor({});
    await expect(
      setField({ client: ctx.client, table: "sys_db_object", sysId: "x", fields: { name: "y" }, updateSetSysId: US })
    ).rejects.toThrow(/schema table/);
    expect(ctx.calls.pushWithUpdateSet.length).toBe(0);
  });

  it("requires at least one field", async function () {
    var ctx = ctxFor({});
    await expect(
      setField({ client: ctx.client, table: "x_t", sysId: "x", fields: {}, updateSetSysId: US })
    ).rejects.toThrow(/at least one field/);
  });

  it("requires an update set", async function () {
    var ctx = ctxFor({});
    await expect(
      setField({ client: ctx.client, table: "x_t", sysId: "x", fields: { order: "20" } })
    ).rejects.toThrow(/update-set/);
  });

  it("requires a target (sys-id or query)", async function () {
    var ctx = ctxFor({});
    await expect(
      setField({ client: ctx.client, table: "x_t", fields: { order: "20" }, updateSetSysId: US })
    ).rejects.toThrow(/sys-id or --query/);
  });

  it("dry-run reads the current value but does not write", async function () {
    var ctx = ctxFor({ "sys_id=row1": [{ sys_id: "row1", order: "5" }] });
    var r = await setField({ client: ctx.client, table: "x_t", sysId: "row1", fields: { order: "20" }, updateSetSysId: US, dryRun: true });
    expect(r.status).toBe("dry-run");
    expect(r.before.order).toBe("5");
    expect(ctx.calls.pushWithUpdateSet.length).toBe(0);
  });

  it("writes via pushWithUpdateSet and verifies the read-back", async function () {
    var ctx = ctxFor({ "sys_id=row1": [{ sys_id: "row1", order: "20" }] });
    var r = await setField({ client: ctx.client, table: "x_t", sysId: "row1", fields: { order: "20" }, updateSetSysId: US });
    expect(r.status).toBe("applied");
    expect(r.verified).toBe(true);
    expect(ctx.calls.pushWithUpdateSet.length).toBe(1);
    expect(ctx.calls.pushWithUpdateSet[0]).toEqual({
      update_set_sys_id: US,
      table: "x_t",
      record_sys_id: "row1",
      fields: { order: "20" }
    });
  });

  it("reports failed when the read-back does not match", async function () {
    var ctx = ctxFor({ "sys_id=row1": [{ sys_id: "row1", order: "5" }] });
    var r = await setField({ client: ctx.client, table: "x_t", sysId: "row1", fields: { order: "20" }, updateSetSysId: US });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
  });

  it("resolves the target by a single-match query", async function () {
    var ctx = ctxFor({ "name=send_size": [{ sys_id: "row1" }], "sys_id=row1": [{ sys_id: "row1", order: "20" }] });
    var r = await setField({ client: ctx.client, table: "x_t", query: "name=send_size", fields: { order: "20" }, updateSetSysId: US });
    expect(r.status).toBe("applied");
    expect(ctx.calls.pushWithUpdateSet[0].record_sys_id).toBe("row1");
  });

  it("refuses an ambiguous (2+ row) query", async function () {
    var ctx = ctxFor({ "name=dup": [{ sys_id: "a" }, { sys_id: "b" }] });
    await expect(
      setField({ client: ctx.client, table: "x_t", query: "name=dup", fields: { order: "20" }, updateSetSysId: US })
    ).rejects.toThrow(/refine to exactly one/);
    expect(ctx.calls.pushWithUpdateSet.length).toBe(0);
  });
});

describe("read-back entity equivalence helpers (#300)", function () {
  it("decodeHtmlEntities handles decimal, hex and the basic named entities", function () {
    expect(decodeHtmlEntities("contact &#64;tenon")).toBe("contact @tenon");
    expect(decodeHtmlEntities("a &#x40; b")).toBe("a @ b");
    expect(decodeHtmlEntities("&lt;p&gt;Tom &amp; Jerry&lt;/p&gt;")).toBe("<p>Tom & Jerry</p>");
    expect(decodeHtmlEntities('say &quot;hi&quot; &apos;there&apos;')).toBe("say \"hi\" 'there'");
  });

  it("decodeHtmlEntities leaves unknown names and out-of-range code points untouched", function () {
    expect(decodeHtmlEntities("&bogus; &#0; &#1114112; &#xD800;")).toBe("&bogus; &#0; &#1114112; &#xD800;");
    expect(decodeHtmlEntities("no entities here")).toBe("no entities here");
  });

  it("hasHtmlEntity detects a reference and ignores a bare ampersand", function () {
    expect(hasHtmlEntity("a &#64; b")).toBe(true);
    expect(hasHtmlEntity("Tom &amp; Jerry")).toBe(true);
    expect(hasHtmlEntity("Tom & Jerry")).toBe(false);
    expect(hasHtmlEntity("")).toBe(false);
  });

  it("readBackMatches: exact, entity-equivalent, mismatch", function () {
    expect(readBackMatches("35", "35")).toBe("exact");
    expect(readBackMatches("contact @tenon", "contact &#64;tenon")).toBe("entity-equivalent");
    expect(readBackMatches("<p>Tom & Jerry</p>", "<p>Tom &amp; Jerry</p>")).toBe("entity-equivalent");
    // A genuinely different html value still mismatches after decoding.
    expect(readBackMatches("<p>@alpha</p>", "<p>&#64;beta</p>")).toBe("mismatch");
    // Decoding is only attempted when the STORED side carries an entity — the
    // sanitizer's fingerprint — so a plain-string difference stays strict.
    expect(readBackMatches("&#64;", "@")).toBe("mismatch");
    expect(readBackMatches("a", "")).toBe("mismatch");
  });

  it("verifyReadBack reports mismatched and entity-normalized field names", function () {
    var check = verifyReadBack(
      { description: "contact @tenon", order: "35", label: "A" },
      { description: "contact &#64;tenon", order: "35", label: "B" }
    );
    expect(check.verified).toBe(false);
    expect(check.mismatched).toEqual(["label"]);
    expect(check.entityNormalized).toEqual(["description"]);
    var ok = verifyReadBack({ a: "1" }, { a: "1" });
    expect(ok).toEqual({ verified: true, mismatched: [], entityNormalized: [] });
  });
});

describe("setField read-back tolerates the HTML sanitizer (#300)", function () {
  it("verifies when the instance entity-encoded an html value, and names the field", async function () {
    var ctx = ctxFor({
      "sys_id=x": [{ sys_id: "x", description: "contact &#64;tenon" }]
    });
    var r = await setField({
      client: ctx.client, table: "x_t", sysId: "x",
      fields: { description: "contact @tenon" }, updateSetSysId: US
    });
    expect(r.status).toBe("applied");
    expect(r.verified).toBe(true);
    expect(r.note).toMatch(/description: the instance HTML-entity-encoded/);
  });

  it("still fails on a genuinely different html value and names the field", async function () {
    var ctx = ctxFor({
      "sys_id=x": [{ sys_id: "x", description: "<p>&#64;beta</p>" }]
    });
    var r = await setField({
      client: ctx.client, table: "x_t", sysId: "x",
      fields: { description: "<p>@alpha</p>" }, updateSetSysId: US
    });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
    expect(r.note).toMatch(/\(description\)/);
  });
});
