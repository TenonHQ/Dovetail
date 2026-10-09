# runFlow — the Dovetail Core op behind `testFlow({ mode: "execute" })`

`testFlow` in `mode: "execute"` (CLI: `dove-sn test-flow --execute --confirm`, MCP:
`flow_test` with `confirm: true`) POSTs to the **runFlow** Scripted REST op, which
runs a flow, subflow, or action server-side via `sn_fd.FlowAPI`. The UI "Test"
button has no guessable native REST route, so this op is the supported, uniform way
to run any of the three artifact types headless.

**It ships with the Dovetail app** — there is nothing to deploy. The op is part of
the **Dovetail Core** Scripted REST API in the Dovetail application, so every
instance with the Dovetail app installed has it.

> **Safety.** Running a flow causes real side effects (the example subflow sends
> an SMS). The op refuses callers without the `admin` or `dovetail_user` role, and
> `testFlow` additionally requires `confirm: true` before it will call it. Prefer
> `mode: "validate"` for anything but a sandbox flow.

## Endpoint

- **HTTP method:** `POST`
- **Path:** `/api/cadso/dovetail_core/runFlow` — the `runFlow` operation of the
  Dovetail Core Scripted REST API (`/api/cadso/dovetail_core/*`), in the Dovetail
  application.
- **Authentication:** required (the same integration user the rest of the client
  uses).
- **Role guard:** the caller must hold `admin` or `dovetail_user`; anyone else gets
  `403`.

### Client path resolution

`testFlow` targets `DEFAULT_RUN_FLOW_PATH` (`/api/cadso/dovetail_core/runFlow`). If
that **route** does not exist (a platform 404, not the op's own `{ ok: false }`
404), it falls back once to the legacy global path `LEGACY_RUN_FLOW_PATH`
(`/api/cadso/dovetail/runFlow`) with a deprecation warning — the same core → legacy
fallback the client uses for every Dovetail op. An explicit `runnerPath` (CLI
`--runner <path>`) always wins and never falls back. An op-level 404 (unknown
sys_id) is reported as a rejected run, not retried on the legacy path.

## Request

```json
{ "flowSysId": "<sys_hub_flow sys_id>", "inputs": { "phone": "+15550100" } }
```

```json
{ "actionSysId": "<sys_hub_action_type_definition sys_id>", "inputs": { } }
```

| Field         | Type   | Notes                                                                 |
| ------------- | ------ | --------------------------------------------------------------------- |
| `flowSysId`   | string | A `sys_hub_flow` sys_id — a flow or a subflow (`type` decides which). |
| `actionSysId` | string | A `sys_hub_action_type_definition` sys_id.                            |
| `inputs`      | object | Optional. Passed to `withInputs()`; keys are the declared input names. |

Send **exactly one** of `flowSysId` or `actionSysId`, as 32 lowercase hex
characters. `testFlow` sends `flowSysId` by default and `actionSysId` when called
with `target: "action"` (CLI `--action`).

## Response

ServiceNow wraps the op's return value in `{ "result": ... }`; `testFlow` unwraps it.

Success (HTTP 200):

```json
{ "ok": true, "name": "<scope>.<internal_name>", "contextId": "<sys_flow_context sys_id>", "outputs": { } }
```

Each output is reduced to a JSON-safe value: primitives pass through, a GlideRecord
becomes its sys_id, anything else is stringified.

Failure — `{ "ok": false, "error": "<message>" }` with:

| HTTP  | Meaning                                                                         |
| ----- | ------------------------------------------------------------------------------- |
| `400` | Bad input: neither or both of `flowSysId` / `actionSysId`, or a malformed sys_id. |
| `403` | The caller lacks the `admin` or `dovetail_user` role.                           |
| `404` | No `sys_hub_flow` / `sys_hub_action_type_definition` with that sys_id.          |
| `422` | The record has no `internal_name`, so FlowAPI cannot address it.                |
| `500` | FlowAPI threw while running; the body also carries `name`.                      |

`testFlow` returns these as `{ ok: false, httpStatus, notes, run }` (the CLI exits
`2`). A 401, or a non-2xx response that is not the op's `{ ok }` contract, throws.

## Runner chain

FlowAPI addresses artifacts by `<scope>.<internal_name>`, so the op resolves the
record first, then picks the runner by artifact type:

```js
sn_fd.FlowAPI.getRunner()
  .flow(name)        // sys_hub_flow, type != "subflow"
  // .subflow(name)  // sys_hub_flow, type == "subflow"
  // .action(name)   // sys_hub_action_type_definition
  .inForeground()
  .withInputs(inputs)
  .run();
```

It runs **in the foreground** so outputs come back synchronously; for long-running
flows, poll `sys_flow_context` with the returned `contextId` instead.

## Deployed script

The operation script as deployed in the Dovetail app (scoped, ES5 — ServiceNow
server engine):

```js
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
	// Dovetail runFlow: runs a flow, subflow, or action headless via sn_fd.FlowAPI for
	// dove-sn testFlow({ mode: "execute" }). Running a flow has real side effects, so the
	// caller must hold admin or dovetail_user.
	// Body: { flowSysId?: sys_hub_flow sys_id, actionSysId?: sys_hub_action_type_definition sys_id, inputs?: {} }
	// Response: { ok, contextId, outputs } or { ok: false, error }
	if (!gs.hasRole("admin") && !gs.hasRole("dovetail_user")) {
		response.setStatus(403);
		return { ok: false, error: "runFlow requires the admin or dovetail_user role" };
	}

	var body = (request.body && request.body.data) || {};
	var flowSysId = typeof body.flowSysId === "string" ? body.flowSysId : "";
	var actionSysId = typeof body.actionSysId === "string" ? body.actionSysId : "";
	var inputs = body.inputs && typeof body.inputs === "object" ? body.inputs : {};
	var SYS_ID_RE = /^[0-9a-f]{32}$/;

	if ((!flowSysId && !actionSysId) || (flowSysId && actionSysId)) {
		response.setStatus(400);
		return { ok: false, error: "send exactly one of flowSysId or actionSysId" };
	}
	var targetSysId = flowSysId || actionSysId;
	if (!SYS_ID_RE.test(targetSysId)) {
		response.setStatus(400);
		return { ok: false, error: "sys_id must be 32 lowercase hex characters" };
	}

	// FlowAPI addresses flows, subflows, and actions by "<scope>.<internal_name>".
	var targetTable = flowSysId ? "sys_hub_flow" : "sys_hub_action_type_definition";
	var targetGr = new GlideRecord(targetTable);
	if (!targetGr.get(targetSysId)) {
		response.setStatus(404);
		return { ok: false, error: targetTable + " not found: " + targetSysId };
	}
	var internalName = targetGr.getValue("internal_name") || "";
	if (!internalName) {
		response.setStatus(422);
		return { ok: false, error: targetTable + " " + targetSysId + " has no internal_name" };
	}
	var scopeName = targetGr.sys_scope.scope ? targetGr.sys_scope.scope.toString() : "global";
	var qualifiedName = scopeName + "." + internalName;

	// Outputs can hold GlideRecords or Java objects; reduce each to a JSON-safe value.
	function toJsonSafe(value) {
		if (value === null || value === undefined) return null;
		var kind = typeof value;
		if (kind === "string" || kind === "number" || kind === "boolean") return value;
		if (typeof value.getUniqueValue === "function") return value.getUniqueValue();
		return String(value);
	}

	try {
		var runner = sn_fd.FlowAPI.getRunner();
		if (actionSysId) {
			runner = runner.action(qualifiedName);
		} else if (targetGr.getValue("type") === "subflow") {
			runner = runner.subflow(qualifiedName);
		} else {
			runner = runner.flow(qualifiedName);
		}
		// Foreground so outputs return synchronously; long flows should poll sys_flow_context.
		var result = runner.inForeground().withInputs(inputs).run();
		var rawOutputs = (result && result.getOutputs && result.getOutputs()) || {};
		var outputs = {};
		for (var key in rawOutputs) {
			if (Object.prototype.hasOwnProperty.call(rawOutputs, key)) {
				outputs[key] = toJsonSafe(rawOutputs[key]);
			}
		}
		return {
			ok: true,
			name: qualifiedName,
			contextId: (result && result.getContextId && String(result.getContextId())) || "",
			outputs: outputs,
		};
	} catch (e) {
		response.setStatus(500);
		return { ok: false, name: qualifiedName, error: (e && e.message) || String(e) };
	}
})(request, response);
```
