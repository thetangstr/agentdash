---
title: OAuth metadata
summary: The public discovery documents an assistant client reads to find the instance's OAuth endpoints.
---

An assistant that connects to `POST /api/mcp/assistant` gets its access token through OAuth 2.1. These three documents tell the client where to get one. They are public, take no credential, and are served at the app root, not under `/api`.

**Source:** `server/src/routes/oauth.ts` · **In the reference:** [OAuth metadata](/api/reference#tag/oauth)

## Who may call it

Anyone. No credential is needed, and none is checked.

The examples need no setup.

## How a client uses them

1. The client calls `POST /api/mcp/assistant` without a token. The answer is `401` with a `WWW-Authenticate` header whose `resource_metadata` names the protected-resource document ([MCP endpoints](/api/mcp)).
2. The client fetches that document. Its `authorization_servers` lists one issuer URL.
3. The client fetches `<issuer>/.well-known/oauth-authorization-server`. That document names the register, authorize, token and revoke endpoints, and says what they support: the `code` response type, PKCE with `S256`, and public clients only.
4. The client registers, or uses an https URL naming its client metadata document as its `client_id`. It sends the person through the authorize endpoint and exchanges the code at the token endpoint. It sends the protected-resource document's `resource` value as the RFC 8707 `resource` parameter. The token it gets is bound to that value: the middleware rejects a token whose resource is not this instance's assistant URI (`server/src/middleware/auth.ts`).

The scopes, and what each allows, are on [Authentication](/api/authentication). The person's side of this flow is on [Connecting](/mcp/connecting).

**The base URL.** Every URL in these documents starts with the instance's configured public URL (`configuredPublicBaseUrl` in `server/src/lib/public-base-url.ts`). If none is configured, an instance in `local_trusted` mode uses the request's own origin. An instance in `authenticated` mode answers `500` instead of advertising a host taken from the request (`issuerBaseUrlStrict` in `server/src/services/assistant-oauth.ts`).

## Protected-resource metadata

`GET /.well-known/oauth-protected-resource` · [`getProtectedResourceMetadata`](/api/reference#tag/oauth/getProtectedResourceMetadata)

RFC 9728 metadata for the assistant MCP endpoint.

```bash
curl https://your-instance.example/.well-known/oauth-protected-resource
```

**Response** `200`:

```json
{
  "resource": "https://your-instance.example/api/mcp/assistant",
  "authorization_servers": ["https://your-instance.example"],
  "scopes_supported": ["agentdash:read", "agentdash:work", "agentdash:decide"],
  "bearer_methods_supported": ["header"],
  "resource_name": "AgentDash assistant MCP"
}
```

| Field | Notes |
| --- | --- |
| `resource` | The base URL plus `/api/mcp/assistant` (`assistantResourceUri`). Access tokens are bound to exactly this string. |
| `authorization_servers` | One entry: the issuer, which is the base URL. |
| `scopes_supported` | `ASSISTANT_SCOPES` in `packages/shared/src/assistant-oauth.ts`. |
| `bearer_methods_supported` | `header` only: send the token as `Authorization: Bearer`. |
| `resource_name` | A fixed display name. |

| Status | When |
| --- | --- |
| 500 | `{ "error": "server_error", "error_description": "This instance has no configured public base URL (PAPERCLIP_PUBLIC_URL) — assistant credentials cannot be issued" }` — `authenticated` mode with no configured public URL. |

## Protected-resource metadata, path-suffixed

`GET /.well-known/oauth-protected-resource/api/mcp/assistant` · [`getAssistantProtectedResourceMetadata`](/api/reference#tag/oauth/getAssistantProtectedResourceMetadata)

The same document, at the location RFC 9728 derives from the resource's path. Clients try this one first. It is the URL the `401` challenge names.

```bash
curl https://your-instance.example/.well-known/oauth-protected-resource/api/mcp/assistant
```

**Response** `200` — identical to the document above. Both are built by the same function.

| Status | When |
| --- | --- |
| 500 | `server_error`, as above. |

## Authorization-server metadata

`GET /.well-known/oauth-authorization-server` · [`getAuthorizationServerMetadata`](/api/reference#tag/oauth/getAuthorizationServerMetadata)

RFC 8414 metadata for the instance's authorization server.

```bash
curl https://your-instance.example/.well-known/oauth-authorization-server
```

**Response** `200`:

```json
{
  "issuer": "https://your-instance.example",
  "authorization_endpoint": "https://your-instance.example/oauth/authorize",
  "token_endpoint": "https://your-instance.example/oauth/token",
  "registration_endpoint": "https://your-instance.example/oauth/register",
  "revocation_endpoint": "https://your-instance.example/oauth/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["agentdash:read", "agentdash:work", "agentdash:decide"],
  "client_id_metadata_document_supported": true,
  "resource_parameter_supported": true
}
```

| Field | Notes |
| --- | --- |
| `issuer` | The base URL. |
| `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint` | The base URL plus `/oauth/authorize`, `/oauth/token`, `/oauth/register` and `/oauth/revoke`. Read them from here rather than building them. |
| `response_types_supported` | `code` only. |
| `grant_types_supported` | `authorization_code` and `refresh_token`. |
| `code_challenge_methods_supported` | `S256` only: PKCE is required in its SHA-256 form. |
| `token_endpoint_auth_methods_supported` | `none`: clients are public and hold no secret. |
| `scopes_supported` | Same as above. |
| `client_id_metadata_document_supported` | `true`: a `client_id` may be an https URL naming a client metadata document, instead of registering. |
| `resource_parameter_supported` | `true`: the token endpoint honors the RFC 8707 `resource` parameter. |

| Status | When |
| --- | --- |
| 500 | `server_error`, as above. |

## Everything else

Any operation can also answer 429 when rate limited (limits are off on a `local_trusted` instance): 200 requests per 15-minute window for these documents by default (`AGENTDASH_RATE_LIMIT_OAUTH_META_MAX` in `server/src/routes/oauth.ts`) — see [Conventions](/api/conventions). The OAuth endpoints themselves (register, authorize, consent, token and revoke, under `/oauth/*`) are internal — see [the route index](/api/route-index), under `oauth`.
