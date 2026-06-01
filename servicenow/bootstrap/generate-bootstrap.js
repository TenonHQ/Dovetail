const fs=require("fs"),path=require("path");
const SRC="/tmp/dovetail-recreate";
const REPO="/Users/dman89/Documents/Tenon/CTO/Craftsman/Dovetail/servicenow";
const APP="5f33b5d433d90b147b18bc534d5c7bf6";
const ROLE_SYS_ID="db33f5d433d90b147b18bc534d5c7b06";

const GUARD = "\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n";
function injectGuard(script){
  const anchor = "response) {";
  const i = script.indexOf(anchor);
  if (i === -1) throw new Error("no anchor in op script");
  const cut = i + anchor.length;
  return script.slice(0,cut) + GUARD + script.slice(cut);
}

const opFiles = fs.readdirSync(SRC).filter(f=>f.startsWith("OP_")&&f.endsWith(".js"));
const ops = opFiles.map(f=>{
  const meta = JSON.parse(fs.readFileSync(path.join(SRC,f.replace(/\.js$/,".meta.json")),"utf8"));
  const isSinc = f.indexOf("sincronia")>-1;
  const wsd = JSON.parse(fs.readFileSync(path.join(SRC, isSinc?"WSD_Sincronia.json":"WSD_Dovetail.json"),"utf8"));
  return {
    sys_id: meta.sys_id, name: meta.name, http_method: meta.http_method,
    relative_path: meta.relative_path, wsd: wsd.sys_id,
    script: injectGuard(fs.readFileSync(path.join(SRC,f),"utf8"))
  };
});
const wsdD = JSON.parse(fs.readFileSync(path.join(SRC,"WSD_Dovetail.json"),"utf8"));
const wsdS = JSON.parse(fs.readFileSync(path.join(SRC,"WSD_Sincronia.json"),"utf8"));
const wsds = [wsdD,wsdS].map(w=>({sys_id:w.sys_id,name:w.name,namespace:w.namespace,service_id:w.service_id,base_uri:w.base_uri}));

function siRead(name){return fs.readFileSync(path.join(REPO,"sys_script_include",name+".js"),"utf8");}
const sis = [
  {sys_id:"b9aa2facc30cc710d4ddf1db0501317a", name:"SincUtils", api_name:"global.SincUtils", script:siRead("SincUtils")},
  {sys_id:"884a272c334887107b18bc534d5c7b97", name:"SincUtilsMS", api_name:"global.SincUtilsMS", script:siRead("SincUtilsMS")}
];

const DATA = JSON.stringify({app:APP,role_sys_id:ROLE_SYS_ID,wsds,sis,ops},null,2);

const OUT = `/* ============================================================================
 * Dovetail Server Bootstrap - ONE-SHOT
 * ----------------------------------------------------------------------------
 * Stands up the Dovetail + Sincronia Scripted REST APIs INSIDE the Dovetail
 * scoped application, gated on the dovetail_user role.
 *
 * HOW TO RUN (honors "create in scope, update set open first"):
 *   1. Studio -> open the **Dovetail** app  (sys_app ${APP})
 *   2. Create + make active a NEW update set while Dovetail is the current app
 *   3. Create a **Fix Script** inside the Dovetail app, paste this whole file, Run
 *
 * The script HARD-ABORTS unless it is running in the Dovetail scope with an
 * active (non-Default) update set, so it cannot land records in the wrong place.
 * Idempotent: re-running updates in place (records keep their original sys_ids).
 * ==========================================================================*/
(function dovetailBootstrap() {
  var D = ${DATA};

  // ---- Guardrail 1: must run in the Dovetail application scope ----
  var curApp = gs.getCurrentApplicationId();
  if (curApp !== D.app) {
    gs.error("[dovetail-bootstrap] ABORT - not in the Dovetail scope. current=" + curApp +
             ". Open the Dovetail app in Studio and run this as a Fix Script.");
    return;
  }

  // ---- Guardrail 2: an explicit update set must be active ----
  var curUs = gs.getPreference("sys_update_set");
  if (!curUs) { gs.error("[dovetail-bootstrap] ABORT - no active update set."); return; }
  var usGr = new GlideRecord("sys_update_set");
  if (!usGr.get(curUs)) { gs.error("[dovetail-bootstrap] ABORT - current update set not found: " + curUs); return; }
  if (usGr.getValue("name") === "Default" || usGr.getValue("state") !== "in progress") {
    gs.error("[dovetail-bootstrap] ABORT - refuse to write into '" + usGr.getValue("name") +
             "'. Create a dedicated in-progress update set while in the Dovetail app first.");
    return;
  }
  var usApp = usGr.getValue("application");
  if (usApp !== D.app) {
    gs.warn("[dovetail-bootstrap] WARNING - update set application=" + usApp +
            " (expected " + D.app + "). Proceeding; verify the set is Dovetail-scoped.");
  }
  gs.info("[dovetail-bootstrap] scope OK, update set '" + usGr.getValue("name") + "' active. Starting.");

  function upsert(table, sysId, fields, label) {
    var gr = new GlideRecord(table);
    var verb;
    if (gr.get(sysId)) { verb = "updated"; }
    else { gr.initialize(); gr.setNewGuidValue(sysId); verb = "inserted"; }
    for (var k in fields) gr.setValue(k, fields[k]);
    var ok = (verb === "updated") ? gr.update() : gr.insert();
    gs.info("[dovetail-bootstrap]   " + verb + " " + table + " :: " + label + (ok ? "" : "  <FAILED>"));
    return ok;
  }

  // ---- 1. dovetail_user role (create if missing) ----
  upsert("sys_user_role", D.role_sys_id, { name: "dovetail_user", description: "Dovetail Scripted REST API access" }, "dovetail_user");

  // ---- 2. script includes ----
  D.sis.forEach(function(si) {
    upsert("sys_script_include", si.sys_id,
      { name: si.name, api_name: si.api_name, active: "true", access: "public", script: si.script }, si.name);
  });

  // ---- 3. web service definitions (paths preserved; ACL off, role enforced in-script) ----
  D.wsds.forEach(function(w) {
    upsert("sys_ws_definition", w.sys_id,
      { name: w.name, namespace: w.namespace, service_id: w.service_id, base_uri: w.base_uri,
        active: "true", enforce_acl: "false" }, w.name + " (" + w.base_uri + ")");
  });

  // ---- 4. operations (dovetail_user gate injected; snc_internal_role requirement removed) ----
  D.ops.forEach(function(o) {
    upsert("sys_ws_operation", o.sys_id,
      { name: o.name, web_service_definition: o.wsd, http_method: o.http_method,
        relative_path: o.relative_path, operation_script: o.script, active: "true",
        requires_authentication: "true", requires_acl_authorization: "false",
        requires_snc_internal_role: "false" },
      o.http_method + " " + o.relative_path);
  });

  gs.info("[dovetail-bootstrap] DONE. Grant 'dovetail_user' to the integration user, then: " +
          "curl -u USER:PASS https://<instance>/api/cadso/dovetail/currentUpdateSet");
})();
`;
const dest="/tmp/dovetail-server-bootstrap.fix.js";
fs.writeFileSync(dest,OUT);
console.log("Wrote",dest,"("+OUT.length+" bytes)");
console.log("Operations:",ops.length,"| WSDs:",wsds.length,"| Script includes:",sis.length);
