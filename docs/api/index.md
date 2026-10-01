---
title: The AgentDash API
summary: What the HTTP API contract covers, what "internal" means, and where to start.
---

Everything the web app does, it does through one HTTP API: JSON over HTTPS, under `/api` on your instance. The CLI, the MCP server and `agentdash-connect` use the same API. You can too.

```
{{instanceUrl}}/api
```

## The contract

Part of the API is a **contract**: a published list of operations, each with its request and response schema, that AgentDash promises to keep. A contract operation is not removed or renamed without a deprecation cycle. The contract covers the resources an integration needs:

- **[Health](/api/health)** — is the server up.
- **[Companies](/api/companies), [agents](/api/agents), [issues](/api/issues), [projects](/api/projects), [goals](/api/goals)** — the work and who does it.
- **[Approvals](/api/approvals)** — decisions a person must make before an agent proceeds.
- **[Routines](/api/routines)** — recurring work.
- **[Costs](/api/costs), [activity](/api/activity), [dashboard](/api/dashboard)** — what was spent, what happened, where things stand.
- **[Secrets](/api/secrets)** — values agents reference without seeing.
- **[Human control](/api/human-control)** — the operations a person's own assistant may run for them.
- **[Bridge](/api/bridge)** — how an enrolled machine picks up and returns work.
- **[MCP endpoints](/api/mcp)** — `POST /api/mcp` and `POST /api/mcp/assistant`.
- **[OAuth metadata](/api/oauth)** — the discovery documents an assistant client reads first.

Each resource page says who may call it and shows every contract operation with a `curl` example, the body fields that matter, the response, and the errors the handler returns.

[The API reference](/api/reference) lists every contract operation with its parameters, body, responses and auth. It is rendered from `docs/api/openapi.yaml`, an OpenAPI 3.1 document you can download from the same page and feed to a client generator.

## What "internal" means

The server registers far more routes than the contract lists. The web app uses them; you may see them in your browser's network tab. They are **internal**: they can change or disappear in any release, without notice. [The route index](/api/route-index) lists every one, so you can see what exists — it says which are in the contract and labels the rest internal. If you need an internal route, ask for it to be added to the contract rather than building on it.

## How the promise is kept

Neither list is written by hand where it can be generated:

- The route index is generated from the route files (`scripts/docs/generate-route-index.mjs`). Its header states the measured route count.
- The contract is one hand-maintained manifest, `docs/api/contract.json`, naming which routes are in it. The OpenAPI document is generated from that manifest, the request validators and the response types in `packages/shared` (`scripts/docs/generate-openapi.mjs`).
- CI fails a change that renames or removes a contract route, or that changes a validator or type without regenerating the reference (`scripts/ci/check-api-reference-drift.mjs`).

The contract is version `v1`. What may change, and how a breaking change is announced, is on [Versioning and deprecation](/api/versioning). What has changed is on [the API changelog](/api/changelog).

## Where to start

1. [Authentication](/api/authentication) — the credentials the server accepts and what each one may reach.
2. [API keys](/api/api-keys) — how to get a board key or an agent key, and how to revoke one.
3. [Conventions](/api/conventions) — ids, errors, visibility, pagination and rate limits.
4. [The API reference](/api/reference) — every contract operation, and a page per resource with examples.
5. [Versioning and deprecation](/api/versioning) — what the contract promises over time.
