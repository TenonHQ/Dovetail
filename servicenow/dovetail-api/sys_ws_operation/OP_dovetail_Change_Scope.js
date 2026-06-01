(function process( /*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    let {
        scope
    } = request.queryParams;

    // Handle array parameter
    if (scope && typeof scope !== "string") {
        scope = scope[0];
    }

    if (scope) {
        var sysScopeGr = new GlideRecord('sys_scope');
        sysScopeGr.addQuery('scope', scope);
        sysScopeGr.query();

        if (sysScopeGr.next()) {
            var newScopeId = sysScopeGr.getUniqueValue();
            gs.setCurrentApplicationId(newScopeId);

            response.setBody({
                message: 'Success',
                scopeId: newScopeId,
                scope: scope,
                user: gs.getUserDisplayName(),
                instance: gs.getProperty('instance_name')
            });
            response.setStatus(200);
        } else {
            response.setStatus(404);
            response.setBody({
                error: 'Scope not found!'
            });
        }
    } else {
        response.setStatus(400);
        response.setBody({
            error: 'No scope provided'
        });
    }

    return response;

})(request, response);