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
 * Optional body key `domain` ("global" or a domain sys_id): the session domain
 * the update runs in — switched before the write, restored in finally, echoed
 * back as `domain: { requested, applied, previous }`. Fails closed (no write)
 * when the switch does not take. See resolveDomainTarget below.
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
	var requestedDomain = body.domain;

	if (!updateSetSysId || !table || !recordSysId || !fields) {
		response.setStatus(400);
		response.setBody({
			error: "Missing required fields: update_set_sys_id, table, record_sys_id, fields",
		});
		return response;
	}

	// ── Session domain (domain separation) ────────────────────────────────────
	// Keep in sync with the copy in createRecord.js.
	//
	// The session domain decides where a write lands: an INSERT is stamped with it,
	// and an UPDATE of a process record (sys_script, sys_choice, ...) that lives in a
	// domain ABOVE the session's is diverted into a new domain OVERRIDE row instead of
	// editing the record. The session is established in the API user's own domain
	// (sys_user.sys_domain), so a caller names the domain the write must run in.
	//
	// gs.getUser().setDomainID() is the global-scope session-domain setter (the
	// domain-picker path; ServiceNow KB0822648) and getDomainID() the getter
	// (GlideUser API). An absent `domain` keeps the legacy behaviour: no switch.
	function sessionDomainId() {
		var id = gs.getUser().getDomainID();
		return id ? String(id) : "global";
	}

	// { skip, reason } | { id } | { status, error }
	function resolveDomainTarget(tableName, requested) {
		var value = String(requested || "");
		if (!value) {
			return { skip: true, reason: "no domain requested" };
		}
		var probe = new GlideRecord(tableName);
		if (!probe.isValidField("sys_domain")) {
			return { skip: true, reason: "table has no sys_domain" };
		}
		if (value === "global") {
			return { id: "global" };
		}
		if (!/^[0-9a-f]{32}$/.test(value)) {
			return {
				status: 400,
				error: "domain must be 'global' or a 32-character domain sys_id: " + value,
			};
		}
		var refTable = probe.getElement("sys_domain").getReferenceTable();
		var domainGr = new GlideRecord(refTable || "domain");
		if (!domainGr.get(value)) {
			// 422, never 404: the client treats any 404 from a Dovetail Core op as "op not
			// installed" and re-sends the write to the legacy op, which ignores `domain` —
			// that would turn a refused domain into a write in the caller's own domain.
			return {
				status: 422,
				error: "Domain not found: " + value + " (in " + (refTable || "domain") + ")",
			};
		}
		return { id: value };
	}

	var domainTarget = resolveDomainTarget(table, requestedDomain);
	if (domainTarget.error) {
		response.setStatus(domainTarget.status);
		response.setBody({ error: domainTarget.error });
		return response;
	}

	var previousAppId = gs.getCurrentApplicationId();
	var switched = false;
	var us = new GlideUpdateSet();
	var previousUpdateSet = us.get();
	var previousDomain = null;
	var domainSwitched = false;
	var domainEcho = null;

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
		// Session domain FIRST: switching domain (like switching app scope) may
		// re-select the session's current update set, so it must happen before
		// us.set() — and the set is asserted again just before the write.
		if (domainTarget.id) {
			previousDomain = sessionDomainId();
			if (previousDomain !== domainTarget.id) {
				gs.getUser().setDomainID(domainTarget.id);
				domainSwitched = true;
			}
			var appliedDomain = sessionDomainId();
			if (appliedDomain !== domainTarget.id) {
				// Fail closed: writing in the wrong domain is the bug this guards. 409,
				// not 5xx: the client retries a 5xx and then drops this body.
				response.setStatus(409);
				response.setBody({
					error: "Could not switch the session domain to " + domainTarget.id +
						" (session is in " + appliedDomain + "); nothing was written.",
				});
				return response;
			}
			domainEcho = { requested: domainTarget.id, applied: appliedDomain, previous: previousDomain };
		} else if (requestedDomain) {
			domainEcho = { requested: String(requestedDomain), applied: null, previous: null, skipped: domainTarget.reason };
		}

		var appId = usGr.getValue("application");
		if (appId) {
			gs.setCurrentApplicationId(appId);
			switched = true;
		}
		us.set(updateSetSysId);

		if (domainTarget.id && String(us.get()) !== String(updateSetSysId)) {
			response.setStatus(409);
			response.setBody({
				error: "Update set " + updateSetSysId + " is not current after the domain switch (current: " +
					us.get() + "); nothing was written.",
			});
			return response;
		}

		var gr = new GlideRecord(table);
		if (gr.get(recordSysId)) {
			for (var field in fields) {
				if (fields.hasOwnProperty(field)) {
					gr.setValue(field, fields[field]);
				}
			}
			gr.update();

			var updatedBody = {
				success: true,
				message: "Record updated in update set",
				table: table,
				sys_id: recordSysId,
				update_set: updateSetSysId,
			};
			if (domainEcho) {
				updatedBody.domain = domainEcho;
				if (gr.isValidField("sys_domain")) {
					updatedBody.record_domain = gr.getValue("sys_domain");
				}
			}
			response.setStatus(200);
			response.setBody(updatedBody);
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
		if (domainSwitched && previousDomain) {
			try {
				gs.getUser().setDomainID(previousDomain);
			} catch (restoreErr) {
				gs.warn("Dovetail: could not restore session domain " + previousDomain + ": " + restoreErr);
			}
		}
		us.set(previousUpdateSet);
		if (switched && previousAppId) {
			try {
				gs.setCurrentApplicationId(previousAppId);
			} catch (ignore) {}
		}
	}

	return response;
})(request, response);
