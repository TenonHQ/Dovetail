/**
 * GET /api/cadso/dovetail_core/currentUpdateSet
 * (also mirrored on the /api/cadso/dovetail definition)
 *
 * Read the caller's current update set. Optional ?scope=... temporarily switches
 * scope before reading.
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
    var newScopeId = '';
    var currentScopeId = '';
    if (scope) {
        var sysScopeGr = new GlideRecord('sys_scope');
        sysScopeGr.addQuery('scope', scope);
        sysScopeGr.query();
        if (sysScopeGr.next()) {
            newScopeId = sysScopeGr.getUniqueValue();
            gs.setCurrentApplicationId(newScopeId);
        }
    }
    var us = new GlideUpdateSet();
    var currentUpdateSetSysId = us.get();
    if (currentUpdateSetSysId) {
        var sysUpdateSetGr = new GlideRecord('sys_update_set');
        if (sysUpdateSetGr.get(currentUpdateSetSysId)) {
            response.setBody({ message: 'Success', sysId: currentUpdateSetSysId, name: sysUpdateSetGr.getDisplayValue() });
            response.setStatus(200);
        } else {
            response.setStatus(404);
            response.setBody({ error: 'Update set record not found' });
        }
    } else {
        response.setStatus(404);
        response.setBody({ error: 'No current update set found' });
    }
    if (newScopeId && currentScopeId) { gs.setCurrentApplicationId(currentScopeId); }
    return response;
})(request, response);
