(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    // POST /api/cadso/dovetail_core/createUpdateSet
    // (also mirrored on the /api/cadso/dovetail definition)
    // Body: { name, scope?, application?, description?, state? }
    //   name        (required) update set name
    //   scope       scope identifier, e.g. "x_cadso_core" (preferred — instance-stable)
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

    var previousAppId = gs.getCurrentApplicationId();
    var switched = false;
    try {
        var appSysId = applicationSysId;
        if (!appSysId && scope) {
            var scopeGr = new GlideRecord("sys_scope");
            scopeGr.addQuery("scope", scope);
            scopeGr.query();
            if (scopeGr.next()) {
                appSysId = scopeGr.getUniqueValue();
            }
        }
        if ((scope || applicationSysId) && !appSysId) {
            response.setStatus(404);
            response.setBody({ error: "Scope not found: " + (scope || applicationSysId) });
            return response;
        }

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
