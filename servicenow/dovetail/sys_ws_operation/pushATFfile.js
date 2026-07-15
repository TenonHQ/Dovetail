/**
 * POST /api/cadso/dovetail_sync/pushATFfile
 * Updates an ATF step record's inputs.script field.
 * Body: { file, sys_id }
 *
 * Web Service Definition: "Dovetail Sync" (global scope). The op sys_id differs
 * per instance — look it up by name, never hardcode.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
  var file = request.body.data.file;
  var sys_id = request.body.data.sys_id;

  if (new DovetailUtils().pushATFfile(sys_id, file)) {
    response.setBody("success");
  } else {
    response.setError(new sn_ws_err.BadRequestError("Error updating ATF record"));
  }
})(request, response);
