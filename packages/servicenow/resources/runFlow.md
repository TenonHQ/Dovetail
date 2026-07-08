# FlowAPI runner — server-side resource for `testFlow({ mode: "execute" })`

`testFlow` in `mode: "execute"` POSTs to a ServiceNow **Scripted REST** resource
that runs a flow/subflow/action server-side via `sn_fd.FlowAPI`. The UI "Test"
button has no guessable native REST route, so this small scoped resource is the
supported, uniform way to run any of the three artifact types headless.

This resource lives on the **ServiceNow** side (the `x_cadso` Dovetail scope),
not in this npm package — deploy it once per instance. The client half
(`testFlow`) already targets it at `DEFAULT_RUN_FLOW_PATH`
(`/api/cadso/dovetail/runFlow`); override with `runnerPath` if you mount it
elsewhere.

> **Safety.** Running a flow causes real side effects (the example subflow sends
> an SMS). Keep this resource behind an ACL that restricts it to the integration
> role, and prefer `mode: "validate"` for anything but a sandbox flow. `testFlow`
> additionally requires `confirm: true` before it will call this endpoint.

## Resource definition

- **HTTP method:** POST
- **Relative path:** `/runFlow` under a `dovetail` API (full path `/api/cadso/dovetail/runFlow`)
- **Requires authentication:** yes (basic auth, same integration user)
- **Request body:** `{ "flowSysId": "<sys_hub_flow sys_id>", "inputs": { ... } }`
- **Response:** `{ "ok": true, "contextId": "<sys_flow_context sys_id>", "outputs": { ... } }`

## Resource script (scoped, ES5 — ServiceNow server engine)

```js
(function process(request, response) {
  var body = request.body.data || {};
  var flowSysId = body.flowSysId;
  var inputs = body.inputs || {};

  if (!flowSysId) {
    response.setStatus(400);
    return { ok: false, error: "flowSysId is required" };
  }

  // Resolve the flow's internal_name — FlowAPI addresses flows/subflows by
  // scoped name (scope.internal_name), not by sys_id.
  var flowGr = new GlideRecord("sys_hub_flow");
  if (!flowGr.get(flowSysId)) {
    response.setStatus(404);
    return { ok: false, error: "flow not found: " + flowSysId };
  }
  var scopeName = flowGr.sys_scope.scope
    ? flowGr.sys_scope.scope.toString()
    : "global";
  var qualifiedName = scopeName + "." + flowGr.internal_name.toString();
  var isSubflow = flowGr.type.toString() === "subflow";

  try {
    // Foreground run so we can return outputs synchronously. Use inBackground()
    // / startAsync() for long-running flows and poll sys_flow_context instead.
    var runner = isSubflow
      ? sn_fd.FlowAPI.getRunner()
          .inForeground()
          .fromSubflow(qualifiedName)
          .withInputs(inputs)
          .run()
      : sn_fd.FlowAPI.getRunner()
          .inForeground()
          .fromFlow(qualifiedName)
          .withInputs(inputs)
          .run();

    var contextId = runner.getContextId ? runner.getContextId() : "";
    var outputs = runner.getOutputs ? runner.getOutputs() : {};
    return { ok: true, contextId: contextId, outputs: outputs };
  } catch (e) {
    response.setStatus(500);
    return { ok: false, error: e.message };
  }
})(request, response);
```

> **Verify the FlowAPI fluent call on your target instance** — the
> `getRunner().inForeground().fromSubflow(name).withInputs(...).run()` chain is
> the documented shape, but method names have shifted slightly across releases
> (`fromFlow` / `fromSubflow` / `withInputs` / `run` / `getOutputs`). Confirm
> against `sn_fd.FlowAPI` on the instance before relying on it. Action types are
> normally exercised inside a flow; to run one directly, wrap it in a one-step
> test subflow.

## Deploy

Create the Scripted REST API + resource in the `x_cadso` Dovetail scope (UI, or
via Dovetail `createRecord` into `sys_ws_definition` + `sys_ws_operation`), add
an ACL restricting it to the integration role, then point `testFlow` at it (it
defaults to `/api/cadso/dovetail/runFlow`).
