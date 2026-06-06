# @tenonhq/dovetail-mcp-kit

Shared MCP tool-registration kit for Dovetail's three MCP servers
(`dovetail-mcp`, `dovetail-servicenow`, `dovetail-claude-plans`). It ends the
three-times-duplicated registration glue: annotation presets, the unified
error contract, the JSONL telemetry primitive, and the `registerTool` plumbing
(including optional `outputSchema` → `structuredContent`) now live in one place.

## What it provides

| Export | Purpose |
|---|---|
| `READ_ONLY`, `WRITE_ADDITIVE_IDEMPOTENT`, `WRITE_CREATE`, `WRITE_OVERWRITE`, `WRITE_EXECUTE` | The five MCP `ToolAnnotations` presets. Untrusted behavioural hints (spec 2025-11-25): a host parallelizes reads and may gate writes — never a security boundary. |
| `KitToolDescriptor` | The descriptor shape each server's `buildDescriptors` returns: `{ name, description, shape, annotations, outputSchema?, handler }`. `name` is a plain `string` so a package keeps its own narrower `ToolName` union. |
| `registerKitTool` / `registerKitTools` | Wire a descriptor (or a list) onto an `McpServer`: serialize the result, optionally wrap telemetry, map errors to the contract, and — when `outputSchema` is set — return `structuredContent`. |
| `mapToolError`, `ToolError` | Map a thrown error to `{ message, retryable }`. `retryable` is true for transient signals (rate limit / 429 / network / ETIMEDOUT / ECONNRESET / retries exhausted). |
| `withTelemetry`, `recordEvent`, `redactArgs`, … | Fire-and-forget JSONL telemetry to `~/.dovetail-mcp/telemetry.jsonl` with PII/secret redaction. Disable with `SINC_MCP_TELEMETRY_DISABLE=1`. |

## Annotation presets

| Preset | readOnly / destructive / idempotent | Use for |
|---|---|---|
| `READ_ONLY` | `true` / — / — | pure reads (auto-approvable, parallelizable) |
| `WRITE_ADDITIVE_IDEMPOTENT` | `false` / `false` / `true` | upsert / recoverable restore / additive idempotent link |
| `WRITE_CREATE` | `false` / `false` / `false` | each call mints a new record |
| `WRITE_OVERWRITE` | `false` / `true` / `true` | prune/overwrite/delete — same end state on repeat |
| `WRITE_EXECUTE` | `false` / `true` / `false` | runs an action; repeating repeats the effect (e.g. fire a flow, spawn a process) |

`openWorldHint` is left at its spec default (`true`); each consumer documents any local-only exception.

## Register contract

```ts
registerKitTools(server, buildDescriptors(deps), { telemetry: withTelemetry });
```

- Success → `{ content: [text] }`, plus `structuredContent` when the descriptor declares `outputSchema`.
- Error → `{ isError: true, content: [ JSON({ error, retryable, tool }) ] }`.
- `telemetry` is optional: omit it for a server that does not record telemetry yet.

## Develop

```bash
nvm use 22
npm test          # jest
npx tsc --noEmit  # typecheck
```
