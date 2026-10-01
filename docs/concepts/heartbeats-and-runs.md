---
title: Heartbeats and runs
summary: How AgentDash wakes an agent, what a run records, and every wakeup, run and liveness value from code.
---

A **heartbeat** is one wake of an agent. AgentDash queues a wakeup request, starts the agent through its adapter, and records the attempt as a **run** in `heartbeat_runs`. What the agent does during the run is up to the agent; AgentDash decides when to wake it and what context to send.

Source: `packages/db/src/schema/heartbeat_runs.ts`, `packages/db/src/schema/agent_wakeup_requests.ts`, `packages/shared/src/constants.ts`, `doc/execution-semantics.md`

## Why an agent wakes

Each run records an `invocationSource` from `HEARTBEAT_INVOCATION_SOURCES` (default `on_demand`):

| Value | Meaning |
| --- | --- |
| `timer` | A scheduled heartbeat. |
| `assignment` | Work was assigned to the agent. |
| `on_demand` | Someone asked for a run now. |
| `automation` | The server woke it, for example to continue or recover work. |

`triggerDetail` narrows it, from `WAKEUP_TRIGGER_DETAILS`: `manual` · `ping` · `callback` · `system`.

## Wakeup requests

A wakeup lands in `agent_wakeup_requests` first. Several wakeups for the same agent can merge into one run (`coalescedCount`). Status, from `WAKEUP_REQUEST_STATUSES` (default `queued`):

`queued` · `deferred_issue_execution` · `claimed` · `coalesced` · `skipped` · `completed` · `failed` · `cancelled`

## Run status

From `HEARTBEAT_RUN_STATUSES` (default `queued`):

`queued` · `scheduled_retry` · `running` · `succeeded` · `failed` · `cancelled` · `timed_out`

A run records its exit code, usage, a log reference and excerpts, and the session id before and after. A retry points back at the run it retries (`retryOfRunId`).

## Liveness

After a run ends, the server classifies what it achieved (`server/src/services/run-liveness.ts`). `livenessState` comes from `RUN_LIVENESS_STATES`:

`completed` · `advanced` · `plan_only` · `empty_response` · `blocked` · `failed` · `needs_followup`

`completed` means the run's issue is in a terminal status; it is not proof of what the run itself did. `advanced` means the run produced concrete action evidence.

## Runs and issues

To move an agent-owned issue to `in_progress`, a run checks the issue out. `issues.checkoutRunId` names the run holding execution rights; `issues.executionRunId` names the run that is live now. On startup and on a periodic loop the server reaps orphaned `running` runs, resumes `queued` ones, and reconciles assigned work that lost its run.

Each agent may run up to `AGENT_DEFAULT_MAX_CONCURRENT_RUNS` (20) runs at once unless configured otherwise, with a default daily token ceiling of `AGENT_DEFAULT_MAX_DAILY_TOKENS` (5,000,000).

See also: [Heartbeat protocol](/guides/agent-developer/heartbeat-protocol) · [How agents work](/guides/agent-developer/how-agents-work) · [Route index](/api/route-index) · [Issues, projects and goals](/concepts/issues-projects-and-goals)
