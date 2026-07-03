/**
 * POST /api/cadso/dovetail/pushWithUpdateSet
 * (also mirrored on the /api/cadso/dovetail_core definition)
 *
 * Update an existing record within a specific update set.
 * Body: { update_set_sys_id, table, record_sys_id, fields }
 *
 * Web Service Definition: "Dovetail" (global scope). The op sys_id differs per
 * instance — look it up by name, never hardcode.
 *
 * Hardening: switch to the TARGET update set's application scope
 * (gs.setCurrentApplicationId) BEFORE gr.update(), restoring it in finally.
 * Without the scope switch, a scoped record's customer update issued from this
 * global REST context is captured into the caller's session/default update set
 * instead of the requested (scoped) one — so routed pushes reported HTTP 200 /
 * "success" while capturing nothing into the target set (orphaned rows with an
 * empty update_set). This mirrors the createUpdateSet op's proven pattern.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
	var body = request.body.data;
	var updateSetSysId = body.update_set_sys_id;
	var table = body.table;
	var recordSysId = body.record_sys_id;
	var fields = body.fields;

	if (!updateSetSysId || !table || !recordSysId || !fields) {
		response.setStatus(400);
		response.setBody({
			error: "Missing required fields: update_set_sys_id, table, record_sys_id, fields",
		});
		return response;
	}

	var previousAppId = gs.getCurrentApplicationId();
	var switched = false;
	var us = new GlideUpdateSet();
	var previousUpdateSet = us.get();

	try {
		// Switch to the target update set's application scope BEFORE the write, so a
		// scoped record's customer update is captured into THIS set rather than the
		// caller's session/default set (a global-scope GlideUpdateSet().set() alone
		// does not govern where a scoped-record change is captured). Restored in finally.
		var usGr = new GlideRecord("sys_update_set");
		if (!usGr.get(updateSetSysId)) {
			response.setStatus(404);
			response.setBody({ error: "Update set not found: " + updateSetSysId });
			return response;
		}
		var appId = usGr.getValue("application");
		if (appId) {
			gs.setCurrentApplicationId(appId);
			switched = true;
		}
		us.set(updateSetSysId);

		var gr = new GlideRecord(table);
		if (gr.get(recordSysId)) {
			for (var field in fields) {
				if (fields.hasOwnProperty(field)) {
					gr.setValue(field, fields[field]);
				}
			}
			gr.update();

			response.setStatus(200);
			response.setBody({
				success: true,
				message: "Record updated in update set",
				table: table,
				sys_id: recordSysId,
				update_set: updateSetSysId,
			});
		} else {
			response.setStatus(404);
			response.setBody({
				error: "Record not found: " + table + "/" + recordSysId,
			});
		}
	} catch (e) {
		response.setStatus(500);
		response.setBody({ error: "Server error: " + e.message });
	} finally {
		us.set(previousUpdateSet);
		if (switched && previousAppId) {
			try {
				gs.setCurrentApplicationId(previousAppId);
			} catch (ignore) {}
		}
	}

	return response;
})(request, response);
