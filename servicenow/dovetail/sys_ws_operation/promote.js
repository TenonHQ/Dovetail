/**
 * Dovetail - promote — Scripted REST operation script.
 * sys_ws_operation, POST /api/cadso/dovetail_promote/promote (Dovetail Promote def).
 *
 * Thin wrapper: parses the request body, delegates to the DovetailPromote
 * Script Include, and writes the outcome as the raw JSON response body.
 *
 * The body is written via the stream writer (not response.setBody) so it is
 * NOT wrapped in a `{ "result": ... }` envelope — the @tenonhq/dovetail-dovetail
 * client expects the PromoteResponse at the top level.
 *
 *   200 -> PromoteResponse { remoteUpdateSetSysId, previewErrors[], committed, elapsedMs }
 *   4xx -> { errorCode, message }   (INVALID_BODY / SOURCE_NOT_FOUND /
 *                                    UPDATE_SET_NOT_FOUND / RETRIEVE_FAILED /
 *                                    COMMIT_FAILED)
 *   500 -> { errorCode: "INTERNAL", message }
 *
 * Web Service Definition: "Dovetail Promote" (global scope). The op sys_id
 * differs per instance — look it up by name, never hardcode.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
  var body;
  try {
    body = request.body.data;
  } catch (parseErr) {
    body = null;
  }

  var engine = new DovetailPromote();
  var status;
  var payload;
  try {
    payload = engine.promote(body || {});
    status = 200;
  } catch (e) {
    if (e && e.isDovetailError) {
      status = e.status || 400;
      payload = { errorCode: e.errorCode, message: e.message };
    } else {
      status = 500;
      payload = { errorCode: "INTERNAL", message: "" + ((e && e.message) || e) };
    }
  }

  response.setStatus(status);
  response.setContentType("application/json");
  response.getStreamWriter().writeString(JSON.stringify(payload));
})(request, response);
