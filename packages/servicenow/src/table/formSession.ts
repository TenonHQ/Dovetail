/**
 * Form-login session for ServiceNow `.do` form processors. A table create is NOT
 * a REST insert — it is a `POST /sys_db_object.do` with a `sysparm_ck` (g_ck)
 * that only a form session produces. This ports the proven getSession/scrapeCk/
 * cookie-jar flow from the CTO `sn-undo-default-push` driver to TypeScript.
 *
 * Transport only — the pure payload transforms live in buildTableSave.ts /
 * buildColumnXml.ts. Uses Node 18+ global fetch (the package targets Node >=22).
 * ES6 only, no optional chaining.
 *
 * VALIDATED LIVE 2026-06-13 (tenonworkstudio). setCurrentApplication() puts the
 * session in the target scope before the save (the scope-correctness lever).
 */

/** Resolved instance + credentials for a form session. */
export interface FormAuth {
  /** Host WITHOUT scheme, e.g. "tenonworkstudio.service-now.com". */
  host: string;
  user: string;
  password: string;
}

/** Env precedence mirrors client.ts: explicit > SN_* > SN_DEV_* > SN_PROD_*. */
export function resolveFormAuth(cfg: {
  instance?: string;
  user?: string;
  password?: string;
}): FormAuth {
  var c = cfg || {};
  var rawHost =
    c.instance ||
    process.env.SN_INSTANCE ||
    process.env.SN_DEV_INSTANCE ||
    process.env.SN_PROD_INSTANCE ||
    "";
  if (!rawHost) {
    throw new Error(
      "ServiceNow instance not configured. Set SN_INSTANCE or pass { instance }.",
    );
  }
  var host = rawHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (host.indexOf(".") === -1) host = host.toLowerCase() + ".service-now.com";
  var user =
    c.user ||
    process.env.SN_USER ||
    process.env.SN_DEV_USERNAME ||
    process.env.SN_PROD_USERNAME ||
    "";
  var password =
    c.password ||
    process.env.SN_PASSWORD ||
    process.env.SN_DEV_PASSWORD ||
    process.env.SN_PROD_PASSWORD ||
    "";
  if (!user || !password) {
    throw new Error(
      "ServiceNow credentials missing — set SN_USER/SN_PASSWORD (or SN_DEV_*/SN_PROD_*).",
    );
  }
  return { host: host, user: user, password: password };
}

export interface FormSession {
  ck: string;
  jar: Record<string, string>;
}

type Jar = Record<string, string>;

function base(auth: FormAuth): string {
  return "https://" + auth.host;
}

function jarFrom(res: Response, jar: Jar): Jar {
  var anyHeaders = res.headers as unknown as {
    getSetCookie?: () => Array<string>;
  };
  var setCookies: Array<string> =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : [];
  for (var i = 0; i < setCookies.length; i += 1) {
    var kv = setCookies[i].split(";")[0];
    var eq = kv.indexOf("=");
    if (eq > 0) jar[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return jar;
}

function cookieHeader(jar: Jar): string {
  return Object.keys(jar)
    .map(function (k) {
      return k + "=" + jar[k];
    })
    .join("; ");
}

/** Scrape an authenticated g_ck (or form sysparm_ck) out of a page's HTML. */
export function scrapeCk(html: string): string {
  var m =
    html.match(/var g_ck = ['"]([0-9a-f]{40,})['"]/) ||
    html.match(/window\.g_ck = ['"]([0-9a-f]{40,})['"]/) ||
    html.match(/name="sysparm_ck"\s+value="([0-9a-f]{40,})"/);
  return m ? m[1] : "";
}

/** Form-login (login.do) and return an authenticated { ck, jar }. */
export async function openFormSession(auth: FormAuth): Promise<FormSession> {
  var B = base(auth);
  var jar: Jar = {};
  var res = await fetch(B + "/login.do", {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  jarFrom(res, jar);
  var formCk = scrapeCk(await res.text());
  var body = new URLSearchParams({
    user_name: auth.user,
    user_password: auth.password,
    sysparm_ck: formCk,
    not_important: "",
    sys_action: "sysverb_login",
  }).toString();
  res = await fetch(B + "/login.do", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(jar),
      Accept: "text/html",
    },
    body: body,
    redirect: "manual",
  });
  jarFrom(res, jar);
  var loc = res.headers.get("location");
  if (loc) {
    var url =
      loc.indexOf("http") === 0
        ? loc
        : B + (loc.indexOf("/") === 0 ? loc : "/" + loc);
    res = await fetch(url, {
      headers: { Cookie: cookieHeader(jar), Accept: "text/html" },
      redirect: "manual",
    });
    jarFrom(res, jar);
  }
  res = await fetch(B + "/sys_db_object.do?sys_id=-1&sysparm_stack=no", {
    headers: { Cookie: cookieHeader(jar), Accept: "text/html" },
  });
  jarFrom(res, jar);
  var ck = scrapeCk(await res.text());
  if (!ck)
    throw new Error(
      "form login failed (no authenticated g_ck) — check SN_USER/SN_PASSWORD.",
    );
  return { ck: ck, jar: jar };
}

/**
 * Switch the form session's CURRENT APPLICATION to `appSysId`. A new table's scope
 * is governed by the session's current app, not a form field — and setting
 * `sysparm_transaction_scope` on the POST triggers a cross-scope interstitial that
 * bounces the save to welcome.do. The faithful lever is the same app-picker the UI
 * drives: PUT the Next-Experience concourse picker, which updates both the session's
 * in-memory current app and the `apps.current_app` user preference. Returns true if
 * the picker accepted the switch. Best-effort: a non-2xx is reported, not thrown.
 */
export async function setCurrentApplication(
  auth: FormAuth,
  session: FormSession,
  appSysId: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  if (!appSysId) return { ok: false, status: 0, body: "no appSysId" };
  var B = base(auth);
  var res = await fetch(B + "/api/now/ui/concoursepicker/application", {
    method: "PUT",
    headers: {
      "X-UserToken": session.ck,
      Cookie: cookieHeader(session.jar),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    // The picker's ApplicationProcessor expects `app_id` (a `value` body returns
    // 400 "Missing Application Id").
    body: JSON.stringify({ app_id: appSysId }),
    redirect: "manual",
  });
  jarFrom(res, session.jar);
  var body = "";
  try {
    body = await res.text();
  } catch (e) {
    body = "";
  }
  var ok = res.status >= 200 && res.status < 300;
  return { ok: ok, status: res.status, body: body.slice(0, 200) };
}

/** The fields harvested from the new-record form, plus the discovered list-edit key. */
export interface HarvestedForm {
  fields: Record<string, string>;
  /** The `ni.java...ListEditFormatterAction[sys_db_object.REL:<relId>]` input name, if present. */
  listEditKey: string;
}

/**
 * GET the new sys_db_object form and harvest every hidden/input field the browser
 * would submit (sysparm_ck, sysparm_encoded_record, the dynamic `<sysid>_text`
 * field, every sys_original.* default). The caller overlays capability params onto
 * `fields` before POSTing. NOTE: the new-record (sys_id=-1) form does NOT render
 * related lists, so `listEditKey` is normally empty — the caller falls back to the
 * constant "Table Columns" relId. Validated live 2026-06-13.
 */
export async function getNewRecordForm(
  auth: FormAuth,
  session: FormSession,
): Promise<HarvestedForm> {
  var B = base(auth);
  var res = await fetch(B + "/sys_db_object.do?sys_id=-1&sysparm_stack=no", {
    headers: { Cookie: cookieHeader(session.jar), Accept: "text/html" },
  });
  jarFrom(res, session.jar);
  var html = await res.text();
  var fields = parseFormInputs(html);
  var freshCk = scrapeCk(html);
  if (freshCk) fields["sysparm_ck"] = freshCk;
  var listEditKey = "";
  var keys = Object.keys(fields);
  for (var i = 0; i < keys.length; i += 1) {
    if (keys[i].indexOf("ListEditFormatterAction[sys_db_object.REL:") !== -1) {
      listEditKey = keys[i];
      break;
    }
  }
  return { fields: fields, listEditKey: listEditKey };
}

/**
 * Parse `<input>` (and hidden) name/value pairs out of form HTML. Best-effort —
 * handles double/single-quoted attributes in either order. Exported for testing.
 */
export function parseFormInputs(html: string): Record<string, string> {
  var out: Record<string, string> = {};
  var re = /<input\b[^>]*>/gi;
  var tag;
  while ((tag = re.exec(html)) !== null) {
    var raw = tag[0];
    var name = attr(raw, "name");
    if (!name) continue;
    var value = attr(raw, "value");
    out[name] = value === null ? "" : value;
  }
  return out;
}

function attr(tag: string, name: string): string | null {
  var dq = new RegExp(name + '\\s*=\\s*"([^"]*)"', "i").exec(tag);
  if (dq) return decodeHtml(dq[1]);
  var sq = new RegExp(name + "\\s*=\\s*'([^']*)'", "i").exec(tag);
  if (sq) return decodeHtml(sq[1]);
  return null;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export interface PostResult {
  status: number;
  location: string;
  body: string;
}

/** POST a form-urlencoded field map to a `.do` path. Follows nothing — returns the 302. */
export async function postForm(
  auth: FormAuth,
  session: FormSession,
  path: string,
  fields: Record<string, string>,
): Promise<PostResult> {
  var B = base(auth);
  var params = new URLSearchParams();
  var keys = Object.keys(fields);
  for (var i = 0; i < keys.length; i += 1) {
    params.append(keys[i], fields[keys[i]]);
  }
  var res = await fetch(B + path, {
    method: "POST",
    headers: {
      "X-UserToken": session.ck,
      Cookie: cookieHeader(session.jar),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "text/html",
    },
    body: params.toString(),
    redirect: "manual",
  });
  jarFrom(res, session.jar);
  var location = res.headers.get("location") || "";
  var body = "";
  try {
    body = await res.text();
  } catch (e) {
    body = "";
  }
  return { status: res.status, location: location, body: body };
}
