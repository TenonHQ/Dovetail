(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
	// Dovetail runFlow: runs a flow, subflow, or action headless via sn_fd.FlowAPI for
	// dove-sn testFlow({ mode: "execute" }). Running a flow has real side effects, so the
	// caller must hold admin or dovetail_user.
	// Body: { flowSysId?: sys_hub_flow sys_id, actionSysId?: sys_hub_action_type_definition sys_id, inputs?: {} }
	// Response: { ok, contextId, outputs } or { ok: false, error }
	if (!gs.hasRole("admin") && !gs.hasRole("dovetail_user")) {
		response.setStatus(403);
		return { ok: false, error: "runFlow requires the admin or dovetail_user role" };
	}

	var body = (request.body && request.body.data) || {};
	var flowSysId = typeof body.flowSysId === "string" ? body.flowSysId : "";
	var actionSysId = typeof body.actionSysId === "string" ? body.actionSysId : "";
	var inputs = body.inputs && typeof body.inputs === "object" ? body.inputs : {};
	var SYS_ID_RE = /^[0-9a-f]{32}$/;

	if ((!flowSysId && !actionSysId) || (flowSysId && actionSysId)) {
		response.setStatus(400);
		return { ok: false, error: "send exactly one of flowSysId or actionSysId" };
	}
	var targetSysId = flowSysId || actionSysId;
	if (!SYS_ID_RE.test(targetSysId)) {
		response.setStatus(400);
		return { ok: false, error: "sys_id must be 32 lowercase hex characters" };
	}

	// FlowAPI addresses flows, subflows, and actions by "<scope>.<internal_name>".
	var targetTable = flowSysId ? "sys_hub_flow" : "sys_hub_action_type_definition";
	var targetGr = new GlideRecord(targetTable);
	if (!targetGr.get(targetSysId)) {
		response.setStatus(404);
		return { ok: false, error: targetTable + " not found: " + targetSysId };
	}
	var internalName = targetGr.getValue("internal_name") || "";
	if (!internalName) {
		response.setStatus(422);
		return { ok: false, error: targetTable + " " + targetSysId + " has no internal_name" };
	}
	var scopeName = targetGr.sys_scope.scope ? targetGr.sys_scope.scope.toString() : "global";
	var qualifiedName = scopeName + "." + internalName;

	// Outputs can hold GlideRecords or Java objects; reduce each to a JSON-safe value.
	function toJsonSafe(value) {
		if (value === null || value === undefined) return null;
		var kind = typeof value;
		if (kind === "string" || kind === "number" || kind === "boolean") return value;
		if (typeof value.getUniqueValue === "function") return value.getUniqueValue();
		return String(value);
	}

	try {
		var runner = sn_fd.FlowAPI.getRunner();
		if (actionSysId) {
			runner = runner.action(qualifiedName);
		} else if (targetGr.getValue("type") === "subflow") {
			runner = runner.subflow(qualifiedName);
		} else {
			runner = runner.flow(qualifiedName);
		}
		// Foreground so outputs return synchronously; long flows should poll sys_flow_context.
		var result = runner.inForeground().withInputs(inputs).run();
		var rawOutputs = (result && result.getOutputs && result.getOutputs()) || {};
		var outputs = {};
		for (var key in rawOutputs) {
			if (Object.prototype.hasOwnProperty.call(rawOutputs, key)) {
				outputs[key] = toJsonSafe(rawOutputs[key]);
			}
		}
		return {
			ok: true,
			name: qualifiedName,
			contextId: (result && result.getContextId && String(result.getContextId())) || "",
			outputs: outputs,
		};
	} catch (e) {
		response.setStatus(500);
		return { ok: false, name: qualifiedName, error: (e && e.message) || String(e) };
	}
})(request, response);
