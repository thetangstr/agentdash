---
title: HTTP adapter
summary: Trigger an agent that runs as your own service with one HTTP request
---

The `http` adapter sends one HTTP request to a service you run. The service does the work and calls the AgentDash API itself. The web UI's agent picker does not offer it; set it through the [agents API](/api/agents).

Source: `server/src/adapters/http/` (`index.ts`, `execute.ts`, `test.ts`).

## When to use it

- The agent runs as a service somewhere else: a cloud function, a dedicated server, another platform.
- Fire-and-forget is enough. The run ends when your service answers.

If the agent runs on the server host and you want its output in the run log, use [`process`](/adapters/process) or a CLI adapter instead. The `http` adapter records no stdout.

## Configuration fields

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | Endpoint to call. Must be `http` or `https`. |
| `method` | string | No | HTTP method. Default `POST`. |
| `headers` | object | No | Extra request headers. `content-type: application/json` is always set. |
| `payloadTemplate` | object | No | Fields merged into the request body. |
| `timeoutSec` | number | No | Request timeout in seconds. A finite number takes precedence over `timeoutMs`. `0` or negative means none. |
| `timeoutMs` | number | No | Legacy timeout in milliseconds, used when `timeoutSec` is absent or not a finite number. `0`, negative, or unset means none. |

Use `timeoutSec` for new configurations. Numeric strings are not converted. Positive delays are capped at `2147483647` milliseconds (about 24.9 days), so a value beyond the Node timer limit does not become an immediate timeout. If neither field contains a finite positive number, the request has no timeout.

## Request body

The body is your `payloadTemplate` with three fields added:

```json
{
  "agentId": "...",
  "runId": "...",
  "context": { "...": "the run context: task, wake reason, comment, and so on" }
}
```

## Result

- A 2xx response ends the run as a success with the summary `HTTP <method> <url>`. The response body is not stored.
- Any other status fails the run.
- A timeout fails the run as timed out.

The adapter does not pass an API key. Your service needs its own [agent API key](/api/api-keys) to call back to AgentDash.
