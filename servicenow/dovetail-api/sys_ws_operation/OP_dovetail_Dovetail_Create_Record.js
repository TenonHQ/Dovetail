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

        // Set scope if provided
        if (scopeName) {
            var scopeGR = new GlideRecord("sys_scope");
            scopeGR.addQuery("scope", scopeName);
            scopeGR.query();
            if (scopeGR.next()) {
                gr.setValue("sys_scope", scopeGR.getUniqueValue());
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
