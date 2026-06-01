(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var body = request.body.data;
    var table = body.table;
    var sysId = body.sys_id;

    if (!table || !sysId) {
        response.setStatus(400);
        response.setBody({ error: "Missing required fields: table, sys_id" });
        return response;
    }

    try {
        var gr = new GlideRecord(table);
        if (!gr.get(sysId)) {
            response.setStatus(404);
            response.setBody({ error: "Record not found: " + table + "/" + sysId });
            return response;
        }

        var name = gr.getDisplayValue() || gr.getValue("name") || "";

        if (!gr.deleteRecord()) {
            response.setStatus(500);
            response.setBody({ error: "Failed to delete record" });
            return response;
        }

        response.setStatus(200);
        response.setBody({
            success: true,
            sys_id: sysId,
            table: table,
            name: name
        });
    } catch (e) {
        response.setStatus(500);
        response.setBody({ error: "Server error: " + e.message });
    }

    return response;
})(request, response);
