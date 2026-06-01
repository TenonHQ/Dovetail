(function process( /*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    let {
        sysId,
        name,
        scope
    } = request.queryParams;
    if (typeof sysId !== "string") {
        sysId = sysId[0];
    }
    if (typeof name !== "string") {
        name = name[0];
    }
    if (typeof scope !== "string") {
        scope = scope[0];
    }

    if (!sysId) {
        const sysUpdateSetGr = new GlideRecord('sys_update_set');
        sysUpdateSetGr.addEncodedQuery(`application.scopeLIKE${scope}`);
        sysUpdateSetGr.addQuery('name', 'LIKE', name);
        sysUpdateSetGr.addQuery('state', '=', 'in progress');
        sysUpdateSetGr.setLimit(1);
        sysUpdateSetGr.orderByDesc('sys_created_on');
        sysUpdateSetGr.query();

        while (sysUpdateSetGr.next()) {
            sysId = sysUpdateSetGr.getValue('sys_id');
        }
    }

    if (sysId) {
        var us = new GlideUpdateSet();
        us.set(sysId);
        response.setStatus(200);
        response.setBody({
            message: 'Success'
        });
    } else {
        response.setStatus(404);
        response.setBody({
            error: 'Update Set not found'
        });
    }

	return response;

})(request, response);