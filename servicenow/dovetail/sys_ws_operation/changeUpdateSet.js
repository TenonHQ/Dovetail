/**
 * GET /api/cadso/dovetail_core/changeUpdateSet
 * (also mirrored on the /api/cadso/dovetail definition)
 *
 * Switch the active update set. Query: ?sysId=... OR ?name=...&scope=...
 * (name+scope resolves the most-recent in-progress set in that scope).
 *
 * Web Service Definition: "Dovetail Core" / "Dovetail" (global scope). The op
 * sys_id differs per instance — look it up by name, never hardcode.
 *
 * NOTE: the "Dovetail Core" def carries this (newer, ES5) copy; the legacy
 * "Dovetail" def still runs an older ES6 variant of the same logic. Core is the
 * client's primary target, so this captures the Core version.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var sysId = request.queryParams.sysId;
    var name = request.queryParams.name;
    var scope = request.queryParams.scope;
    if (sysId && typeof sysId !== "string") { sysId = sysId[0]; }
    if (name && typeof name !== "string") { name = name[0]; }
    if (scope && typeof scope !== "string") { scope = scope[0]; }
    if (!sysId) {
        var sysUpdateSetGr = new GlideRecord('sys_update_set');
        sysUpdateSetGr.addEncodedQuery('application.scopeLIKE' + scope);
        sysUpdateSetGr.addQuery('name', 'LIKE', name);
        sysUpdateSetGr.addQuery('state', '=', 'in progress');
        sysUpdateSetGr.setLimit(1);
        sysUpdateSetGr.orderByDesc('sys_created_on');
        sysUpdateSetGr.query();
        while (sysUpdateSetGr.next()) { sysId = sysUpdateSetGr.getValue('sys_id'); }
    }
    if (sysId) {
        var us = new GlideUpdateSet();
        us.set(sysId);
        response.setStatus(200);
        response.setBody({ message: 'Success' });
    } else {
        response.setStatus(404);
        response.setBody({ error: 'Update Set not found' });
    }
    return response;
})(request, response);
