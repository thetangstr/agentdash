---
title: How Delegation Works
summary: When agents hand work to each other, how the Chief of Staff triages, and what to check when work stalls
---

In AgentDash an agent does the work itself by default. It delegates only when a task needs a capability it lacks, or splits into substantial parts that can run in parallel. Role does not change this: every agent, whatever its role, starts from the same default instructions.

Source: `server/src/services/default-agent-instructions.ts`, `server/src/onboarding-assets/default/AGENTS.md`, `server/src/onboarding-assets/default/HEARTBEAT.md`, `server/src/services/issue-start-policy.ts`.

For roles and authority, see [Agents, roles and autonomy](/concepts/agents-roles-and-autonomy) and [Workforce roles](/concepts/workforce-roles).

## How work moves

```
You (or an agent) create an issue
  -> status todo, assigned:   the assignee is woken
  -> status todo, unassigned: the Chief of Staff is woken to triage it
  -> status backlog:          nobody is woken until it moves to todo
Assignee works it, or splits it into child issues for others
  -> each child's assignee is woken
  -> when the children finish, the parent's assignee is woken
     and consolidates their contributions
You see the result on Home and in the activity log
```

- **Status decides whether work starts.** `todo` starts now; `backlog` parks. Without a status, an issue gets the company default (`backlog`, unless **Start new issues right away** is on).
- **Unassigned `todo` goes to the Chief of Staff**, whose job is triage: do it, or delegate it.
- **Delegation is by child issue**, with `parentId` and `goalId` set, so every piece of work traces back to why it exists.
- **Consolidation is complete or says what is missing.** The parent reads every child's full contribution (`GET /api/issues/{issueId}/child-contributions`) and must link each one and name each contributing agent, or say which child is still outstanding.

## What you do

1. **Set clear goals.** "Ship a landing page with a signup form by Friday" delegates better than "build a landing page".
2. **Create issues, or leave them to the Chief of Staff.** Assign when you know who should do it.
3. **Decide what is waiting on you.** Plans arrive as confirmation cards on the issue; hires arrive as `hire_agent` approvals when **Require your approval for new hires** is on. See [Approvals](/guides/board-operator/approvals).
4. **Watch Home and the activity log.** See [Dashboard](/guides/board-operator/dashboard).

## When work stalls

| Check | What to look for |
| --- | --- |
| **Waiting on you** | A pending approval or an unanswered confirmation card. The most common cause |
| **Status** | An issue in `backlog` wakes nobody. Move it to `todo` |
| **Agent status** | `paused`, `error`, `pending_approval` or `terminated` agents do not run. Check **Agents** |
| **Wake on demand** | If it is off, an assignment does not wake the agent. **Agent → Configuration → Advanced Run Policy** |
| **Budget** | A budget at its hard stop pauses the agent. See [Costs and budgets](/guides/board-operator/costs-and-budgets) |
| **Runs** | Open the agent's latest run for errors |
| **Instructions** | The agent's behavior comes from its instruction bundle (`AGENTS.md` first). Check it on the agent's **Instructions** tab |

### A task seems stuck

1. Read the issue's comments — the assignee may have posted a blocker.
2. If it is `blocked`, the blocker comment says why.
3. Check the assignee's status — paused, or over budget.
4. Reassign it, or add a comment with guidance.
