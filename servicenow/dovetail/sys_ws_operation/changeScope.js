/**
 * GET /api/cadso/dovetail_core/changeScope
 * (also mirrored on the /api/cadso/dovetail definition)
 *
 * Switch the caller's active application scope. Query: ?scope=x_cadso_core
 *
 * Web Service Definition: "Dovetail Core" / "Dovetail" (global scope). The op
 * sys_id differs per instance — look it up by name, never hardcode.
 *
 * NOTE: the "Dovetail Core" def carries this (newer, ES5) copy; the legacy
 * "Dovetail" def still runs an older ES6 variant of the same logic. Core is the
 * client's primary target, so this captures the Core version.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var scope = request.queryParams.scope;
    if (scope && typeof scope !== "string") { scope = scope[0]; }
    if (scope) {
        var sysScopeGr = new GlideRecord('sys_scope');
        sysScopeGr.addQuery('scope', scope);
        sysScopeGr.query();
        if (sysScopeGr.next()) {
            var newScopeId = sysScopeGr.getUniqueValue();
            gs.setCurrentApplicationId(newScopeId);
            response.setBody({ message: 'Success', scopeId: newScopeId, scope: scope, user: gs.getUserDisplayName(), instance: gs.getProperty('instance_name') });
            response.setStatus(200);
        } else {
            response.setStatus(404);
            response.setBody({ error: 'Scope not found!' });
        }
    } else {
        response.setStatus(400);
        response.setBody({ error: 'No scope provided' });
    }
    return response;
})(request, response);
