# MKThink AgentDash — Welcome Guide

Welcome to AgentDash! Your AI workforce is now live on your Mac mini. This guide covers everything you need to know to get started.

---

## Your Dashboard

**URL:** `http://<your-mac-mini-ip>:3100`

Bookmark this on your browser. This is your command center — where you create tasks, monitor agents, review work, and control costs.

**First time:** Sign up with your work email. The Chief of Staff (CoS) will guide you through setting up your agent team.

---

## Your Agent Team

Based on MKThink's work as a strategy and innovation consultancy, your agents likely include:

| Agent | Role | What It Does |
|-------|------|-------------|
| **Chief of Staff** | CoS | Routes work, answers questions, proposes plans |
| **Research Agent** | Research | Competitive analysis, market research, data gathering |
| **Content Agent** | Writing | Drafts proposals, reports, client communications, blog posts |
| **Operations Agent** | Ops | Project tracking, status reports, process documentation |
| **Client Success** | Support | Deadline reminders, follow-up tracking, client summaries |

You can add more agents anytime through the CoS chat or the Agents page.

---

## How Work Gets Done

1. **You create a task** — on the dashboard, via the CoS chat, or by texting your CEO agent
2. **The CoS assigns it** — to the best agent for the job (or you assign it manually)
3. **The agent picks it up** — within 30 minutes (the heartbeat interval)
4. **The agent works** — reading the task, using its tools, producing output
5. **The agent reports back** — marks the task done, posts a comment with results
6. **You review** — check the dashboard for completed work and provide feedback

---

## What to Do Right Now

1. **Log in** at `http://<your-mac-mini-ip>:3100`
2. **Complete the CoS onboarding** if you haven't already (go to `/cos`)
3. **Create your first task:** "Write a one-paragraph company description for MKThink based on our website at mkthink.com"
4. **Watch it get picked up** — check the dashboard in 5-10 minutes
5. **Review the result** — open the task to see what the agent produced

---

## What AgentDash Is NOT

- **Not a chatbot** — agents don't respond instantly. They work on schedules.
- **Not a search engine** — agents produce analysis and work products, not quick answers.
- **Not a replacement for humans** — agents handle repetitive work; strategic decisions stay with you.
- **Not always right** — review all agent output before using it externally. Agents can make mistakes.

---

## Cost Expectations

Your pilot is **free for 6 months**. You provide the AI tokens (via your Anthropic API key or Claude subscription).

| Setup | Your monthly cost | What you get |
|-------|------------------|-------------|
| Anthropic API (Sonnet 5) | ~$50-150/mo depending on usage | Full cost tracking, budget enforcement |
| Claude Code subscription | $0 extra (uses your plan) | No cost tracking, subject to plan limits |
| Gemini CLI (free tier) | $0 | 1,000 requests/day cap |
| Local model (Ollama) | $0 | Runs on your hardware |

**Budget enforcement:** If you set a monthly budget cap (e.g., $100), agents auto-pause when spending hits that amount. You'll never get a surprise bill.

---

## Getting Help

| Need | How |
|------|-----|
| Something broken | [File a GitHub issue](https://github.com/thetangstr/agentdash/issues) |
| Emergency | Text Eddy: [phone] |
| How-to question | File a GitHub issue with "question" label |
| Feature request | File a GitHub issue with "enhancement" label |

**Response times:** Issues are monitored every 30 minutes during business hours (9 AM - 6 PM Pacific).
