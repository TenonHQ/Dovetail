/**
 * GET /api/cadso/dovetail_sync/getAppList
 * Returns list of all application scopes.
 *
 * Web Service Definition: "Dovetail Sync" (global scope). The op sys_id differs
 * per instance — look it up by name, never hardcode.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
  var utils = new DovetailUtils();
  response.setBody(utils.getAppList());
})(request, response);
