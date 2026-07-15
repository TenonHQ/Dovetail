/**
 * POST /api/cadso/dovetail_sync/bulkDownload
 * Downloads file contents for specific missing records.
 * Body: { missingFiles, tableOptions }
 *
 * Web Service Definition: "Dovetail Sync" (global scope). The op sys_id differs
 * per instance — look it up by name, never hardcode.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
  var utils = new DovetailUtils();
  var data = request.body.data;
  var missingFiles = data.missingFiles;
  var tableOptions = data.tableOptions;

  var result = utils.processMissingFiles(missingFiles, tableOptions);
  response.setBody(result);
})(request, response);
