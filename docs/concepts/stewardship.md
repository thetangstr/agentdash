---
title: Stewardship
summary: The one-to-one pairing between a person and the agent they run, and how AgentDash decides who is accountable for an agent.
---

A stewardship pairs one person with one stewarded agent. The person is the agent's **steward**: they run it from their own terminal, look after it, and answer for what it does.

Source: `packages/db/src/schema/agent_stewardships.ts`, `server/src/services/agent-accountability.ts`, `server/src/routes/agent-stewardships.ts`

## The pairing

Each row in `agent_stewardships` names a company, an agent and a user, plus who assigned it, who ended it, a transfer reason, and `startedAt` / `endedAt`. A row with no `endedAt` is the active pairing.

- **One-to-one in both directions.** At most one active steward per agent, and at most one active stewarded agent per person per company. Two partial unique indexes enforce this (`agent_stewardships_active_agent_uq`, `agent_stewardships_active_user_uq`).
- **History is kept.** Ending or transferring a pairing closes the row; it is never deleted.
- **Only stewarded agents are paired.** An agent with `autonomy` = `autonomous` has no steward. The server refuses to make a paired agent autonomous while its stewardship is active.

## Who is accountable

`accountable` is the person an agent's work reaches when it needs a human. The server resolves it in one place, `agentAccountabilityService`:

| Agent | Accountable person | `via` |
| --- | --- | --- |
| Stewarded, paired | The active steward | `steward` |
| Autonomous | `agents.accountableUserId` | `assignment` |
| Stewarded, not paired | Nobody yet | `unpaired` |

An unpaired stewarded agent shows the **Needs a steward** badge. It can receive work, but its escalations reach no one until someone is paired with it. `agents.createdByUserId` is provenance only and never changes; accountability can move.

## Changing a pairing

| Route | What it does |
| --- | --- |
| `POST /api/companies/{companyId}/agent-stewardships` | Assign a new pairing (`agentId`, `userId`). |
| `POST /api/companies/{companyId}/agents/{agentId}/stewardship/transfer` | Move the agent to another person. |
| `POST /api/companies/{companyId}/agents/{agentId}/stewardship/release` | End the pairing. |
| `GET /api/companies/{companyId}/agents/{agentId}/stewardship` and `/history` | Read the active pairing and past ones. |

Changing a pairing needs a human board actor with the `agents:create` permission. Stewardship cannot be set through `PATCH /api/agents/{id}`: a body carrying `steward` or `stewardUserId` gets 422.

Assigning a new pairing, and the **My Agent** page (`GET /api/companies/{companyId}/me/agent`), are a per-workspace capability. A workspace without it answers 404 on those routes. Transfer and release stay open everywhere, so an existing pairing can always be unwound.

See also: [Agent kinds and stewardship](/guides/board-operator/agent-kinds-and-stewardship) · [Onboard a steward](/guides/board-operator/onboard-a-steward) · [Agents API](/api/agents) · [Agents, roles and autonomy](/concepts/agents-roles-and-autonomy)
