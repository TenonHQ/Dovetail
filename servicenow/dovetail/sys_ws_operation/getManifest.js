/**
 * POST /api/cadso/dovetail_sync/getManifest/{scope}
 * Returns full manifest of records and optionally file contents for a scope.
 * Path param: scope (application scope name)
 * Body: { includes, excludes, tableOptions, withFiles, getContents }
 *
 * Web Service Definition: "Dovetail Sync" (global scope). The op sys_id differs
 * per instance — look it up by name, never hardcode.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
  var utils = new DovetailUtils();
  var data = request.body.data;
  var includes = data.includes;
  var excludes = data.excludes;
  var tableOptions = data.tableOptions || {};
  var getContents = data.getContents || data.withFiles || false;
  var scopeName = request.pathParams.scope;

  // An unresolved scope must fail loudly. Before, it produced a partial manifest (only
  // tables filtered by scope name, e.g. sys_dictionary and sys_choice) that a refresh
  // would happily write to disk.
  if (!utils.getScopeId(scopeName)) {
    response.setStatus(404);
    response.setBody({
      error: "Scope not found or not unique among sys_app / sys_store_app: " + scopeName
    });
    return;
  }

  var result = utils.getManifest({
    scopeName: scopeName,
    includes: includes,
    excludes: excludes,
    tableOptions: tableOptions,
    getContents: getContents
  });

  response.setBody(result);
})(request, response);
