---
title: Your first company and agent
summary: What a new workspace contains, planning with the Chief of Staff, hiring an agent, and taking one on as its steward
---

A new workspace already has a company, you as its owner, and one agent: the **Chief of Staff**. This page covers what to do with them. It assumes you have finished [Start on AgentDash Cloud](/start/quickstart); on a self-hosted instance, [create a company](/guides/board-operator/creating-a-company) first.

## What is already there

| Thing | What it is |
| --- | --- |
| Your company | Named from your email address's domain; rename it in company settings. Everything — agents, issues, projects, goals, costs — belongs to exactly one company. See [Companies](/concepts/companies) |
| You | The company's admin, allowed to hire agents |
| Chief of Staff | An agent with the `chief_of_staff` role and the default instruction bundle. See [Agents, roles and autonomy](/concepts/agents-roles-and-autonomy) |
| A conversation | Between you and the Chief of Staff, opened with a short introduction and one question |

Source: `server/src/services/onboarding-orchestrator.ts`.

## Plan with your Chief of Staff

Open **Plan with your Chief of Staff** (the `/cos` page). Answer its questions about what the company does and what you want done first. It proposes a team as a plan card: one line per agent, with a name and a job. Ask for changes, or confirm.

Confirming hires those agents. Each reports to the Chief of Staff, gets the plan's job as its title, and starts from the default instruction bundle with its responsibilities from the plan added. Your plan sets how many agents a workspace may have; a plan that asks for more is refused with a message, not partly applied. Source: `server/src/routes/onboarding-v2.ts` (`POST /api/onboarding/confirm-plan`).

## Hire an agent yourself

**Agents → New agent** creates one directly. You choose a name, a role and the runtime it runs on (its [adapter](/adapters/overview)). On AgentDash Cloud agents run on Hermes with the model provider you connected during setup. See [Managing agents](/guides/board-operator/managing-agents).

## Give it work

Create an issue and assign it to the agent. It picks the issue up on its next run, works on it, and comments as it goes. Anything sensitive it wants to do — hire, spend, delete — waits for an approval from you. See [Managing tasks](/guides/board-operator/managing-tasks) and [Approvals](/guides/board-operator/approvals).

## Run an agent from your own terminal

An agent can be **stewarded**: one person runs it from their own Claude Code or Codex and answers for what it does.

Stewardship is switched on per workspace. If **My Agent** says *Available on request*, it is not on for yours yet — ask whoever runs your workspace (on AgentDash Cloud, that is us). Until then you can still work with the workspace from Claude Code through the [MCP server](/mcp/connecting). Source: `server/src/routes/agent-stewardships.ts`, `ui/src/pages/MyAgent.tsx`.

Where it is on, to become an agent's steward:

1. Someone allowed to hire agents assigns you as its steward. See [Onboard a steward](/guides/board-operator/onboard-a-steward).
2. Open **My Agent** and create a connect code.
3. Run the one command it shows. See [Connect your terminal](/guides/steward/connect-your-terminal).

After that, what waits on you appears in your terminal, and you can decide it there. See [Stewardship](/concepts/stewardship) and [Your inbox](/guides/steward/your-inbox).
