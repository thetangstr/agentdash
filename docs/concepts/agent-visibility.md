---
title: Agent visibility
summary: Who may see which agents — the rule, the two admin-only settings, and why a hidden agent answers 404.
---

Agent visibility decides which agents a company member can see at all. By default every member sees every agent. An admin can switch a company, or a single agent, so that members see only the agents they answer for.

Source: `server/src/routes/visibility.ts`, `packages/db/src/schema/agents.ts`, `packages/db/src/schema/companies.ts`, `doc/plans/2026-09-30-agent-visibility.md`

## The two knobs

Both are admin-only. Values come from `AGENT_VISIBILITIES` in `packages/shared/src/constants.ts`: `company` or `owner`.

| Knob | Column | Default | Set with |
| --- | --- | --- | --- |
| Company default | `companies.agentVisibilityDefault` | `company` | `PATCH /api/companies/{companyId}` |
| Per-agent override | `agents.visibility` | null (inherit the company default) | `PATCH /api/agents/{id}` |

In the web app: **Settings → Access → Agent visibility** for the default, and **Access** on the agent page for the override. A non-admin who sends either field gets 403.

## The rule

Each agent resolves to its own `visibility`, or the company default if that is null.

- **`company`** — every member sees it.
- **`owner`** — a member sees it only if they answer for it (its active steward, or its `accountableUserId`), it reports to an agent they answer for (through `reportsTo`, at any depth), or they created it.

Who is exempt: company admins, instance admins and the local board see everything. Agents are not subject to the rule; they keep full visibility of their company. The rule applies to a person's session, board key and assistant grant.

Issues follow the agents. When the company default is `owner`, a member sees an issue when a visible agent is assigned to it or created it, when they are assigned to it or created it, or when it is in a project they are listed on. When the default is `company`, a member sees every issue except those attributed to an agent hidden from them. The restricted-project rule still applies on top.

## Hidden means 404, not 403

A hidden agent answers **404** `Agent not found` on every `/api/agents/{id}` route, exactly as an id that does not exist (`assertAgentIdVisible`). Lists leave it out. A 403 would confirm the id is real, which is itself the leak.

An unpaired stewarded agent in `owner` mode is visible to admins only until someone is paired with it.

See also: [Agent kinds and stewardship](/guides/board-operator/agent-kinds-and-stewardship) · [Onboard a steward](/guides/board-operator/onboard-a-steward) · [Agents API](/api/agents) · [Conventions](/api/conventions) · [Stewardship](/concepts/stewardship)
