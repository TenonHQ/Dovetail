/**
 * hostAssets — deploy a pre-built front-end bundle to ServiceNow.
 *
 * For each chunk in a built dist/ (index.html + assets/*.{js,css}) this:
 *   1. Upserts a carrier sys_ui_script named `app_shell_asset:<vite-relative-path>`.
 *      The name carries the rotating hash on purpose — the Scripted REST serving
 *      resource resolves an asset request to its carrier by this exact name, so the
 *      verb's naming MUST match the path the built index.html references, or the
 *      asset 404s on serve.
 *   2. Stores the chunk's bytes as a sys_attachment on that record (the script field
 *      caps at 65 KB; real chunks are far larger). Identical bytes are detected by
 *      SHA-256 and left in place.
 *   3. Wires an x_cadso_app_shell_m2m_app_script row (application, script, chunk_role,
 *      order) so the app shell loads the chunk.
 *   4. Prunes carriers + m2m rows for chunks no longer in the build — hashes rotate
 *      every build, so last build's records would otherwise pile up.
 *
 * The sys_ui_script + m2m writes route through the Dovetail Scripted REST API and are
 * captured in the target update set. Attachments are data, not customizations, so they
 * are not part of the update set. Re-runnable per build, per instance; idempotent for
 * an identical dist/.
 *
 * The serving layer streams each chunk via GlideSysAttachment.getContentStream(), capped
 * at ~5 MB (glide.scriptable.excel.max_file_size). A chunk at/over the cap truncates on
 * serve, so the verb fails fast on an oversize chunk unless allowOversize is set.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import type { ServiceNowClient } from "./client";
import type {
  ChunkInfo,
  ChunkResult,
  ChunkRole,
  HostAssetsParams,
  HostAssetsResult,
  PrunedResult,
} from "./types";

var SCRIPT_TABLE = "sys_ui_script";
var M2M_TABLE = "x_cadso_app_shell_m2m_app_script";
var ASSET_NAME_PREFIX = "app_shell_asset:";
/** ~5 MB serving cap (glide.scriptable.excel.max_file_size). Conservative MiB reading. */
var DEFAULT_MAX_CHUNK_BYTES = 5 * 1024 * 1024;

var CONTENT_TYPES: Record<string, string> = {
  js: "application/javascript",
  css: "text/css",
  html: "text/html",
};

var ROLE_PRIORITY: Record<ChunkRole, number> = {
  index: 0,
  entry: 1,
  vendor: 2,
  router: 3,
  state: 4,
  lazy: 5,
  style: 6,
};

// A trailing `-<hash>` of 8+ url-safe chars (Vite's content hash). Used only to derive
// the base name for role inference — never to name the carrier record.
var HASH_RE = /^(.+)-[A-Za-z0-9_]{8,}$/;

function stripHash(nameNoExt: string): string {
  var m = HASH_RE.exec(nameNoExt);
  return m ? m[1] : nameNoExt;
}

function roleForBase(
  base: string,
  ext: string,
  isIndexHtml: boolean,
): ChunkRole {
  if (isIndexHtml) return "index";
  if (ext === "css") return "style";
  var b = base.toLowerCase();
  if (b === "index" || b === "main" || b === "entry" || b === "app") {
    return "entry";
  }
  if (b.indexOf("vendor") >= 0) return "vendor";
  if (b === "router" || b === "routes" || b === "route") return "router";
  if (
    b === "store" ||
    b === "state" ||
    b === "redux" ||
    b === "pinia" ||
    b === "vuex"
  ) {
    return "state";
  }
  return "lazy";
}

/**
 * Classify build files into ordered ChunkInfo. Pure — no filesystem access — so the
 * naming + role + order logic is unit-testable in isolation.
 */
export function classifyChunks(
  files: Array<{ viteRelPath: string; ext: string; isIndexHtml: boolean }>,
): Array<ChunkInfo> {
  var infos: Array<ChunkInfo> = files.map(function (f) {
    var lowerExt = f.ext.toLowerCase();
    var fileName = f.viteRelPath.split("/").pop() || f.viteRelPath;
    var nameNoExt = fileName.slice(0, fileName.length - (lowerExt.length + 1));
    var base = f.isIndexHtml ? "index" : stripHash(nameNoExt);
    var role = roleForBase(base, lowerExt, f.isIndexHtml);
    return {
      viteRelPath: f.viteRelPath,
      name: ASSET_NAME_PREFIX + f.viteRelPath,
      fileName: fileName,
      base: base,
      ext: lowerExt,
      role: role,
      order: 0,
      contentType: CONTENT_TYPES[lowerExt] || "application/octet-stream",
    };
  });
  // Deterministic order: role priority, then relative path. Gap-free integers.
  infos.sort(function (a, b) {
    var pa = ROLE_PRIORITY[a.role];
    var pb = ROLE_PRIORITY[b.role];
    if (pa !== pb) return pa - pb;
    return a.viteRelPath < b.viteRelPath
      ? -1
      : a.viteRelPath > b.viteRelPath
      ? 1
      : 0;
  });
  infos.forEach(function (info, i) {
    info.order = i;
  });
  return infos;
}

interface LoadedChunk {
  info: ChunkInfo;
  data: Buffer;
}

function readDistChunks(dir: string): Array<LoadedChunk> {
  if (!fs.existsSync(dir)) {
    throw new Error("host-assets: dist directory not found: " + dir);
  }
  var found: Array<{
    viteRelPath: string;
    ext: string;
    isIndexHtml: boolean;
    abs: string;
  }> = [];

  var indexHtml = path.join(dir, "index.html");
  if (fs.existsSync(indexHtml)) {
    found.push({
      viteRelPath: "index.html",
      ext: "html",
      isIndexHtml: true,
      abs: indexHtml,
    });
  }

  var assetsDir = path.join(dir, "assets");
  if (fs.existsSync(assetsDir)) {
    fs.readdirSync(assetsDir).forEach(function (name) {
      var ext = path.extname(name).replace(/^\./, "").toLowerCase();
      if (ext !== "js" && ext !== "css") return;
      found.push({
        viteRelPath: "assets/" + name,
        ext: ext,
        isIndexHtml: false,
        abs: path.join(assetsDir, name),
      });
    });
  }

  if (found.length === 0) {
    throw new Error(
      "host-assets: no index.html or assets/*.{js,css} found under " + dir,
    );
  }

  var infos = classifyChunks(
    found.map(function (f) {
      return {
        viteRelPath: f.viteRelPath,
        ext: f.ext,
        isIndexHtml: f.isIndexHtml,
      };
    }),
  );
  var absByPath: Record<string, string> = {};
  found.forEach(function (f) {
    absByPath[f.viteRelPath] = f.abs;
  });
  return infos.map(function (info) {
    return { info: info, data: fs.readFileSync(absByPath[info.viteRelPath]) };
  });
}

function guardOversize(
  chunks: Array<LoadedChunk>,
  maxBytes: number,
  allowOversize: boolean,
): void {
  var oversize = chunks.filter(function (c) {
    return c.data.length >= maxBytes;
  });
  if (oversize.length === 0) return;
  var detail = oversize
    .map(function (c) {
      return c.info.viteRelPath + " (" + c.data.length + "B)";
    })
    .join(", ");
  var msg =
    "host-assets: " +
    oversize.length +
    " chunk(s) at/over the " +
    maxBytes +
    "B serve cap (glide.scriptable.excel.max_file_size) — these truncate on serve: " +
    detail +
    ". Split deps via Vite manualChunks, or pass allowOversize to proceed anyway.";
  if (!allowOversize) throw new Error(msg);
  // eslint-disable-next-line no-console
  console.warn("[host-assets] WARNING — " + msg);
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

interface ScopeRow {
  sys_id: string;
}
interface UpdateSetRow {
  sys_id: string;
  name: string;
  state: string;
}
interface ScriptRow {
  sys_id: string;
  name: string;
  script: string;
  active: string;
}
interface M2mRow {
  sys_id: string;
  script: string;
  chunk_role: string;
  order: string;
}

async function resolveScopeSysId(
  client: ServiceNowClient,
  namespace: string,
): Promise<string> {
  var rows = await client.table.query<ScopeRow>(
    "sys_scope",
    "scope=" + namespace,
    1,
  );
  if (rows.length === 0) {
    throw new Error(
      "host-assets: scope '" + namespace + "' not found in sys_scope.",
    );
  }
  return rows[0].sys_id;
}

async function fetchUpdateSet(
  client: ServiceNowClient,
  sysId: string,
): Promise<{ sys_id: string; name: string }> {
  var rows = await client.table.query<UpdateSetRow>(
    "sys_update_set",
    "sys_id=" + sysId,
    1,
  );
  if (rows.length === 0) {
    throw new Error("host-assets: update set " + sysId + " not found.");
  }
  var row = rows[0];
  if (row.state && row.state !== "in progress" && row.state !== "in_progress") {
    throw new Error(
      "host-assets: update set " +
        row.name +
        " is '" +
        row.state +
        "' — only an in-progress update set can capture changes.",
    );
  }
  return { sys_id: row.sys_id, name: row.name };
}

function scriptFields(
  info: ChunkInfo,
  scopeSysId: string,
): Record<string, string> {
  return {
    name: info.name,
    // Bytes live on the attachment; the script field caps at 65 KB.
    script:
      "// Hosted front-end asset — bytes stored as a sys_attachment on this record.\n" +
      "// path=" +
      info.viteRelPath +
      " role=" +
      info.role,
    active: "true",
    sys_scope: scopeSysId,
  };
}

function scriptUnchanged(existing: ScriptRow, info: ChunkInfo): boolean {
  var fields = scriptFields(info, existing.sys_id);
  return (
    existing.name === info.name &&
    String(existing.active) === "true" &&
    existing.script === fields.script
  );
}

/** Reconcile one chunk's carrier script + attachment + m2m row. */
async function reconcileChunk(opts: {
  client: ServiceNowClient;
  chunk: LoadedChunk;
  app: string;
  scope: string;
  scopeSysId: string;
  updateSetSysId: string;
  dryRun: boolean;
  scriptByName: Record<string, ScriptRow>;
  m2mByScript: Record<string, M2mRow>;
}): Promise<ChunkResult> {
  var client = opts.client;
  var info = opts.chunk.info;
  var data = opts.chunk.data;
  var dryRun = opts.dryRun;

  // ── carrier sys_ui_script ────────────────────────────────────────────────
  var existingScript = opts.scriptByName[info.name];
  var scriptSysId = existingScript ? existingScript.sys_id : "";
  var scriptAction: ChunkResult["scriptAction"];
  if (!existingScript) {
    scriptAction = "created";
    if (!dryRun) {
      var created = await client.claude.createRecord({
        table: SCRIPT_TABLE,
        fields: scriptFields(info, opts.scopeSysId),
        scope: opts.scope,
        update_set_sys_id: opts.updateSetSysId,
      });
      scriptSysId = created.sys_id;
    }
  } else if (scriptUnchanged(existingScript, info)) {
    scriptAction = "unchanged";
  } else {
    scriptAction = "updated";
    if (!dryRun) {
      await client.claude.pushWithUpdateSet({
        update_set_sys_id: opts.updateSetSysId,
        table: SCRIPT_TABLE,
        record_sys_id: existingScript.sys_id,
        fields: scriptFields(info, opts.scopeSysId),
      });
    }
  }

  // ── attachment (replace by content hash) ──────────────────────────────────
  var attachmentSysId = "";
  var attachmentAction: ChunkResult["attachmentAction"] = "uploaded";
  if (dryRun || !scriptSysId) {
    // Cannot read/write attachments without a concrete record sys_id.
    attachmentAction = existingScript ? "replaced" : "uploaded";
  } else {
    var newHash = sha256Hex(data);
    var existingAtts = await client.attachment.listFor({
      table: SCRIPT_TABLE,
      sysId: scriptSysId,
    });
    var matching = existingAtts.filter(function (a) {
      return a.hash && a.hash.toLowerCase() === newHash;
    });
    if (matching.length > 0) {
      attachmentSysId = matching[0].sys_id;
      attachmentAction = "unchanged";
      // Drop any stale or duplicate attachments so exactly one carrier remains.
      var extras = existingAtts.filter(function (a) {
        return a.sys_id !== matching[0].sys_id;
      });
      for (var e = 0; e < extras.length; e += 1) {
        await client.attachment.remove({ sysId: extras[e].sys_id });
      }
    } else {
      for (var d = 0; d < existingAtts.length; d += 1) {
        await client.attachment.remove({ sysId: existingAtts[d].sys_id });
      }
      var uploaded = await client.attachment.upload({
        table: SCRIPT_TABLE,
        sysId: scriptSysId,
        fileName: info.fileName,
        contentType: info.contentType,
        data: data,
      });
      attachmentSysId = uploaded.sys_id;
      attachmentAction = existingAtts.length > 0 ? "replaced" : "uploaded";
    }
  }

  // ── m2m wiring ────────────────────────────────────────────────────────────
  var existingM2m = scriptSysId ? opts.m2mByScript[scriptSysId] : undefined;
  var m2mSysId = existingM2m ? existingM2m.sys_id : "";
  var m2mAction: ChunkResult["m2mAction"];
  var m2mFields: Record<string, string> = {
    application: opts.app,
    script: scriptSysId,
    chunk_role: info.role,
    order: String(info.order),
    sys_scope: opts.scopeSysId,
  };
  if (existingM2m) {
    var m2mChanged =
      existingM2m.chunk_role !== info.role ||
      String(existingM2m.order) !== String(info.order);
    m2mAction = m2mChanged ? "updated" : "unchanged";
    if (m2mChanged && !dryRun) {
      await client.claude.pushWithUpdateSet({
        update_set_sys_id: opts.updateSetSysId,
        table: M2M_TABLE,
        record_sys_id: existingM2m.sys_id,
        fields: { chunk_role: info.role, order: String(info.order) },
      });
    }
  } else {
    m2mAction = "created";
    if (!dryRun && scriptSysId) {
      var m2mCreated = await client.claude.createRecord({
        table: M2M_TABLE,
        fields: m2mFields,
        scope: opts.scope,
        update_set_sys_id: opts.updateSetSysId,
      });
      m2mSysId = m2mCreated.sys_id;
    }
  }

  // ── read-back verify ──────────────────────────────────────────────────────
  var verified = false;
  if (!dryRun && scriptSysId) {
    var back = await client.table.query<ScriptRow>(
      SCRIPT_TABLE,
      "sys_id=" + scriptSysId,
      1,
    );
    var atts = await client.attachment.listFor({
      table: SCRIPT_TABLE,
      sysId: scriptSysId,
    });
    verified = back.length > 0 && atts.length > 0;
  }

  return {
    name: info.name,
    viteRelPath: info.viteRelPath,
    base: info.base,
    role: info.role,
    order: info.order,
    contentType: info.contentType,
    bytes: data.length,
    scriptSysId: scriptSysId,
    scriptAction: scriptAction,
    attachmentSysId: attachmentSysId,
    attachmentAction: attachmentAction,
    m2mSysId: m2mSysId,
    m2mAction: m2mAction,
    verified: verified,
  };
}

/** Remove carriers + m2m rows for chunks no longer in the build. */
async function pruneRemoved(opts: {
  client: ServiceNowClient;
  app: string;
  dryRun: boolean;
  keepNames: Record<string, boolean>;
  ownedM2m: Array<M2mRow>;
  scriptById: Record<string, ScriptRow>;
}): Promise<Array<PrunedResult>> {
  var client = opts.client;
  var pruned: Array<PrunedResult> = [];
  for (var i = 0; i < opts.ownedM2m.length; i += 1) {
    var row = opts.ownedM2m[i];
    var scriptId = String(row.script);
    var script = opts.scriptById[scriptId];
    var name = script ? script.name : "";
    // Carrier still in the build (by name) — keep it.
    if (name && opts.keepNames[name]) continue;

    var scriptDeleted = false;
    if (!opts.dryRun) {
      // Unwire this app first.
      await client.claude.deleteRecord({
        table: M2M_TABLE,
        sys_id: row.sys_id,
      });
      // Delete the carrier only if no other app's m2m still references it.
      if (scriptId) {
        var others = await client.table.query<{ sys_id: string }>(
          M2M_TABLE,
          "script=" + scriptId + "^application!=" + opts.app,
          1,
        );
        if (others.length === 0) {
          var atts = await client.attachment.listFor({
            table: SCRIPT_TABLE,
            sysId: scriptId,
          });
          for (var a = 0; a < atts.length; a += 1) {
            await client.attachment.remove({ sysId: atts[a].sys_id });
          }
          await client.claude.deleteRecord({
            table: SCRIPT_TABLE,
            sys_id: scriptId,
          });
          scriptDeleted = true;
        }
      }
    }
    pruned.push({
      name: name || "(unknown)",
      scriptSysId: scriptId,
      m2mSysId: row.sys_id,
      scriptDeleted: scriptDeleted,
    });
  }
  return pruned;
}

/**
 * Deploy a built dist/ to ServiceNow as app-shell carrier scripts + attachments + m2m
 * wiring. Idempotent; re-running an identical dist/ reports every chunk unchanged.
 */
export async function hostAssets(
  client: ServiceNowClient,
  params: HostAssetsParams,
): Promise<HostAssetsResult> {
  if (!params.dir) throw new Error("host-assets: dir is required.");
  if (!/^[0-9a-f]{32}$/i.test(params.app || "")) {
    throw new Error(
      "host-assets: app must be a 32-character application record sys_id.",
    );
  }
  if (!params.scope) {
    throw new Error("host-assets: scope is required (e.g. x_cadso_app_shell).");
  }

  var dryRun = params.dryRun === true;
  var maxBytes =
    typeof params.maxBytes === "number" && params.maxBytes > 0
      ? params.maxBytes
      : DEFAULT_MAX_CHUNK_BYTES;

  var chunks = readDistChunks(params.dir);
  guardOversize(chunks, maxBytes, params.allowOversize === true);

  var scopeSysId = await resolveScopeSysId(client, params.scope);

  var updateSetSysId = params.updateSetSysId || "";
  var updateSetName = "";
  if (updateSetSysId) {
    var us = await fetchUpdateSet(client, updateSetSysId);
    updateSetName = us.name;
  } else {
    var cur = await client.claude.currentUpdateSet(params.scope);
    updateSetSysId = cur.sys_id;
    updateSetName = cur.name;
  }
  if (!updateSetSysId) {
    throw new Error(
      "host-assets: could not resolve a target update set for scope " +
        params.scope +
        ".",
    );
  }

  // Existing state: every asset carrier (global, by name prefix) and this app's wiring.
  var allCarriers = await client.table.query<ScriptRow>(
    SCRIPT_TABLE,
    "nameSTARTSWITH" + ASSET_NAME_PREFIX,
    2000,
  );
  var scriptByName: Record<string, ScriptRow> = {};
  var scriptById: Record<string, ScriptRow> = {};
  allCarriers.forEach(function (s) {
    scriptByName[s.name] = s;
    scriptById[s.sys_id] = s;
  });

  var ownedM2m = await client.table.query<M2mRow>(
    M2M_TABLE,
    "application=" + params.app,
    2000,
  );
  var m2mByScript: Record<string, M2mRow> = {};
  ownedM2m.forEach(function (r) {
    m2mByScript[String(r.script)] = r;
  });

  var results: Array<ChunkResult> = [];
  for (var i = 0; i < chunks.length; i += 1) {
    var r = await reconcileChunk({
      client: client,
      chunk: chunks[i],
      app: params.app,
      scope: params.scope,
      scopeSysId: scopeSysId,
      updateSetSysId: updateSetSysId,
      dryRun: dryRun,
      scriptByName: scriptByName,
      m2mByScript: m2mByScript,
    });
    results.push(r);
  }

  var keepNames: Record<string, boolean> = {};
  chunks.forEach(function (c) {
    keepNames[c.info.name] = true;
  });
  var pruned = await pruneRemoved({
    client: client,
    app: params.app,
    dryRun: dryRun,
    keepNames: keepNames,
    ownedM2m: ownedM2m,
    scriptById: scriptById,
  });

  return {
    scope: params.scope,
    app: params.app,
    updateSet: { sysId: updateSetSysId, name: updateSetName },
    dryRun: dryRun,
    chunks: results,
    pruned: pruned,
  };
}

/** Human-readable one-line-per-chunk summary for the CLI. */
export function formatHostAssetsResult(r: HostAssetsResult): string {
  var lines: Array<string> = [];
  lines.push(
    (r.dryRun ? "[dry-run] " : "") +
      "host-assets → scope=" +
      r.scope +
      " app=" +
      r.app +
      " update-set=" +
      r.updateSet.name +
      " (" +
      r.chunks.length +
      " chunks)",
  );
  r.chunks.forEach(function (c) {
    lines.push(
      "  [" +
        c.role +
        "] " +
        c.viteRelPath +
        " — script:" +
        c.scriptAction +
        " attach:" +
        c.attachmentAction +
        " m2m:" +
        c.m2mAction +
        " (" +
        c.bytes +
        "B)" +
        (r.dryRun ? "" : c.verified ? " ✓" : " ⚠ unverified"),
    );
  });
  if (r.pruned.length > 0) {
    lines.push(
      "  pruned: " +
        r.pruned
          .map(function (p) {
            return p.name + (p.scriptDeleted ? "" : " (m2m only)");
          })
          .join(", "),
    );
  }
  return lines.join("\n");
}
