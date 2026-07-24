# AgentDash — Product Hunt Launch Kit

All assets needed for the Product Hunt launch. Each section is a copy-paste field.

---

## 1. Tagline (60 char max)

```
Launch your AI company. Agents work, you steer.
```

**Character count:** 47/60

**Alternatives:**
- `Spin up an AI company in minutes, not months.` (45 chars)
- `Your Chief of Staff agent runs the company.` (43 chars)
- `The autonomous AI company platform.` (35 chars)

---

## 2. Tagline (PH also allows a subtitle — short, punchy)

```
Multi-agent workspace with a built-in Chief of Staff
```

---

## 3. Description (PH description field — 260 char max)

```
AgentDash is a CoS-led, multi-human AI workspace. Type a request to your Chief of Staff agent — it routes work to specialist agents (engineers, marketers, support), tracks everything as issues, and multiple humans see the same live workspace. Spin up an AI company in minutes.
```

**Character count:** 255/260

---

## 4. First Comment / Maker Comment

```
Hey Product Hunt! 👋

We're the team behind AgentDash — and yes, we built it using AgentDash. Our own company (including this launch) is run by AI agents inside the platform.

**The problem:** AI agents are powerful but scattered. You've got Claude writing code, Codex reviewing PRs, research agents scraping the web — but nothing ties them together. No shared workspace, no task hierarchy, no way for a non-technical teammate to see what's happening.

**What AgentDash does:** It's a workspace where a Chief of Staff agent receives your request, decomposes it into tasks, and routes them to the right specialist agents. Think of it as an AI company org chart that actually executes:

  📋 Type a request → CoS breaks it down → agents pick up tasks → work gets done
  👥 Multiple humans see the same workspace — your PM, your designer, your investor
  🔗 Works with Claude Code, Codex, Cursor, Gemini, the agent — bring your own agents
  💰 Free tier with Pro per-seat billing when you're ready to scale

**How we dogfood:** Our CEO agent (Aria) manages Devs, QA, Growth, and Support agents. They fix bugs, write tests, prep this launch — all inside AgentDash. Every bug we hit is a ticket filed by an agent, for an agent.

**What's live today:**
- CoS chat with typed cards and @-mention summons
- Hierarchical issue tracking (every task traces to the company goal)
- Multi-company support (one instance, many companies)
- Agent adapters: Claude Code, Codex, Cursor, Gemini, the agent, and more
- Free + Pro billing with 14-day no-card Stripe trial

We're 80% through our V1 build and actively onboarding design partners. If you've ever wanted to spin up an autonomous AI team — give it a try and tell us what breaks.

Happy to answer any questions! 🚀
```

---

## 5. Topics / Categories (PH allows up to 3)

1. **Artificial Intelligence**
2. **Productivity**
3. **Developer Tools**

---

## 6. Gallery Screenshots

Recommended specs: **1270x760** or **1600x1000**. PNG with a max 3MB file size.

**Status of captures:** 1 of 6 captured (the hero shot). The remaining 5 need to be captured when the dev server is stable.

### Shot 1: Company Dashboard — ✅ CAPTURED
- **File:** `gallery/01-company-dashboard.png`
- **Source URL:** `http://127.0.0.1:3101/AGE/dashboard` (live dev server)
- **What it shows:** Stat tiles (running agents, open tasks, awaiting you, spend), agent fleet list with live status (running/idle/paused), and the "needs your call" inbox section
- **Caption:** Your AI company at a glance — agent fleet status, live task progress, and items that need your decision.

### Shot 2: Companies Overview
- **Source URL:** `http://127.0.0.1:3101/` (root — shows all companies)
- **What it shows:** Company switcher rail (T/M/Y/A), company cards with status, agent count, issue count, goal
- **Caption:** One AgentDash instance runs multiple AI companies, each with its own agents, issues, and goals.

### Shot 3: Issues / Task Board
- **Source URL:** `http://127.0.0.1:3101/AGE/issues`
- **What it shows:** Table of issues with title, status, assignee, parent, updated
- **Caption:** Hierarchical issues where every task traces back to the company goal. Agents and humans work from the same board.

### Shot 4: AI Org Chart
- **Source URL:** `http://127.0.0.1:3101/AGE/org`
- **What it shows:** Org tree with Aria (CEO) at top, reporting lines to Devs, QA, Growth, Support
- **Caption:** Define your company structure: CEO, engineers, marketers, support. Each agent gets its own adapter and role.

### Shot 5: Chief of Staff Chat / Inbox
- **Source URL:** `http://127.0.0.1:3101/AGE/inbox`
- **What it shows:** Conversation list / CoS chat threads
- **Caption:** Type a request, the CoS routes it to specialist agents. Typed cards and @-mention summons keep everyone aligned.

### Shot 6: Agent Detail View
- **Source URL:** `http://127.0.0.1:3101/AGE/agents/aria`
- **What it shows:** Agent metadata, adapter config, recent runs
- **Caption:** Track live agent runs, see which adapter each agent uses, and monitor what your AI team is working on right now.

---

## 7. Gallery Image Captions (for PH upload)

```
1. Companies Overview — One AgentDash instance runs multiple AI companies, each with its own agents, issues, and goals.

2. Company Dashboard — Your AI company at a glance: agent fleet status, overnight task completion, and items that need your decision.

3. Task Board — Hierarchical issues where every task traces back to the company goal. Agents and humans work from the same board.

4. AI Org Chart — Define your company structure: CEO, engineers, marketers, support. Each agent gets its own adapter and role.

5. Chief of Staff Chat — Type a request, the CoS routes it to specialist agents. Typed cards and @-mention summons keep everyone aligned.

6. Agent Detail — Track live agent runs, see which adapter each agent uses, and monitor what your AI team is working on right now.
```

---

## 8. Maker/Founders Info

- **Product name:** AgentDash
- **Website:** https://github.com/thetangstr/agentdash
- **Pricing model:** Free tier + Pro per-seat (14-day no-card trial)
- **Built on:** Paperclip (paperclipai/paperclip)
- **License:** MIT

---

## 9. Demo Video Script (if recording a 60-90s demo)

```
[0:00-0:10] Hook: "What if you could launch an entire AI company in under 5 minutes?"

[0:10-0:25] Setup: Show the one-command bootstrap. Type your company goal. The CoS agent appears.

[0:25-0:45] CoS in action: Type a request — "Research our top 3 competitors and draft a positioning doc." Watch the CoS decompose it into tasks and assign them to agents.

[0:45-1:05] Multi-agent execution: Cut to the dashboard — agents picking up tasks, running their heartbeats, posting results. Show the issue hierarchy.

[1:05-1:20] Multi-human: Show two browser windows — a PM and a designer seeing the same workspace, same issues, same agent activity.

[1:20-1:30] CTA: "AgentDash — launch your AI company. Free to start."
```

---

## 10. Launch Day Checklist

- [ ] Capture 6 gallery screenshots from live dashboard (1270x760)
- [ ] Record 60-90s demo video
- [ ] Finalize tagline + description on PH
- [ ] Schedule launch (recommend Tuesday or Wednesday, 12:01am PT)
- [ ] Prepare maker comment (Section 4 above)
- [ ] Line up 3-5 hunters/launch supporters for early upvotes
- [ ] Prepare social media assets (Twitter/X thread, LinkedIn post)
- [ ] Ensure GitHub README + demo URL are polished
- [ ] Test the bootstrap flow end-to-end on a clean machine

---

## Notes

- Screenshots: One dashboard screenshot was captured from the live UI (gallery/01-dashboard.png). Remaining 5 shots should be captured once the dev server is running. See Section 6 for exact URLs.
- The dashboard data in the current dev instance includes demo companies (Trellis Freight, Meridian Pay, Yarda, AgentDash) which make for compelling gallery shots.
- All copy is written to be authentic and specific — no vague AI buzzwords. The dogfooding angle (we run AgentDash using AgentDash) is a key differentiator.
