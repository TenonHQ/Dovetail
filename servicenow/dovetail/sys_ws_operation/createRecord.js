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

    var resolvedScope = resolveScopeId(scopeName);
    if (resolvedScope.error) {
        response.setStatus(resolvedScope.status);
        response.setBody({ error: resolvedScope.error });
        return response;
    }

    try {
        // Save and switch update set if provided
        var us = new GlideUpdateSet();
        var previousUpdateSet = "";
        if (updateSetSysId) {
            previousUpdateSet = us.get();
            us.set(updateSetSysId);
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

        response.setStatus(201);
        response.setBody({
            success: true,
            sys_id: newSysId.toString(),
            table: table,
            name: gr.getDisplayValue() || gr.getValue("name") || "",
            update_set: updateSetSysId || "",
            scope: resolvedScope.sysId,
        });
    } catch (e) {
        // Restore update set on error
        if (updateSetSysId && previousUpdateSet) {
            try { us.set(previousUpdateSet); } catch (ignore) {}
        }
        response.setStatus(500);
        response.setBody({
            error: "Server error: " + e.message,
        });
    }

    return response;
})(request, response);
