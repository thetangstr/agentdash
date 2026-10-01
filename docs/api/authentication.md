---
title: Authentication
summary: The seven credentials the server accepts, how each is sent, and what each may reach.
---

Every request passes through one middleware, `server/src/middleware/auth.ts`, which turns the credential it carries into an **actor**: a person (a *board* actor), an agent, or an enrolled machine. Routes then decide what that actor may do. This page describes that middleware; where it says "the server", it means that file unless another is named.

## The seven actor sources

| Source | Credential | Sent as | Acts as | Lifetime |
| --- | --- | --- | --- | --- |
| `local_implicit` | none | nothing | the local operator, an instance admin | while the instance runs in `local_trusted` mode |
| `session` | the web app's sign-in cookie | `Cookie` | the signed-in person | the session |
| `board_key` | a board API key, `pcp_board_…` | `Authorization: Bearer` | the person who approved it | 30 days |
| `assistant_grant` | an OAuth access token, `pcpa_…` | `Authorization: Bearer` | one person, in one company, through their assistant | the OAuth grant |
| `agent_key` | an agent API key, `pcp_…` | `Authorization: Bearer`, or `x-agent-key` | one agent, in one company | until revoked |
| `agent_jwt` | a run token the server issues to a local agent run | `Authorization: Bearer` | that agent, for that run | 48 hours by default |
| `bridge_endpoint` | an enrolled machine's endpoint token | `Authorization: Bearer` | that machine, on the bridge routes only | until revoked |

How to get a board key or an agent key, and how to revoke one, is on [API keys](/api/api-keys).

## How a credential is resolved

The server tries, in order:

1. **No `Authorization` header and no `x-agent-key` header.** In `local_trusted` mode the request is the local operator (`local_implicit`). In `authenticated` mode the server looks for a session cookie (`session`). Otherwise the request is unauthenticated.
2. **A bearer token starting `pcpa_`** is an assistant access token. It is checked against this instance's assistant resource URI; a token minted for another instance or resource resolves to nothing. It is never looked up as any other kind of key.
3. **A board key.** Expired and revoked keys do not resolve.
4. **An endpoint token**, but only when the path is one of the bridge routes below. On any other path the token is not even looked up.
5. **An agent key.** Revoked keys do not resolve, and neither does a key whose agent is terminated or still pending approval.
6. **An agent run token** (a signed JWT). Same agent-status rules.

A credential that does not resolve leaves the request **unauthenticated** — the route answers 401. The bridge routes are the exception: without a live endpoint token they answer 403 `Bridge endpoint authentication required` ([Bridge](/api/bridge)). Sending any explicit credential switches off the implicit local operator: in `local_trusted` mode a wrong key is unauthenticated, not the operator.

### `x-agent-key`

When a request has no `Authorization: Bearer` header, the server reads the `x-agent-key` header and validates it exactly as a bearer token. Agent instructions tell agents to send their key this way; both forms work.

### `X-Paperclip-Run-Id`

An agent working inside a run sends the run's id in this header so that what it does is attributed to the run. It is optional, must be a UUID, and is ignored otherwise. For an `agent_jwt` actor the run the token was issued for is recorded as well, and a header cannot override it.

## What each actor may reach

**Board actors** — `local_implicit`, `session`, `board_key` and `assistant_grant` — are people.

- A person reaches the companies they are an active member of. An instance admin reaches every company. The local operator is an instance admin. A company-scoped route for a company you are not a member of answers 403 (`server/src/routes/authz.ts`, `assertCompanyAccess`).
- Inside a company, what you may change depends on your role and permissions there, which each route checks. A board key has no scopes of its own: it can do whatever the person who approved it can do.
- A state-changing request on a **session** must come from a trusted browser origin (its `Origin` or `Referer`), or it is refused with 403 `Board mutation requires trusted browser origin` (`server/src/middleware/board-mutation-guard.ts`). Board keys, assistant grants and the local operator are not browser cookies and are exempt.

**Human control** (`/api/human-control/*`) takes a **board key** and nothing else: no session cookie, no assistant grant, no agent. Anything else answers 403 `Named board-key human authentication required` (`server/src/services/human-control.ts`).

Several contract routes are for people only and answer 403 to any agent credential — usually `Board access required`, as for listing and creating companies, pausing and resuming agents, managing agent keys, deciding approvals and managing secrets. Goals and projects refuse agents with their own message (`Agents cannot change company direction…`, `Agents cannot create projects.`). [The API reference](/api/reference) lists the accepted credentials on every operation, and each resource page lists who may call it.

**Assistant grants** are the narrowest board actor. A `pcpa_` token reaches exactly one route, the assistant MCP endpoint `POST /api/mcp/assistant` (`ASSISTANT_ROUTE_SCOPES` in `packages/shared/src/assistant-oauth.ts`). Anything else answers 403 even with a live token. The grant is for one company, and its scopes decide which MCP tools exist:

| Scope | Allows |
| --- | --- |
| `agentdash:read` | reading the company's work |
| `agentdash:work` | creating and moving work, waking agents |
| `agentdash:decide` | resolving approvals and hiring; offered at consent, never granted by default |

A request whose grant lacks the scope a route needs answers 403 `insufficient_scope` with the `required_scope`. Writes through an assistant are also budgeted per grant: 30 writes and 10 new tasks an hour (`packages/shared/src/assistant-oauth.ts`). The OAuth endpoints and their discovery documents are listed in [the API reference](/api/reference).

**Agent actors** — `agent_key` and `agent_jwt` — are one agent in one company. An agent credential cannot reach another company: those routes answer 403 `Agent key cannot access another company`. What an agent may do inside its company is decided by its role, its permissions and its mandate, which each route checks. Some agents are read-only principals; any state-changing request from one, outside a short allowlist, answers 403 with a `code` saying so.

**Bridge endpoints** reach only these routes, and are treated as no credential everywhere else:

```
POST /api/bridge/poll        POST /api/bridge/inbox/sync     POST /api/bridge/inbox/agents
POST /api/bridge/result      POST /api/bridge/inbox/ack      POST /api/bridge/inbox/propose
POST /api/bridge/decline     POST /api/bridge/inbox/decide   POST /api/bridge/inbox/confirm
```

An endpoint token decides nothing on its own: the inbox routes that act on an approval spend a separate single-use handle, minted for that one decision.

### The MCP endpoints

- `POST /api/mcp` takes an **agent key** as a bearer token and serves that agent's tools. Without one it answers 401.
- `POST /api/mcp/assistant` takes an **assistant grant**. Without one it answers 401 with a `WWW-Authenticate` header pointing at the OAuth discovery document, which is how an assistant client starts the OAuth flow.

## 401 or 403

- **401** — the request has no credential the server could resolve. Send one.
- **403** — the server knows who you are, and you may not do this: no membership in that company, a missing permission, a read-only principal, a credential that cannot reach this route, or a missing scope.
- **404** — inside a company you belong to, something you are not allowed to see answers 404, not 403. See [Conventions](/api/conventions).
