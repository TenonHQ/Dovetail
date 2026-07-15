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

  var result = utils.getManifest({
    scopeName: scopeName,
    includes: includes,
    excludes: excludes,
    tableOptions: tableOptions,
    getContents: getContents
  });

  response.setBody(result);
})(request, response);
