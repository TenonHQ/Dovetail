import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import { classifyChunks, hostAssets } from "../src/hostAssets";
import { makeMockClient } from "./mockClient";

var DIST = path.join(__dirname, "fixtures", "host-assets-dist");
var APP = "1234567890abcdef1234567890abcdef";
var M2M = "x_cadso_app_shell_m2m_app_script";
var US = { sys_id: "us1", name: "Work", state: "in progress" };

var ENTRY_NAME = "app_shell_asset:assets/index-a1b2c3d4.js";
var VENDOR_NAME = "app_shell_asset:assets/vendor-e5f6g7h8.js";
var CSS_NAME = "app_shell_asset:assets/index-i9j0k1l2.css";
var HTML_NAME = "app_shell_asset:index.html";

function sha256Of(rel: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(DIST, rel)))
    .digest("hex");
}

/**
 * Build a query handler over seedable instance state. carriers = existing
 * sys_ui_script rows (nameSTARTSWITH lookup); ownedM2m = this app's m2m rows.
 */
function makeQuery(
  state: {
    carriers?: Array<any>;
    ownedM2m?: Array<any>;
    m2mOthers?: Array<any>;
  } = {},
) {
  return async function (table: string, query?: string) {
    var q = query || "";
    if (table === "sys_scope") return [{ sys_id: "scope1" }];
    if (table === "sys_update_set") return [US];
    if (table === "sys_ui_script") {
      if (q.indexOf("nameSTARTSWITH") === 0) return state.carriers || [];
      if (q.indexOf("sys_id=") === 0) {
        var id = q.slice("sys_id=".length);
        var seeded = (state.carriers || []).filter(function (c) {
          return c.sys_id === id;
        });
        if (seeded.length > 0) return seeded;
        return [{ sys_id: id, name: "", script: "", active: "true" }];
      }
      return [];
    }
    if (table === M2M) {
      if (q.indexOf("script=") === 0) return state.m2mOthers || [];
      if (q.indexOf("application=") === 0) return state.ownedM2m || [];
      return [];
    }
    return [];
  };
}

describe("classifyChunks", function () {
  it("names carriers off the exact vite-relative path (hash included)", function () {
    var infos = classifyChunks([
      { viteRelPath: "index.html", ext: "html", isIndexHtml: true },
      {
        viteRelPath: "assets/index-a1b2c3d4.js",
        ext: "js",
        isIndexHtml: false,
      },
      {
        viteRelPath: "assets/vendor-e5f6g7h8.js",
        ext: "js",
        isIndexHtml: false,
      },
      {
        viteRelPath: "assets/index-i9j0k1l2.css",
        ext: "css",
        isIndexHtml: false,
      },
    ]);
    var byPath: Record<string, any> = {};
    infos.forEach(function (i) {
      byPath[i.viteRelPath] = i;
    });
    expect(byPath["index.html"].name).toBe(HTML_NAME);
    expect(byPath["assets/index-a1b2c3d4.js"].name).toBe(ENTRY_NAME);
  });

  it("infers role from the hash-stripped base and assigns gap-free order", function () {
    var infos = classifyChunks([
      {
        viteRelPath: "assets/index-i9j0k1l2.css",
        ext: "css",
        isIndexHtml: false,
      },
      {
        viteRelPath: "assets/vendor-e5f6g7h8.js",
        ext: "js",
        isIndexHtml: false,
      },
      { viteRelPath: "index.html", ext: "html", isIndexHtml: true },
      {
        viteRelPath: "assets/index-a1b2c3d4.js",
        ext: "js",
        isIndexHtml: false,
      },
    ]);
    // Sorted by role priority: index, entry, vendor, style.
    expect(
      infos.map(function (i) {
        return i.role;
      }),
    ).toEqual(["index", "entry", "vendor", "style"]);
    expect(
      infos.map(function (i) {
        return i.order;
      }),
    ).toEqual([0, 1, 2, 3]);
    expect(infos[1].base).toBe("index");
    expect(infos[2].base).toBe("vendor");
  });

  it("maps content types by extension", function () {
    var infos = classifyChunks([
      { viteRelPath: "index.html", ext: "html", isIndexHtml: true },
      { viteRelPath: "assets/a-deadbeef12.js", ext: "js", isIndexHtml: false },
      {
        viteRelPath: "assets/a-deadbeef12.css",
        ext: "css",
        isIndexHtml: false,
      },
    ]);
    var ct: Record<string, string> = {};
    infos.forEach(function (i) {
      ct[i.ext] = i.contentType;
    });
    expect(ct.html).toBe("text/html");
    expect(ct.js).toBe("application/javascript");
    expect(ct.css).toBe("text/css");
  });
});

describe("hostAssets — full deploy to an empty instance", function () {
  it("creates a carrier + attachment + m2m row per chunk and verifies", async function () {
    var ctx = makeMockClient({ query: makeQuery({}) });
    var result = await hostAssets(ctx.client, {
      dir: DIST,
      app: APP,
      scope: "x_cadso_app_shell",
      updateSetSysId: "us1",
    });

    expect(result.dryRun).toBe(false);
    expect(result.chunks).toHaveLength(4);
    result.chunks.forEach(function (c) {
      expect(c.scriptAction).toBe("created");
      expect(c.attachmentAction).toBe("uploaded");
      expect(c.m2mAction).toBe("created");
      expect(c.verified).toBe(true);
    });

    // index.html is ordered first (role "index").
    expect(result.chunks[0].name).toBe(HTML_NAME);
    expect(result.chunks[0].role).toBe("index");

    var scriptCreates = ctx.calls.createRecord.filter(function (c) {
      return c.table === "sys_ui_script";
    });
    var m2mCreates = ctx.calls.createRecord.filter(function (c) {
      return c.table === M2M;
    });
    expect(scriptCreates).toHaveLength(4);
    expect(m2mCreates).toHaveLength(4);
    expect(ctx.calls.attachmentUpload).toHaveLength(4);
    expect(result.pruned).toHaveLength(0);

    // Every write is pinned to the supplied update set.
    scriptCreates.forEach(function (c) {
      expect(c.update_set_sys_id).toBe("us1");
      expect(c.scope).toBe("x_cadso_app_shell");
    });
    // m2m carries the app sys_id, chunk_role and order.
    m2mCreates.forEach(function (c) {
      expect(c.fields.application).toBe(APP);
      expect(typeof c.fields.chunk_role).toBe("string");
      expect(typeof c.fields.order).toBe("string");
    });
  });
});

describe("hostAssets — dry run", function () {
  it("plans every chunk without writing, uploading, or deleting", async function () {
    var ctx = makeMockClient({ query: makeQuery({}) });
    var result = await hostAssets(ctx.client, {
      dir: DIST,
      app: APP,
      scope: "x_cadso_app_shell",
      updateSetSysId: "us1",
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.chunks).toHaveLength(4);
    result.chunks.forEach(function (c) {
      expect(c.scriptAction).toBe("created");
      expect(c.m2mAction).toBe("created");
      expect(c.verified).toBe(false);
    });
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(ctx.calls.attachmentUpload).toHaveLength(0);
  });
});

describe("hostAssets — prune", function () {
  it("removes carriers + m2m rows for chunks no longer in the build", async function () {
    var staleName = "app_shell_asset:assets/old-deadbeef99.js";
    var ctx = makeMockClient({
      query: makeQuery({
        carriers: [
          {
            sys_id: "old1",
            name: staleName,
            script: "x",
            active: "true",
          },
        ],
        ownedM2m: [
          { sys_id: "m2mold", script: "old1", chunk_role: "lazy", order: "9" },
        ],
        m2mOthers: [],
      }),
    });
    var result = await hostAssets(ctx.client, {
      dir: DIST,
      app: APP,
      scope: "x_cadso_app_shell",
      updateSetSysId: "us1",
    });

    expect(result.pruned).toHaveLength(1);
    expect(result.pruned[0].name).toBe(staleName);
    expect(result.pruned[0].scriptDeleted).toBe(true);

    // The stale m2m row and its now-orphaned carrier are both deleted.
    var deletes = ctx.calls.deleteRecord;
    expect(
      deletes.some(function (d) {
        return d.table === M2M && d.sys_id === "m2mold";
      }),
    ).toBe(true);
    expect(
      deletes.some(function (d) {
        return d.table === "sys_ui_script" && d.sys_id === "old1";
      }),
    ).toBe(true);
    // The four new chunks are still created.
    expect(
      ctx.calls.createRecord.filter(function (c) {
        return c.table === "sys_ui_script";
      }),
    ).toHaveLength(4);
  });
});

describe("hostAssets — idempotent bytes", function () {
  it("leaves an attachment in place when the content hash matches", async function () {
    var ctx = makeMockClient({
      query: makeQuery({
        carriers: [
          { sys_id: "s_entry", name: ENTRY_NAME, script: "x", active: "true" },
        ],
      }),
      attachments: async function (params) {
        if (params.sysId === "s_entry") {
          return [
            { sys_id: "att_entry", hash: sha256Of("assets/index-a1b2c3d4.js") },
          ];
        }
        return [];
      },
    });
    var result = await hostAssets(ctx.client, {
      dir: DIST,
      app: APP,
      scope: "x_cadso_app_shell",
      updateSetSysId: "us1",
    });

    var entry = result.chunks.filter(function (c) {
      return c.name === ENTRY_NAME;
    })[0];
    expect(entry.attachmentAction).toBe("unchanged");
    expect(entry.attachmentSysId).toBe("att_entry");
    // Only the other three chunks upload; the entry chunk's bytes are reused.
    expect(ctx.calls.attachmentUpload).toHaveLength(3);
    expect(
      ctx.calls.attachmentUpload.some(function (u) {
        return u.sysId === "s_entry";
      }),
    ).toBe(false);
  });
});

describe("hostAssets — guards", function () {
  it("rejects a non-sys_id app", async function () {
    var ctx = makeMockClient({ query: makeQuery({}) });
    await expect(
      hostAssets(ctx.client, {
        dir: DIST,
        app: "not-a-sys-id",
        scope: "x_cadso_app_shell",
        updateSetSysId: "us1",
      }),
    ).rejects.toThrow(/32-character/);
  });

  it("fails fast on a chunk at/over the serve cap unless allowOversize", async function () {
    var ctx = makeMockClient({ query: makeQuery({}) });
    // maxBytes below the smallest fixture forces the oversize guard.
    await expect(
      hostAssets(ctx.client, {
        dir: DIST,
        app: APP,
        scope: "x_cadso_app_shell",
        updateSetSysId: "us1",
        maxBytes: 1,
      }),
    ).rejects.toThrow(/serve cap/);
  });

  it("warns instead of failing when allowOversize is set", async function () {
    var ctx = makeMockClient({ query: makeQuery({}) });
    var warn = jest.spyOn(console, "warn").mockImplementation(function () {
      return undefined as unknown as void;
    });
    var result = await hostAssets(ctx.client, {
      dir: DIST,
      app: APP,
      scope: "x_cadso_app_shell",
      updateSetSysId: "us1",
      maxBytes: 1,
      allowOversize: true,
    });
    warn.mockRestore();
    expect(result.chunks.length).toBeGreaterThan(0);
  });
});
