---
title: Mandates, directives and the agent bundle
summary: The three things that shape what an agent does — its instruction bundle (with the mandate file), steward directives, and mandate grants of delegated authority.
---

Three different things tell an agent what to do. The **instruction bundle** holds its standing instructions; its entry file is the agent's mandate. **Directives** are free text a steward pushes to their own agent. A **mandate grant** (the `mandates` table) is a bounded delegation of authority from one agent to another.

Source: `server/src/services/default-agent-instructions.ts`, `packages/db/src/schema/agent_directives.ts`, `packages/db/src/schema/mandates.ts`, `packages/db/src/schema/mandate_attestations.ts`

## The instruction bundle

Every agent has a bundle of instruction files. Its entry file, `AGENTS.md`, is the agent's **mandate**: who it is, what it may do unattended, what needs a person first, and what it must never do. Read it with `GET /api/agents/{id}/instructions-bundle` or the MCP tool `agentdashGetMyMandate`. Edit files with `PUT /api/agents/{id}/instructions-bundle/file`.

A new agent starts from the default files in `server/src/onboarding-assets/default/`. Every role in `AGENT_ROLES` gets the same set.

| File | What kind of file it is |
| --- | --- |
| `AGENTS.md` | The entry file and mandate. |
| `HEARTBEAT.md` | A checklist the agent runs on each heartbeat. |
| `SOUL.md` | The agent's persona and its relationship to its steward. |
| `TOOLS.md` | Notes on the agent's tools; starts nearly empty. |
| `INTERVIEW.md` | The onboarding interview prompt (`server/src/services/cos-interview.ts`). It is not copied into an agent's bundle. |

Whether a run actually sees the bundle depends on the adapter (`server/src/adapters/instructions-bundle-support.ts`).

## Directives

Directives are the steward's own voice to their agent: free-text operating instructions and explicit don'ts.

- **They inform; they never grant.** No authorization check reads them. Capability lives in the agent's governance policy.
- **Append-only.** Each push gets the next `version` and seals the previous one with `supersededAt`. One live version per agent, enforced by `agent_directives_active_uq`.
- **Only the active steward pushes.** Not an admin on their behalf. Others get 403.

Routes: `GET` and `POST /api/companies/{companyId}/agents/{agentId}/directives`. The push response says whether the agent's adapter delivers directives to the runtime (`server/src/adapters/runtime-directives-support.ts`). Directives are a per-workspace capability; a workspace without it answers 404.

## Mandate grants

A row in `mandates` lets a grantor agent delegate a bounded authority to a grantee agent: a `scope`, a `permissionKey`, a `spendCapCents`, an optional budget policy and a required `expiresAt`. `status` is `active`, `expired` or `revoked`. A grant may be published to a counterparty company, which accepts it (`acceptedAt`).

Each attempted mandated action writes a `mandate_attestations` row, authorized or denied. An attempt that is expired, over its cap or out of scope files a `mandate_violation` approval and pauses the grantee with reason `mandate`.

Creating or publishing a grant needs a person who may set company direction (`server/src/routes/mandates.ts`).

See also: [How agents work](/guides/agent-developer/how-agents-work) · [Agents API](/api/agents) · [Approvals and decisions](/concepts/approvals-and-decisions) · [Stewardship](/concepts/stewardship)
