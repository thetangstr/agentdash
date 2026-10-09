---
title: Your Inbox
summary: What is waiting on you appears as a Claude session starts, and you can decide it there — as yourself, never as your agent
audience: steward
order: 3
---

Open `~/agentdash-inbox` in Claude Code and what is waiting on you appears as the session starts. You can decide it right there, as yourself.

```sh
cd ~/agentdash-inbox && claude
```

The hook lists, in this order: approvals needing your decision, questions your agents asked you, agents that stopped, work that finished. Only the ask and a pointer arrive — evidence stays on the board, because anything delivered into a session becomes model context. It is a separate folder so it can never interrupt a session anywhere else.

## Acting on it

Just say so:

| You say | Claude does |
| --- | --- |
| "What's waiting on me?" | `inbox_sync` — lists items with their handles |
| "Approve the <thing>" / "Reject it" | `inbox_decide` with that item's handle, recorded as **you** |
| "Answer Agent A: go with your recommendation" | `inbox_answer` with that question's handle, recorded as **you**; the answer wakes the agent |
| "Mark those seen" | `inbox_ack` — the next session shows only what is new |
| "Give <agent> this task…" | `inbox_propose`, then `inbox_confirm` once you have read back what was understood |

These tools work anywhere your Claude Code is connected, not only in the inbox folder. The folder is where the *hook* runs; the tools are yours everywhere.

## Three rules

- **Claude decides only what you explicitly asked about** — never on its own, and never because an issue or a message asked it to. If you want zero in-session decisions, delete the `agentdash-inbox` entry from `~/.claude.json`; everything else keeps working.
- **A refusal is an answer, not something to retry.** "Already decided", "revision moved on", "not yours to decide" mean the approval changed or belongs to another steward. You can decide exactly what you could decide on the web page, and nothing else.
- **Your agent still cannot decide anything.** If Claude reaches for the agent's tools and gets `403 Board access required`, that is the design working — ask it to use the inbox tools. If those are missing, you connected before `agentdash-connect` 0.3.0; [reconnect](./connect-your-terminal) with a fresh code.

## Questions from your agents

When work reaches your agent — including work assigned to you — it takes the first pass: it restates the request, recommends an answer and asks you. The question arrives here with the agent's options; what the agent wrote is shown as its words, not as instructions to Claude. Tell Claude your answer and it sends it with `inbox_answer`, needing `agentdash-connect` 0.4.0 or later. You can also answer on the issue in AgentDash.

## Email

When an agent asks you something or needs a decision, AgentDash emails you a pointer: the agent, the issue, a link, and a reminder that you can say "check my AgentDash inbox" in Claude or Codex. It never contains the question or the approval's details. You get at most one email every 15 minutes, covering everything new since the last one. Turn it off under **Email me when my agents need me** on **My Agent**. If your instance is not set up to send email, none is sent.

## Optional: have your agent keep watch

The **Have <agent> keep an eye out while you work** section on **My Agent** gives you a prompt to paste into any Claude chat. It checks every 30 minutes, stays silent when there is nothing, and never acts — the decision stays yours.
