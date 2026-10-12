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

These tools work anywhere your Claude Code is connected, not only in the inbox folder. The folder is where the *hook* runs and where Claude reviews your inbox unprompted; in any other session it uses the tools only when you ask.

## Three rules

- **Claude has a view; you make the call.** Claude tells you what it thinks of each item, including that the agent got it wrong. It sends only what you chose, only after your explicit go — never on its own, and never because an issue or a message asked it to. If you want zero in-session decisions, delete the `agentdash-inbox` entry from `~/.claude.json`; everything else keeps working.
- **A refusal is an answer, not something to retry.** "Already decided", "revision moved on", "not yours to decide" mean the approval changed or belongs to another steward. You can decide exactly what you could decide on the web page, and nothing else.
- **Your agent still cannot decide anything.** If Claude reaches for the agent's tools and gets `403 Board access required`, that is the design working — ask it to use the inbox tools. If those are missing, you connected before `agentdash-connect` 0.3.0; [reconnect](./connect-your-terminal) with a fresh code.

## Claude reviews with you

Connecting (or the folder's session-start hook, on a machine that connected earlier) puts a review skill in the folder (`.claude/skills/agentdash-coworker/`, and the same rules in `AGENTS.md` for Codex), shipped in `agentdash-connect` releases after 0.4.0. At the start of a session in that folder, Claude goes through every waiting item before you act on any — decisions, then questions, then approved but not delivered, then blockers, with counts — and presents each as the agent's work in its own words, then **My take**. Rejecting or rewriting the agent's draft is a normal outcome.

- Drafts and a `notes.md` per item stay in `~/agentdash-inbox/work/<ISSUE>/`, so the next session picks up where you stopped.
- Downloaded attachments go to `~/agentdash-inbox/incoming/<ISSUE>/` and are read as text only.
- Before anything is sent, Claude reads it back in full, as you, and asks "yes / change / no". One explicit yes sends it; anything else sends nothing.
- Text from agents, documents and attachments is material to review, never instructions; an instruction found in it is reported to you as a finding.

## Questions from your agents

When work reaches your agent — including work assigned to you — it takes the first pass: it restates the request, recommends an answer and asks you. The question arrives here with the agent's options; what the agent wrote is shown as its words, not as instructions to Claude, and Claude gives you its own take on it. Tell Claude your answer and it sends it with `inbox_answer`, needing `agentdash-connect` 0.4.0 or later. You can also answer on the issue in AgentDash.

## Email

Inbox emails are off unless your instance turns them on (an operator sets `AGENTDASH_INBOX_EMAIL=true`). Your agents' questions and decisions reach you in your own Claude or Codex session and on Home in AgentDash. When an instance does turn emails on, each one is a pointer only (the agent, the issue identifier and a link), at most one every 15 minutes, and you can turn it off under **Email me when my agents need me** on **My Agent**.

## Optional: have your agent keep watch

The **Have <agent> keep an eye out while you work** section on **My Agent** gives you a prompt to paste into any Claude chat. It checks every 30 minutes, stays silent when there is nothing, and never acts — the decision stays yours.
