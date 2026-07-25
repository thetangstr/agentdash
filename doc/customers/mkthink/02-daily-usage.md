# MKThink AgentDash — Daily Usage Guide

Everything you need to operate AgentDash day-to-day.

---

## Your Daily Routine (15-20 minutes total)

### Morning (5-10 min)

1. **Open the dashboard** → `http://<mac-mini-ip>:3100/dashboard`
2. **Check the agent fleet** — are all agents "idle" (ready) or "running" (working)?
3. **Review overnight results** — go to Issues → filter by "done" → check what completed
4. **Create tasks for today** — what do you want your agents to work on?
5. **Check pending approvals** — anything in the "needs your call" panel?

### Midday (2-3 min, optional)

1. Quick dashboard check
2. Any tasks stuck in "in_progress" for hours? Check the agent — it might be stuck
3. Text your CEO agent if you have a quick request

### Evening (5-10 min)

1. Review completed work
2. Provide feedback on agent output (comment on the task)
3. Check costs (Costs page)
4. Create tasks for tomorrow
5. Pause agents if you don't want them working overnight (optional)

---

## Creating Effective Tasks

**Good task description:**
> "Research our top 5 competitors in the strategy consulting space. For each, identify their key service offerings, notable clients, and pricing model. Create a 2-page summary document with a comparison table."

**Bad task description:**
> "Research competitors"

The more specific you are, the better the agent performs. Include:
- **What** to do (research, write, analyze, summarize)
- **Scope** (how many, how long, what format)
- **Context** (links, references, examples)
- **Output format** (document, table, bullet list, email draft)

---

## Managing Agents

### Check Agent Status
Dashboard → Agents → click any agent

| Status | What it means |
|--------|--------------|
| **idle** | Ready for work, waiting for tasks |
| **running** | Currently working on a task |
| **paused** | Stopped (manually or budget limit) |
| **error** | Something went wrong — check the run transcript |

### Pause/Resume an Agent
Agents page → click agent → "Pause" or "Resume"

Useful for:
- Stopping work overnight or on weekends
- Pausing when you've hit your budget
- Stopping an agent that's doing something wrong

### Test an Agent's Environment
Agents page → click agent → "Test Environment"

Verifies the agent's LLM adapter is working (Claude Code is installed and authenticated, API key is valid, etc.)

---

## Using the CoS Chat (`/cos`)

The Chief of Staff is your AI operations manager. Use it for:
- **Planning:** "I need to prepare for a client pitch. What should our agents work on?"
- **Delegation:** "Have the Research Agent compile a competitive landscape for the healthcare sector."
- **Status:** "What's everyone working on and what's the status?"
- **Strategy:** "We're expanding into education consulting. Propose a plan for how our agents can support this."

The CoS creates tasks, assigns them to agents, and coordinates the team.

---

## Reviewing Agent Output

1. Go to Issues → find the completed task
2. Read the agent's completion comment (summary of what it did)
3. Check any attached documents or work products
4. If the output is wrong or incomplete:
   - Comment on the task: "This is missing the pricing comparison. Please add it."
   - The agent will pick up the comment on its next heartbeat
   - Or create a new task with more specific instructions

---

## Budget and Cost Control

### Check Your Spend
Dashboard → Costs page

Shows:
- Monthly spend to date
- Budget remaining
- Spend by agent
- Spend by model

### Set a Budget
```sh
# Company monthly budget: $100
curl -X PATCH http://127.0.0.1:3100/api/companies/:companyId/budgets \
  -H "Content-Type: application/json" \
  -d '{"budgetMonthlyCents": 10000}'
```

### What Happens When Budget Is Hit
- All agents auto-pause
- Status shows "paused — budget hard-stop"
- You get a notification in the activity log
- To resume: raise the budget or wait for next billing cycle

---

## Tips for Getting the Most Value

1. **Batch your task creation** — create 5-10 tasks in the morning, let agents work all day
2. **Use specific instructions** — vague tasks produce vague results
3. **Review and give feedback** — agents learn from your comments
4. **Use the CoS for delegation** — it knows which agent is best for each task
5. **Start simple** — begin with research and drafting tasks; move to complex analysis as you build trust
6. **Check the activity log** — it shows every action every agent took, full transparency
7. **Set realistic expectations** — agents are capable but not perfect. Review everything before external use
