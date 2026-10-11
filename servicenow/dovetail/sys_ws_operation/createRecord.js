/**
 * POST /api/cadso/dovetail_core/createRecord
 * (also mirrored on the /api/cadso/dovetail definition)
 *
 * Create a record. Body: { table, fields } (+ optional sys_id, scope,
 * update_set_sys_id). An explicit sys_id supports cross-instance record moves.
 *
 * `scope` is a sys_scope sys_id (32 hex) or a scope name. A sys_id is the only
 * way to reach a specific global-scope app: every global app's scope name is
 * "global", so the name "global" always means the Global scope itself. Any other
 * name must match exactly one sys_scope row. An unknown scope is a 404, and a
 * name shared by several apps is a 409, rather than a silent fall-back to the
 * caller's session scope. The record gets both sys_scope and sys_package (when
 * the table has them), because an app file needs both.
 *
 * Optional body key `domain` ("global" or a domain sys_id): the session domain
 * the insert runs in — switched before the insert (and stamped on sys_domain when
 * the payload carries none), restored afterwards, echoed back as
 * `domain: { requested, applied, previous }` plus the stored `record_domain`.
 * Fails closed (no insert) when the switch does not take.
 *
 * Web Service Definition: "Dovetail Core" / "Dovetail" (global scope). The op
 * sys_id differs per instance — look it up by name, never hardcode.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var body = request.body.data;
    var table = body.table;
    var fields = body.fields;
    var sysId = body.sys_id || "";
    var scopeName = body.scope || "";
    var updateSetSysId = body.update_set_sys_id || "";
    var requestedDomain = body.domain;

    if (!table || !fields) {
        response.setStatus(400);
        response.setBody({
            error: "Missing required fields: table, fields",
        });
        return response;
    }

    // Keep in sync with resolveScopeId in createUpdateSet.js.
    function resolveScopeId(identifier) {
        var value = String(identifier || "");
        if (!value) {
            return { sysId: "" };
        }
        if (value === "global") {
            return { sysId: "global" };
        }
        var scopeGr = new GlideRecord("sys_scope");
        if (/^[0-9a-f]{32}$/.test(value)) {
            if (scopeGr.get(value)) {
                return { sysId: scopeGr.getUniqueValue() };
            }
            return { status: 404, error: "Scope not found: " + value };
        }
        scopeGr.addQuery("scope", value);
        scopeGr.query();
        var matches = [];
        while (scopeGr.next()) {
            matches.push(scopeGr.getUniqueValue() + " (" + scopeGr.getValue("name") + ")");
        }
        if (matches.length === 1) {
            return { sysId: matches[0].substring(0, 32) };
        }
        if (matches.length === 0) {
            return { status: 404, error: "Scope not found: " + value };
        }
        return {
            status: 409,
            error: "Scope name '" + value + "' matches " + matches.length +
                " apps; pass the sys_scope sys_id instead: " + matches.join(", "),
        };
    }

    // ── Session domain (domain separation) ────────────────────────────────────
    // Keep in sync with the copy in pushWithUpdateSet.js.
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
            return {
                status: 404,
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

    var resolvedScope = resolveScopeId(scopeName);
    if (resolvedScope.error) {
        response.setStatus(resolvedScope.status);
        response.setBody({ error: resolvedScope.error });
        return response;
    }

    var previousDomain = null;
    var domainSwitched = false;
    var domainEcho = null;
    try {
        // Save and switch update set if provided
        var us = new GlideUpdateSet();
        var previousUpdateSet = "";
        if (updateSetSysId) {
            previousUpdateSet = us.get();
            us.set(updateSetSysId);
        }

        if (domainTarget.id) {
            previousDomain = sessionDomainId();
            if (previousDomain !== domainTarget.id) {
                gs.getUser().setDomainID(domainTarget.id);
                domainSwitched = true;
            }
            var appliedDomain = sessionDomainId();
            if (appliedDomain !== domainTarget.id) {
                // Fail closed: inserting in the wrong domain is the bug this guards.
                if (updateSetSysId && previousUpdateSet) {
                    us.set(previousUpdateSet);
                }
                response.setStatus(500);
                response.setBody({
                    error: "Could not switch the session domain to " + domainTarget.id +
                        " (session is in " + appliedDomain + "); nothing was inserted.",
                });
                return response;
            }
            domainEcho = { requested: domainTarget.id, applied: appliedDomain, previous: previousDomain };
        } else if (requestedDomain) {
            domainEcho = { requested: String(requestedDomain), applied: null, previous: null, skipped: domainTarget.reason };
        }

        var gr = new GlideRecord(table);
        gr.initialize();
        gr.newRecord();

        // Set specific sys_id if provided (for cross-instance moves)
        if (sysId) {
            gr.setNewGuidValue(sysId);
        }

        // Own the record by the resolved app: sys_scope and sys_package together.
        if (resolvedScope.sysId) {
            if (gr.isValidField("sys_scope")) {
                gr.setValue("sys_scope", resolvedScope.sysId);
            }
            if (gr.isValidField("sys_package")) {
                gr.setValue("sys_package", resolvedScope.sysId);
            }
        }

        // Stamp the requested domain unless the payload names one itself (the session
        // switch above is what the platform honours; this keeps the two in agreement).
        if (domainTarget.id && !fields.hasOwnProperty("sys_domain")) {
            gr.setValue("sys_domain", domainTarget.id);
        }

        // Set field values
        for (var field in fields) {
            if (fields.hasOwnProperty(field)) {
                gr.setValue(field, fields[field]);
            }
        }

        var newSysId = gr.insert();

        // Restore previous update set
        if (updateSetSysId && previousUpdateSet) {
            us.set(previousUpdateSet);
        }

        if (!newSysId) {
            response.setStatus(500);
            response.setBody({
                error: "Failed to insert record. Check table permissions and field values.",
            });
            return response;
        }

        var createdBody = {
            success: true,
            sys_id: newSysId.toString(),
            table: table,
            name: gr.getDisplayValue() || gr.getValue("name") || "",
            update_set: updateSetSysId || "",
            scope: resolvedScope.sysId,
        };
        if (domainEcho) {
            createdBody.domain = domainEcho;
            if (gr.isValidField("sys_domain")) {
                createdBody.record_domain = gr.getValue("sys_domain");
            }
        }
        response.setStatus(201);
        response.setBody(createdBody);
    } catch (e) {
        // Restore update set on error
        if (updateSetSysId && previousUpdateSet) {
            try { us.set(previousUpdateSet); } catch (ignore) {}
        }
        response.setStatus(500);
        response.setBody({
            error: "Server error: " + e.message,
        });
    } finally {
        if (domainSwitched && previousDomain) {
            try {
                gs.getUser().setDomainID(previousDomain);
            } catch (ignoreDomain) {}
        }
    }

    return response;
})(request, response);
