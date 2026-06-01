(function process( /*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    let {
        scope
    } = request.queryParams;

    // Handle array parameter
    if (scope && typeof scope !== "string") {
        scope = scope[0];
    }

    let newScopeId = '';
    let currentScopeId = '';

    // Get current scope ID
    var session = gs.getSession();
    if (session) {
        // currentScopeId = session.getCurrentApplicationId();
    }

    // If scope parameter provided, switch to it temporarily
    if (scope) {
        var sysScopeGr = new GlideRecord('sys_scope');
        sysScopeGr.addQuery('scope', scope);
        sysScopeGr.query();

        if (sysScopeGr.next()) {
            newScopeId = sysScopeGr.getUniqueValue();
            gs.setCurrentApplicationId(newScopeId);
        }
    }

    // Get current update set
    var us = new GlideUpdateSet();
    const currentUpdateSetSysId = us.get();

    if (currentUpdateSetSysId) {
        const sysUpdateSetGr = new GlideRecord('sys_update_set');
        if (sysUpdateSetGr.get(currentUpdateSetSysId)) {
            response.setBody({
                message: 'Success',
                sysId: currentUpdateSetSysId,
                name: sysUpdateSetGr.getDisplayValue()
            });
            response.setStatus(200);
        } else {
            response.setStatus(404);
            response.setBody({
                error: 'Update set record not found'
            });
        }
    } else {
        response.setStatus(404);
        response.setBody({
            error: 'No current update set found'
        });
    }

    // Restore original scope if we switched
    if (newScopeId && currentScopeId) {
        gs.setCurrentApplicationId(currentScopeId);
    }

    return response;

})(request, response);