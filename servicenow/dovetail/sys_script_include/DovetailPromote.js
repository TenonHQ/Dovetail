/**
 * DovetailPromote — ServiceNow Script Include (global scope).
 *
 * The Dovetail engine: retrieve -> preview -> (optionally) commit a named update
 * set from a registered update-set source. Backs POST /api/cadso/dovetail_promote/promote.
 *
 * Recipe validated live on tenonworkyard (see CTO/docs/servicenow-cross-instance-
 * promotion-decision.md, "Phase 1 - Live Validation"). The commit path is a
 * faithful replica of the platform's UpdateSetCommitAjax.commitRemoteUpdateSet.
 *
 * promote(body) ->
 *   body  : { sourceInstance, updateSetName, commit, skipPreviewErrors }
 *   ok    : { remoteUpdateSetSysId, previewErrors[], committed, elapsedMs }
 *   throw : { isDovetailError:true, errorCode, status, message }
 *           errorCode in INVALID_BODY | SOURCE_NOT_FOUND | UPDATE_SET_NOT_FOUND
 *                       | RETRIEVE_FAILED | COMMIT_FAILED
 */
var DovetailPromote = Class.create();
DovetailPromote.prototype = {

  RETRIEVE_TIMEOUT_MS: 240000,
  COMMIT_TIMEOUT_MS: 180000,
  POLL_INTERVAL_MS: 4000,

  initialize: function () {},

  promote: function (body) {
    var startMs = new GlideDateTime().getNumericValue();
    body = body || {};
    var sourceInstance = ("" + (body.sourceInstance || "")).trim();
    var updateSetName = ("" + (body.updateSetName || "")).trim();
    var doCommit = body.commit === true || body.commit === "true";
    var skipList = this._asArray(body.skipPreviewErrors);

    if (!sourceInstance || !updateSetName) {
      throw this._err("INVALID_BODY", 400, "sourceInstance and updateSetName are required");
    }

    var sourceSysId = this._resolveSource(sourceInstance);
    if (!sourceSysId) {
      throw this._err("SOURCE_NOT_FOUND", 400,
        "no active sys_update_set_source matches host " + sourceInstance);
    }

    this._retrieve(sourceSysId);

    var remote = this._findRemote(updateSetName, sourceSysId);
    if (!remote) {
      throw this._err("UPDATE_SET_NOT_FOUND", 404,
        "completed update set '" + updateSetName + "' not found from that source");
    }
    var remoteId = remote.getUniqueValue();
    var alreadyCommitted = ("" + remote.getValue("state")) === "committed";

    var blocking = this._classifyProblems(remoteId, skipList);
    var committed = alreadyCommitted;
    if (doCommit && !alreadyCommitted && blocking.length === 0) {
      this._commit(remoteId);
      committed = true;
    }

    return {
      remoteUpdateSetSysId: remoteId,
      previewErrors: blocking,
      committed: committed,
      elapsedMs: new GlideDateTime().getNumericValue() - startMs
    };
  },

  _asArray: function (v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return ["" + v];
  },

  _err: function (code, status, message) {
    return { isDovetailError: true, errorCode: code, status: status, message: message };
  },

  _host: function (raw) {
    return ("" + raw).replace(/^https?:\/\//, "").replace(/[:\/].*$/, "").toLowerCase();
  },

  // Resolve an active sys_update_set_source whose url host matches sourceInstance.
  _resolveSource: function (sourceInstance) {
    var want = this._host(sourceInstance);
    var gr = new GlideRecord("sys_update_set_source");
    gr.addQuery("active", true);
    gr.query();
    while (gr.next()) {
      if (this._host(gr.getValue("url")) === want) {
        return gr.getUniqueValue();
      }
    }
    return "";
  },

  // Retrieve completed update sets from the source (async worker + poll).
  _retrieve: function (sourceSysId) {
    var worker = new GlideUpdateSetWorker();
    worker.setUpdateSourceSysId(sourceSysId);
    worker.setBackground(true);
    worker.start();
    var state = this._awaitWorker(worker.getProgressID(), this.RETRIEVE_TIMEOUT_MS);
    if (state !== "complete") {
      throw this._err("RETRIEVE_FAILED", 502, "retrieve worker ended in state: " + state);
    }
  },

  _findRemote: function (name, sourceSysId) {
    var gr = new GlideRecord("sys_remote_update_set");
    gr.addQuery("name", name);
    gr.addQuery("update_source", sourceSysId);
    gr.orderByDesc("sys_created_on");
    gr.setLimit(1);
    gr.query();
    return gr.next() ? gr : null;
  },

  // Auto-skip preview problems matching skipList; return the blocking ones.
  _classifyProblems: function (remoteId, skipList) {
    var blocking = [];
    var probs = new GlideRecord("sys_update_preview_problem");
    probs.addQuery("remote_update_set", remoteId);
    probs.query();
    while (probs.next()) {
      var status = "" + probs.getValue("status");
      if (status === "skipped" || status === "ignored") continue;
      var desc = "" + (probs.getValue("description") || "");
      if (this._matchesSkip(desc, skipList)) {
        probs.setValue("status", "skipped");
        probs.update();
        continue;
      }
      blocking.push({
        type: "" + (probs.getValue("type") || "error"),
        message: desc,
        targetTable: "" + (probs.getValue("target_table") || ""),
        targetName: "" + (probs.getValue("target_name") || "")
      });
    }
    return blocking;
  },

  _matchesSkip: function (desc, skipList) {
    var d = ("" + desc).toLowerCase();
    for (var i = 0; i < skipList.length; i++) {
      var s = ("" + skipList[i]).toLowerCase();
      if (s && d.indexOf(s) !== -1) return true;
    }
    return false;
  },

  // Commit a previewed remote update set — replica of UpdateSetCommitAjax.
  _commit: function (remoteId) {
    var remote = new GlideRecord("sys_remote_update_set");
    remote.addQuery("sys_id", remoteId);
    remote.query();
    if (!remote.next()) {
      throw this._err("UPDATE_SET_NOT_FOUND", 404, "remote update set vanished before commit");
    }
    if (GlidePreviewProblemHandler.hasUnresolvedProblems(remoteId)) {
      throw this._err("COMMIT_FAILED", 409, "unresolved preview problems remain");
    }
    var worker = new GlideUpdateSetWorker();
    var lus = new GlideRecord("sys_update_set");
    if (!lus.canWrite()) {
      throw this._err("COMMIT_FAILED", 403, "caller cannot write sys_update_set (admin required)");
    }
    var lusSysId = worker.remoteUpdateSetCommit(lus, remote, remote.update_source.url);
    this._copyUpdateXML(lusSysId, remote.sys_id);
    remote.update();

    worker.setUpdateSetSysId(lusSysId);
    worker.setProgressName("Dovetail commit: " + remote.name);
    worker.setBackground(true);
    worker.start();
    var state = this._awaitWorker(worker.getProgressID(), this.COMMIT_TIMEOUT_MS);
    if (state !== "complete") {
      throw this._err("COMMIT_FAILED", 502, "commit worker ended in state: " + state);
    }
  },

  // Copy the remote update set's sys_update_xml rows into the new local set.
  _copyUpdateXML: function (lsysid, rsysid) {
    var xgr = new GlideRecord("sys_update_xml");
    xgr.addQuery("remote_update_set", rsysid);
    xgr.query();
    while (xgr.next()) {
      var lxgr = new GlideRecord("sys_update_xml");
      lxgr.initialize();
      lxgr.name = xgr.name;
      lxgr.payload = xgr.payload;
      lxgr.action = xgr.action;
      lxgr.type = xgr.type;
      lxgr.target_name = xgr.target_name;
      lxgr.view = xgr.view;
      lxgr.update_domain = xgr.update_domain;
      lxgr.table = xgr.table;
      lxgr.category = xgr.category;
      lxgr.application = xgr.application;
      lxgr.update_set = lsysid;
      if (lxgr.isValidField("replace_on_upgrade")) lxgr.replace_on_upgrade = xgr.replace_on_upgrade;
      if (lxgr.isValidField("sys_recorded_at")) lxgr.sys_recorded_at = xgr.sys_recorded_at;
      if (lxgr.isValidField("payload_hash")) lxgr.payload_hash = xgr.payload_hash;
      if (lxgr.isValidField("update_guid")) lxgr.update_guid = xgr.update_guid;
      if (lxgr.isValidField("update_guid_history")) {
        lxgr.update_guid_history = xgr.update_guid_history;
        var version = new GlideRecord("sys_update_version");
        version.addQuery("name", xgr.name);
        version.addQuery("state", "current");
        version.query();
        if (version.next()) {
          lxgr.update_guid_history = SNC.UpdateGuidUtil.joinHistory(
            xgr.update_guid_history, version.update_guid_history);
        }
      }
      lxgr.insert();
    }
  },

  _awaitWorker: function (progressId, timeoutMs) {
    var waited = 0;
    while (waited < timeoutMs) {
      gs.sleep(this.POLL_INTERVAL_MS);
      waited += this.POLL_INTERVAL_MS;
      var pw = new GlideRecord("sys_progress_worker");
      if (!pw.get(progressId)) return "missing";
      var st = "" + pw.getValue("state");
      if (st === "complete" || st === "error" || st === "cancelled") return st;
    }
    return "timeout";
  },

  type: "DovetailPromote"
};
