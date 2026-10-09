(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    // POST /api/cadso/dovetail_core/createUpdateSet
    // (also mirrored on the /api/cadso/dovetail definition)
    // Body: { name, scope?, application?, description?, state? }
    //   name        (required) update set name
    //   scope       scope name (e.g. "x_cadso_core") or sys_scope sys_id. Every global-scope
    //               app's name is "global", so "global" means the Global scope itself; reach
    //               a specific global app (e.g. the Dovetail app) by its sys_id. A name that
    //               matches several apps is a 409, never a guess.
    //   application  optional explicit sys_scope sys_id (used if scope is omitted)
    //   description  optional update set description
    //   state        optional, defaults to "in progress"
    //
    // Why this op exists: sys_update_set.application defaults to
    // gs.getCurrentApplicationId(), and a raw Table API POST ignores an inbound
    // `application` value — so the set lands in the API user's session scope, not
    // the one you asked for. dove's old createUpdateSet tried to compensate with a
    // SEPARATE changeScope() call, which races and mis-scopes sets when several are
    // created back-to-back. This op switches the current application and inserts the
    // set in ONE server call: deterministic and race-free.
    var body = request.body.data || {};
    var name = body.name;
    var scope = body.scope || "";
    var applicationSysId = body.application || "";
    var description = body.description || "";
    var state = body.state || "in progress";

    if (!name) {
        response.setStatus(400);
        response.setBody({ error: "Missing required field: name" });
        return response;
    }

    // Keep in sync with resolveScopeId in createRecord.js.
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

    var previousAppId = gs.getCurrentApplicationId();
    var switched = false;
    try {
        var resolved = resolveScopeId(scope || applicationSysId);
        if (resolved.error) {
            response.setStatus(resolved.status);
            response.setBody({ error: resolved.error });
            return response;
        }
        var appSysId = resolved.sysId;

        // Be in the target scope at insert time so the application default resolves
        // correctly even if a platform rule were to ignore the explicit setValue.
        if (appSysId) {
            gs.setCurrentApplicationId(appSysId);
            switched = true;
        }

        var gr = new GlideRecord("sys_update_set");
        gr.initialize();
        gr.setValue("name", name);
        gr.setValue("state", state);
        if (description) {
            gr.setValue("description", description);
        }
        if (appSysId) {
            gr.setValue("application", appSysId); // explicit; belt-and-suspenders with the scope switch
        }
        var newSysId = gr.insert();

        if (!newSysId) {
            response.setStatus(500);
            response.setBody({ error: "Failed to insert update set. Check permissions and field values." });
            return response;
        }

        // Read back the persisted application so the caller gets ground truth.
        var verify = new GlideRecord("sys_update_set");
        verify.get(newSysId);

        response.setStatus(201);
        response.setBody({
            success: true,
            sys_id: newSysId.toString(),
            name: name,
            application: verify.getValue("application"),
            application_scope: verify.getDisplayValue("application")
        });
    } catch (e) {
        response.setStatus(500);
        response.setBody({ error: "Server error: " + e.message });
    } finally {
        // Always restore the caller's previous application context.
        if (switched && previousAppId) {
            try {
                gs.setCurrentApplicationId(previousAppId);
            } catch (ignore) {}
        }
    }
    return response;
})(request, response);
