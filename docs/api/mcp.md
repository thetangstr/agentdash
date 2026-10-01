---
title: MCP endpoints
summary: The two Model Context Protocol endpoints — one for an agent key, one for an assistant's OAuth grant.
---

The instance serves the Model Context Protocol over streamable HTTP at two paths. `POST /api/mcp` takes an agent key and serves that agent's tools. `POST /api/mcp/assistant` takes an OAuth access token and serves an assistant's tools for one person.

**Source:** `server/src/routes/mcp.ts` · **In the reference:** [MCP endpoints](/api/reference#tag/mcp)

## Who may call it

| Operation | Who |
| --- | --- |
| `mcpAgent` | an agent, with its agent key as `Authorization: Bearer` |
| `mcpAssistant` | an assistant, with an OAuth access token (`pcpa_…`) minted against a person's grant |

Each endpoint refuses the other's credential. A board key or a session gets neither. How to connect a harness, and what `agentdash-connect` writes, is on [Connecting](/mcp/connecting). How the server picks a credential's actor is on [Authentication](/api/authentication).

The examples assume:

```bash
export AGENTDASH_KEY="pcp_…"     # an agent key; see /api/api-keys
export AGENTDASH_TOKEN="pcpa_…"  # an assistant access token, from the OAuth flow
```

## How both endpoints behave

Both are built on the MCP SDK's `StreamableHTTPServerTransport` and set up the same way in `server/src/routes/mcp.ts`:

- **JSON-RPC 2.0 in, JSON out.** POST one JSON-RPC message, or a batch, and the response is a JSON body (`enableJsonResponse: true`), not an event stream.
- **Stateless.** `sessionIdGenerator` is `undefined`. Each POST gets a new server. There is no `Mcp-Session-Id`, and a request after `initialize` does not need one.
- **Headers the SDK requires.** `Accept` must list both `application/json` and `text/event-stream`. `Content-Type` must be `application/json`.
- **Notifications.** A POST with only notifications, such as `notifications/initialized`, answers `202` with no body.
- **Tool calls run as the caller.** The server calls the instance's own REST API over `127.0.0.1`. `/api/mcp` uses the caller's agent key. `/api/mcp/assistant` uses a short-lived internal credential that carries the grant's company and scopes and is revoked when the response closes (`server/src/services/assistant-loopback.ts`). A tool can do nothing the credential could not.

Errors from the transport come back as JSON-RPC error objects with `id: null` (`@modelcontextprotocol/sdk`, `server/webStandardStreamableHttp.js`, version 1.29.0 in `server/node_modules`):

```json
{ "jsonrpc": "2.0", "error": { "code": -32000, "message": "Not Acceptable: Client must accept both application/json and text/event-stream" }, "id": null }
```

## Agent endpoint

`POST /api/mcp` · [`mcpAgent`](/api/reference#tag/mcp/mcpAgent)

Serves the `agent` toolset for the agent whose key is presented. The middleware resolves the key to its agent and company. The server starts with that agent and company. Its `instructions` are that agent's playbook ([Playbooks](/mcp/playbooks)). The toolset is always `agent`; `AGENTDASH_TOOLSET` does not apply here. The tools are listed in [the agent tool reference](/mcp/tools/agent).

Initialize:

```bash
curl -X POST https://your-instance.example/api/mcp \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": { "name": "my-client", "version": "0.0.1" } } }'
```

List the tools. Because the endpoint is stateless, this can be its own POST:

```bash
curl -X POST https://your-instance.example/api/mcp \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }'
```

**Response** `200` — a JSON-RPC response. For `initialize`, `result` carries `protocolVersion`, `capabilities`, `serverInfo` (`name` is `agentdash`) and `instructions`. For `tools/list`, `result.tools` is an array of `{ name, description, inputSchema }`.

The key must be sent as `Authorization: Bearer`. The `x-agent-key` header works on REST routes, but not here: the endpoint reuses the bearer for its tool calls.

| Status | When |
| --- | --- |
| 400 | A JSON-RPC message the transport cannot read: `Parse error: Invalid JSON-RPC message` (code `-32700`); `Invalid Request: Only one initialization request is allowed` (code `-32600`) for a batch with two `initialize` calls; or `Bad Request: Unsupported protocol version: …` (code `-32000`) for an unknown `Mcp-Protocol-Version` header. |
| 500 | `Internal server error` — the body is not JSON at all. The server's JSON body parser (`server/src/app.ts`) rejects it before the MCP transport sees it, and the error handler answers 500. |
| 401 | `Connect with an agent key: Authorization: Bearer <key>. …` — the credential is not an agent's: none, one that does not resolve, a board key, a session or an endpoint token. |
| 401 | `Authorization: Bearer <agent key> is required` — the agent key arrived only as `x-agent-key`. |
| 403 | `Assistant credentials cannot reach this route` — a live `pcpa_` token (`server/src/middleware/auth.ts`). |
| 403 | `This principal is read-only`, `code: "EVALUATOR_READ_ONLY"` — the key belongs to a read-only agent, whose POSTs are refused outside a short allowlist (`server/src/middleware/auth.ts`). |
| 406 | `Not Acceptable: Client must accept both application/json and text/event-stream` (code `-32000`). |
| 415 | `Unsupported Media Type: Content-Type must be application/json` (code `-32000`). |
| 500 | JSON-RPC error `-32603`, `Internal error handling MCP request` — the server failed while handling the request. |

## Assistant endpoint

`POST /api/mcp/assistant` · [`mcpAssistant`](/api/reference#tag/mcp/mcpAssistant)

Serves the `assistant` toolset for one person in one company, through an assistant they have granted access. The grant's scopes filter what is offered. A grant without `agentdash:work` is not shown the work tools, and one without `agentdash:decide` is not shown the gated tools. The tools, grouped by the scope that unlocks them, are in [the assistant tool reference](/mcp/tools/assistant). [Toolsets](/mcp/toolsets) explains how the sets differ.

A `pcpa_` token reaches this one route and no other (`ASSISTANT_ROUTE_SCOPES` in `packages/shared/src/assistant-oauth.ts`). An access token lives one hour (`ASSISTANT_ACCESS_TOKEN_TTL_MS`, same file).

```bash
curl -X POST https://your-instance.example/api/mcp/assistant \
  -H "Authorization: Bearer $AGENTDASH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }'
```

`initialize` takes the same body as on the agent endpoint.

**Response** `200` — a JSON-RPC response, as above.

**The 401 challenge.** Without a usable assistant token, the endpoint answers `401` with `{ "error": "invalid_token" }` and this header:

```
WWW-Authenticate: Bearer resource_metadata="https://your-instance.example/.well-known/oauth-protected-resource/api/mcp/assistant", scope="agentdash:read", error="invalid_token", error_description="An assistant access token is required"
```

The `resource_metadata` URL starts the OAuth flow. A client fetches it, finds the authorization server, and then reads that server's metadata to find the authorize, token and register endpoints. See [OAuth metadata](/api/oauth). The host in the URL is the instance's configured public URL. Without one, it is the request's own origin (`issuerBaseUrl` in `server/src/services/assistant-oauth.ts`).

**Origin.** A request that sends an `Origin` header must send one the instance recognizes: its own host, over http or https, or its configured public URL. A client that sends no `Origin` is accepted.

| Status | When |
| --- | --- |
| 400 | A JSON-RPC parse or protocol-version error from the transport, as on the agent endpoint. |
| 401 | `invalid_token`, with the `WWW-Authenticate` challenge above — no token, or one that does not resolve (expired, revoked, or minted for another instance), or any other kind of credential. |
| 403 | `insufficient_scope`, with `required_scope: "agentdash:read"` and a `WWW-Authenticate` header carrying `error="insufficient_scope"` — the grant lacks `agentdash:read` (`server/src/middleware/auth.ts`). |
| 403 | `Untrusted Origin` — the `Origin` header names an origin the instance does not recognize. |
| 406 | `Not Acceptable: Client must accept both application/json and text/event-stream`. |
| 415 | `Unsupported Media Type: Content-Type must be application/json`. |
| 500 | JSON-RPC error `-32603`, `Internal error handling MCP request`. |

## Everything else

Any operation can also answer 429 when rate limited — see [Conventions](/api/conventions). Writes made by assistant tools also draw on the grant's own hourly write budget ([Authentication](/api/authentication)). Other routes on this resource (`GET` and `DELETE` on both paths, which answer 405 because the endpoints are stateless) are internal — see [the route index](/api/route-index), under `mcp`.
