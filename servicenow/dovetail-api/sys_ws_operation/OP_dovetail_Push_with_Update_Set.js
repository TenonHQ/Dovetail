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

	try {
		// Save and switch update set for this transaction
		var us = new GlideUpdateSet();
		var previousUpdateSet = us.get();
		us.set(updateSetSysId);

		// Update the record
		var gr = new GlideRecord(table);
		if (gr.get(recordSysId)) {
			for (var field in fields) {
				if (fields.hasOwnProperty(field)) {
					gr.setValue(field, fields[field]);
				}
			}
			gr.update();

			// Restore previous update set
			us.set(previousUpdateSet);

			response.setStatus(200);
			response.setBody({
				success: true,
				message: "Record updated in update set",
				table: table,
				sys_id: recordSysId,
				update_set: updateSetSysId,
			});
		} else {
			us.set(previousUpdateSet);
			response.setStatus(404);
			response.setBody({
				error: "Record not found: " + table + "/" + recordSysId,
			});
		}
	} catch (e) {
		response.setStatus(500);
		response.setBody({
			error: "Server error: " + e.message,
		});
	}

	return response;
})(request, response);
