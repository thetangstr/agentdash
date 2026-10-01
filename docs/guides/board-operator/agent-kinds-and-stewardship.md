---
title: Agent Kinds & Stewardship
summary: Autonomous, stewarded, and "Needs a steward" — what each agent kind means and how to finish pairing
audience: admin
order: 6
---

Every agent in your company is one of three kinds. The Agents page shows the kind on every agent row and on the agent detail page, so you can always tell "this agent is meant to run alone" apart from "this agent is waiting for somebody to pair with it".

## The three kinds

| Kind | Badge | What it means |
|------|-------|---------------|
| **Autonomous** | `Autonomous` | Nobody runs this agent from a terminal. It works on its own, has no connect code or API key, and answers to the one person who is **accountable** for it. |
| **Stewarded** | `Stewarded` | One person runs this agent from their own terminal and answers for what it does. One person, one agent: it is reachable from that person's **My Agent** page, and escalations reach them directly. |
| **Stewarded but unpaired** | `Needs a steward` | This agent is meant to be run by one person, but nobody is paired with it yet. It has no My Agent page, no connect code, and its escalations reach no one. |

The badges always match how the agent behaves — the docs and the product never disagree.

## What "Needs a steward" means

An agent with the amber **Needs a steward** badge is fully configured and can already receive work, but it is missing one thing: the human it belongs to.

Until pairing is finished:

- The agent has no **My Agent** page — nobody can run it from their own terminal.
- It has no connect code or agent key.
- Escalations and approvals it raises have no one to reach.

Nothing is broken — the agent is simply waiting for you to finish setting it up.

When the company's agent visibility is set to *People see the agents they answer for*, an unpaired agent is visible to administrators only until someone is paired with it.

## How an unpaired agent gets born

A stewarded-but-unpaired agent appears when **an agent hires another agent** without an accountable user attached. For example, your CEO agent requests to hire an engineer; if no person is designated as that new agent's steward at hire time, the agent is created stewarded-but-unpaired. This is expected — not a malfunction.

An agent a person creates is paired automatically with its creator — but only if that person does not already steward an agent. Stewardship is one person to one agent, so the second agent you create starts as **Needs a steward** too.

## Finishing pairing

The agent keeps the amber **Needs a steward** badge until someone is paired. To fix it:

1. Open **Company Settings → Access**.
2. In the **Agent stewardship** panel, select the unpaired agent and the person who will run it.
3. Assign the stewardship.

If the panel says *Available on request*, stewardship is not switched on for this workspace; ask whoever runs your instance.

Or via the API:

```
POST /api/companies/{companyId}/agent-stewardships
{ "agentId": "...", "userId": "..." }
```

The agent's detail page shows **No steward assigned** while the state is unpaired, so you can confirm from either place. Once the stewardship is assigned, the badge changes to **Stewarded** and the paired person gets a **My Agent** page with a connect code for their terminal.

> **Tip:** Don't need a human for this one? An administrator can make an unpaired agent **Autonomous** instead — `PATCH /api/agents/{agentId}` with `{ "autonomy": "autonomous" }` — then nobody pairs with it, it runs on its own, and you become accountable for it unless you name someone else (`accountableUserId`).
