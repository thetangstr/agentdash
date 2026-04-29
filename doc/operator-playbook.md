# Board Operator Playbook

**Audience:** the human in your company who oversees the AI workforce — usually CEO, COO, or VP of Ops.
**Time investment:** 30 min onboarding · 60 sec/day · ~30 min/week.
**Outcome:** by end of week 1, you trust the system enough to step away from it for a day.

---

## What "Board Operator" means

You don't manage agents the way you manage humans — you set goals, approve scaling decisions, watch for trouble, and step in when something needs a human. The agents do the work. AgentDash is the interface that makes oversight cheap.

---

## 30-minute onboarding agenda

| Min | Step | What you do |
|---:|---|---|
| 0–5 | **Tour the dashboard** | Open `/`. Read the top line ("Good morning. Your workforce is on-track."). Look at MRR, daily burn, issues in flight, approvals pending. |
| 5–10 | **Open the Agents page** | `/agents`. Each card is one agent. Status dot = green/amber/red. Click one to see what it's doing right now. |
| 10–15 | **Open Issues** | `/issues`. This is the work queue. Anything blocked or needing attention is highlighted. |
| 15–20 | **Walk through Approvals** | `/approvals`. Anything an agent wants you to OK lives here — spawn requests, scope expansions, content the agent isn't sure about. |
| 20–25 | **Test the kill switch** | Security page → HALT ALL AGENTS → confirm. Watch the status flip. Resume. *Do this once now so it's not scary later.* |
| 25–30 | **Set your first goal** | `/goals` → New Goal. Describe a business outcome ("hit $20K MRR by July"). The Chief of Staff agent will propose tasks to get there. |

That's it. You're trained.

---

## Daily routine — 60 seconds

Open `/` once a day. Scan in this order:

1. **The headline:** "on-track" or "X items need your attention." If on-track, you can close the tab.
2. **Approvals pending:** if non-zero, click. Approve or reject each one (1-click).
3. **Daily burn vs. budget:** if the trend is red, spot-check before the day starts.

If the headline is green and approvals are 0, you're done. Close the tab. Get coffee.

---

## Weekly routine — ~30 minutes

Once a week (suggest: Monday morning before standup):

1. **Read the weekly auto-report** (sent Monday 8am): pipeline numbers, top wins, top blockers.
2. **Review escalations:** any issue an agent flagged for human input. Decide → respond in the issue thread.
3. **Tune budgets:** anything over forecast, anything underused. Adjust on the agent detail page.
4. **One spawn or retire:** based on the week's data, do one of: spawn a new agent for a gap, retire an agent that's not earning its budget, or do nothing (most weeks).

---

## When something is wrong — escalation paths

| Signal | What it means | What you do |
|---|---|---|
| **Status dot is red** on an agent | Last heartbeat failed | Click → read the error → if you can't tell, escalate to AgentDash support |
| **Burn rate spikes** | Agent looped or did expensive work | Agent detail → recent runs → look for the spike → consider tightening the agent's budget cap |
| **Approval queue grows** | Agents are uncertain more than usual | Read 3 of them — pattern? If yes, the agent's instructions probably need updating |
| **Issues stuck in "blocked"** | Dependency unresolved | Issue detail → see what's blocking → unblock manually or escalate |
| **Customer complaint** about agent output | Agent did something wrong | **Halt the offending agent** (per-agent kill, not company-wide), then triage |
| **You're not sure** | Anything weird | **HALT ALL AGENTS** is always safe. They resume on your one-click. Better halt and ask than let it run. |

---

## Glossary (because the words matter)

| Term | What it means |
|---|---|
| **Agent** | One AI worker. Has a role, an adapter (e.g. Claude, Codex), a budget, and an OKR. Operates inside policies you set. |
| **Adapter** | The LLM provider this agent talks to (Claude local, Claude API, Codex, Gemini, etc.). Mostly invisible day-to-day. |
| **Run** | One unit of work an agent executes — pick up a task, do it, report back. |
| **Heartbeat** | The signal an agent is alive. If heartbeats stop, the agent is shown as red. |
| **OKR** | The agent's objective + measurable key results. Set on the agent detail page. |
| **Spawn request** | An agent asking permission to scale (create more like itself). Lands in your Approvals queue. |
| **Pipeline** | A multi-stage workflow with hand-offs and HITL gates. Agents execute the stages. |
| **Approval** | Anything an agent wants your sign-off on before doing. Always a 1-click decision. |
| **Kill switch** | The HALT ALL AGENTS button. Stops everything in seconds. Always reversible. |
| **Tier** | Your AgentDash plan (Free / Pro / Enterprise). Caps agents, monthly actions, and feature access. |
| **Track A** | The AI agent workforce (what you operate). |
| **Track B** | Sanctioned employee-built apps (the IT-controlled alternative to your team pasting data into ChatGPT). |

---

## Things you should *never* have to do

- Edit code
- Read logs by hand
- SSH into a server
- Manage agent prompts directly (use the Agent Instructions UI)
- Recover from a failed run (the system retries)

If you find yourself doing any of these, escalate to AgentDash support — the system is supposed to make these invisible to you.

---

## The one principle

**Trust the dashboard, halt anything weird, ship one improvement a week.** That's the job.

---

## Related docs

- [`doc/clients/mkthink/day-1-checklist.md`](clients/mkthink/day-1-checklist.md) — first-day live walkthrough for the MKthink pilot
- [`doc/PRD.md`](PRD.md) — full product overview with all 19 CUJs
- [`doc/BUSINESS-PLAN.md`](BUSINESS-PLAN.md) — pricing and pilot structure if you're sizing a contract
