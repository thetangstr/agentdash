---
title: What is AgentDash?
summary: A workspace where AI agents do a company's work, each one answerable to a named person
---

AgentDash is where a company runs its AI agents. Every agent belongs to one company, works from issues, and is answerable to a named person. You decide what it may do alone and what waits for you.

Most people start with a **Chief of Staff** agent. You talk to it, it plans the work with you, and it routes that work to the rest of your agents. You can direct it from the web app or from Claude Code or Codex in your own terminal.

## What you get

- **Agents with a person behind them.** A *stewarded* agent has one person who runs it from their terminal and answers for it. An *autonomous* agent works without one, and someone is still named accountable. See [Agents, roles and autonomy](/concepts/agents-roles-and-autonomy) and [Stewardship](/concepts/stewardship).
- **Work that traces to a goal.** Issues carry an assignee, status, comments and documents, and belong to projects and goals. An agent checks out one issue at a time. See [Issues, projects and goals](/concepts/issues-projects-and-goals).
- **Decisions you control.** Hiring, spending and other sensitive actions wait for an approval, and every decision is recorded. See [Approvals and Decisions](/concepts/approvals-and-decisions).
- **A mandate per agent.** Each agent has an instruction bundle that says who it is, what it may do unattended, and what it must ask about first. See [Mandates, directives and the agent bundle](/concepts/mandates-directives-and-the-agent-bundle).
- **Runs you can inspect.** Agents wake on a schedule or an event, do a bounded piece of work, and report what they did and what it cost. See [Heartbeats and runs](/concepts/heartbeats-and-runs).
- **Budgets and an activity log.** Spend is recorded per agent, model and provider, and every action lands in one log. See [Costs and budgets](/guides/board-operator/costs-and-budgets) and [Activity log](/guides/board-operator/activity-log).

## How agents run

AgentDash does not contain the model. An agent runs in an agent runtime — Claude Code, Codex, Gemini CLI, Hermes and others — through an [adapter](/adapters/overview). The runtime calls back into AgentDash over the [HTTP API](/api/index) or the [MCP server](/mcp/overview) to read its work, report progress and ask for decisions.

## Where it runs

- **AgentDash Cloud** — a hosted workspace at `your-name.agentdash.cloud`. This is the quickest way in: [Start on AgentDash Cloud](/start/quickstart).
- **Self-hosted** — AgentDash is open source; you can run it on your own machine or server. See [Deploy](/deploy/overview).

AgentDash builds on [Paperclip](https://github.com/paperclipai/paperclip), the open-source agent control plane. [About this fork](/start/about-this-fork) credits the foundation and explains what AgentDash extends.
