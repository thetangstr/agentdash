# Company Evaluator — data-surface map (Milestone 0, step 1)

**Written:** 2026-09-05 against `main` `daa2d6c9` (migration journal head
`0126_inbox_connect_actions`). Companion to
`2026-09-05-company-evaluator-design.md`. Paths are repo-relative; a line number
is given where the fact is anchored to one. Anything not found is said to be not
found rather than assumed.

## How records are scoped and written

- Every table carries `companyId`; routes assert access with
  `assertCompanyAccess` (`server/src/routes/authz.ts:91`) and direction-setting
  routes with `assertCanSetCompanyDirection` (`authz.ts:143`, agents always
  refused). Services are plain factories over `db` (`server/src/services/goals.ts:44`).
- Every domain write calls `logActivity` (`server/src/services/activity-log.ts:65`),
  which inserts into `activity_log`, republishes an in-memory `activity.logged`
  live event, and forwards a mapped subset to the plugin event bus. The live bus
  (`server/src/services/live-events.ts`) is an in-process emitter with no
  persistence; there is no outbox table.
- Tests: `server/src/__tests__/*.test.ts`, serial single-fork vitest
  (`server/vitest.config.ts`), DB-backed tests via
  `server/src/__tests__/helpers/embedded-postgres.ts`.

## 1. Goals, projects, milestones

- `goals` (`packages/db/src/schema/goals.ts:23-42`): level `company|team|agent|task`,
  status `planned|active|achieved|cancelled`, `parentId`, `ownerAgentId`,
  `metricDefinition` jsonb `{target, unit, source, baseline, currentValue,
  lastUpdatedAt}`. Routes `server/src/routes/goals.ts` (list/get/create/update/
  delete; `PUT …/goals/:goalId/metric-definition`).
- `projects` (`packages/db/src/schema/projects.ts:21-60`): status
  `backlog|planned|in_progress|completed|cancelled`, `leadAgentId`, `goalId`,
  **`targetDate`**, **`definitionOfDone` jsonb** `{summary, criteria[{id,text,done}],
  goalMetricLink}`, `createdByUserId`, `visibility`. `project_goals` links
  many-to-many.
- **No milestones table.** Milestone = project (decision D3).

## 2. Issues and their trail

- `issues` (`packages/db/src/schema/issues.ts:21-137`): status
  `backlog|todo|in_progress|in_review|done|blocked|cancelled`, priority,
  `assigneeAgentId`/`assigneeUserId`, `checkoutRunId`/`executionRunId`,
  `createdByAgentId`/`createdByUserId`, `parentId`, `goalId`, `projectId`,
  **`definitionOfDone` jsonb** (`issues.ts:51`), `originKind/originId/originFingerprint`
  (dedupe for auto-created issues; partial unique indexes `issues.ts:87-135`),
  `startedAt`/`completedAt`/`cancelledAt`, `executionPolicy`/`executionState`.
  DoD write: `PUT /companies/:companyId/issues/:issueId/dod`
  (`server/src/routes/issues.ts:4062-4090`, direction-setters only). DoD guard on
  leaving backlog: `server/src/services/dod-guard.ts:35`, gated by
  `feature_flags` key `dod_guard_enabled` (never enabled on the live company).
- `issue_comments` (`issue_comments.ts:7-35`): `authorAgentId`/`authorUserId`,
  `createdByRunId`, `body` (GIN full-text). MAW handoff payloads live here as
  text; PR URLs appear here as free text.
- `issue_relations` (`issue_relations.ts:6-30`): type `blocks` only; unique edge.
- `issue_reference_mentions`: cross-references from title/description/comment/
  document with `matchedText`.
- `issue_thread_interactions` (`issue_thread_interactions.ts:13-54`): kind
  `ask_user_questions`, status `pending|answered|cancelled|expired`,
  `sourceRunId`, `resolvedBy*`, `payload`/`result`.
- `issue_execution_decisions`, `issue_approvals`, `issue_labels`/`labels`,
  `issue_documents`/`documents`/`document_revisions`, `issue_read_states`.
- `activity_log` (`activity_log.ts:6-26`): `actorType agent|user|system|plugin`,
  `actorId`, `action` (dotted catalogue: `issue.*`, `agent.*`, `approval.*`,
  `heartbeat.*`, `budget.*`, `goal.*`, `project.*`, `verdict_recorded`, …),
  `entityType`/`entityId`, `agentId`, `runId`, `details` jsonb, `createdAt`.
  Indexes on `(companyId, createdAt)`, `runId`, `(entityType, entityId)`.

## 3. Agents, authority, stewardship

- `agents` (`agents.ts:16-104`): role, status, `reportsTo`, adapter, budgets,
  `permissions` jsonb, `autonomy stewarded|autonomous` (check), **`accountableUserId`**
  (required when autonomous), `createdByUserId`.
- `agent_stewardships` (active 1:1 user↔agent, transfer trail),
  `agent_governance_policies` (owner ceiling, steward request, effective policy,
  revision), `agent_directives` (append-only versions; never gate authority),
  `principal_permission_grants` (principal type/id, permission key, scope),
  `agent_api_keys` (hash only; **provenance columns `source`, `createdByUserId`,
  `createdByAgentId` since 0123**), `agent_runtime_state` (running token/cost
  totals, last run/status/error), `agent_task_sessions`, `agent_wakeup_requests`
  (source, triggerDetail, reason, status, coalescedCount, idempotencyKey,
  requestedBy actor).

## 4. Runs and recovery

- `heartbeat_runs` (`heartbeat_runs.ts:6-82`): status
  `queued|scheduled_retry|running|succeeded|failed|cancelled|timed_out`,
  `invocationSource`, `triggerDetail`, `exitCode`, `error`, `errorCode`,
  `usageJson`/`resultJson`, log pointers, `retryOfRunId`, retry counters,
  `livenessState completed|advanced|plan_only|empty_response|blocked|failed|needs_followup`,
  `livenessReason`, `contextSnapshot`. `heartbeat_run_events`: ordered per-run
  stream (`seq`, `eventType`, `stream`, `level`, `message`, `payload`).
- Error codes in use include `timeout`, `budget_hard_stop`, `daily_run_cap`,
  `adapter_failed`, `cancelled`, `process_lost`, `issue_*`, and
  `human_question_unanswered` (`server/src/adapters/hermes-human-question.ts:27`).
- Budgets and limits: `server/src/observability/pre-run-checks.ts` (daily run
  cap, monthly hard stop), `server/src/services/task-recovery-budget.ts`
  (per-task retry/turn/token/dollar/time ceilings; emits
  `issue.recovery_budget_exhausted`), `run-continuations.ts`.
- Self-healing: `server/src/services/run-healer/*` writing `heal_attempts`
  (diagnosis, fixType, succeeded, costUsd) and `heal_events`.
- Watchdog: `heartbeat_run_watchdog_decisions` (snooze/continue/dismiss with
  actor and reason); semantics in `doc/execution-semantics.md` §7–§11.
- `agent_runs`: per heartbeat run `complexity_tier`, `duration_ms`,
  `token_count`, `cost_cents`, `is_overage` — a second metering surface.

## 5. Evidence: verdicts, approvals, review queue

- `verdicts` (`verdicts.ts:28-75`): `entityType goal|project|issue` with exactly
  one target id, exactly one of `reviewerAgentId`/`reviewerUserId`, `outcome
  passed|failed|revision_requested|escalated_to_human|pending`, `rubricScores`
  jsonb, `justification`. Service `server/src/services/verdicts.ts:98`; neutrality
  guard `assertNeutralValidator` (`verdicts.ts:151-192`) refuses reviewer =
  assignee, project lead or goal owner with `NEUTRAL_VALIDATOR_VIOLATION`;
  `escalated_to_human` auto-creates a `verdict_escalation` approval. Routes
  `server/src/routes/verdicts.ts`: `POST/GET /companies/:companyId/verdicts`
  (GET requires `entityType` and `entityId`), `GET …/coverage`.
- `verdict-approval-bridge.ts`: turns a decided escalation approval into a closing
  verdict and logs it.
- `approvals` (`approvals.ts:6-44`): type (`hire_agent`, `approve_ceo_strategy`,
  `budget_override_required`, `request_board_approval`, `mandate_violation`,
  `connector_send`, `inbound_content_review`, `deliverable_review`,
  `workflow_recommendation`), status, `requestedBy*`, `decidedByUserId`,
  `decisionNote`, `revision`, `decisionIdempotencyKey`, `decisionActorRole`,
  `overrideReason`. `approval_comments`, `issue_approvals`.
- `cos_reviewer_assignments` (reviewer hire/retire), `issue_review_queue_state`
  (enqueuedAt, escalateAfter, assignedReviewerAgentId), view
  `issue_review_timeline_v`.

## 6. Cost, tokens, budget

- `cost_events` (`cost_events.ts:9-53`): agent/issue/project/goal attribution,
  `heartbeatRunId`, provider/biller/billingType/model, input/cached/output
  tokens, `costCents`, `occurredAt`. `finance_events`: superset ledger with
  `costEventId`, kind/direction/amount/currency/estimated.
- `budget_policies` (scope, metric, window, amount, warn %, hardStopEnabled),
  `budget_incidents` (threshold crossings, status, approvalId).
- Routes `server/src/routes/costs.ts`: cost/finance event POSTs, `costs/summary`,
  by-agent/model/provider/biller/project, window-spend, quota-windows,
  budgets/overview, agent-runs monthly.

## 7. Incidents and health

- `server_errors` (`server_errors.ts:13-31`): one row per fingerprint with
  `count`, `firstSeen`, `lastSeen`, `lastContext` (method/url/status only).
  Writer `server/src/observability/error-sink.ts:65`. Routes `GET/DELETE /instance/errors`.
- Health: `server/src/routes/health.ts` and `observability/health-checks.ts`
  (db, disk, backup age, stuck runs), `alerter.ts`.

## 8. Releases and deployment

- No release, OTA or deployment table exists in this repository. Release
  identity lives in GitHub: tag `vYYYY.MDD.P`, the GitHub Release body (the notes
  file), and the attached `agentdash-release-control-v<version>.json` manifest
  (`releaseVersion`, `sourceSha`, `releaseControlSha`, updater asset and sha256).
  Ingest of releases is therefore a T1 GitHub adapter (decision D4) or a manual
  ledger event citing the manifest.

## 9. Steward inbox and bridge (main)

- `steward_inbox_events` / `steward_inbox_sequences` / `steward_inbox_cursors`
  (`packages/db/src/schema/steward_inbox.ts`, migration 0124), `channel_callback_tokens.bridgeEndpointId`
  (0125), `steward_inbox_action_handles` + `bridge_endpoints.checkIntervalMinutes`
  (0126, `steward_inbox_actions.ts`). Bridge allowlist of nine routes in
  `server/src/middleware/auth.ts`. `bridge_tasks` has claim/lease semantics.
- The older derived inbox over `approvals` is `server/src/routes/agentdash-mk-inbox.ts`.

## 10. CI and GitHub

- Not stored. PR/CI evidence exists only as free text in comments (MAW payloads
  `builder_to_ci`, `tester_to_reviewer`, `reviewer_to_tpm`, `tpm_merge_report`
  per `doc/maw/handoff-schemas.json`) and in GitHub itself. `github-issues.ts`
  files outbound bug reports only.

## 11. Existing reporting to reuse

- `server/src/services/dashboard.ts`: harness health per adapter over 24 h;
  task quality over 30 days — `issuesWithDefinitionOfDone`,
  `unreviewedDoneIssues`, `issueLinkedSpendCents`, `issueLinkedTokens`,
  `greenRunsPendingReview`, `greenRunsWithOpenTasks`. Route `GET /companies/:companyId/dashboard`.
- `workflow_events` / `workflow_recommendations`: **person-free by database
  check** (no actor identity may be stored); pipeline timings and org-level
  recommendations only; route gated to the `agentdash_mk` product profile.

## 12. Live baseline (Agent Runner company, 2026-09-05, read-only)

80 issues; DoD on 0; verdicts 0; approvals 0; 142 runs with usage on 13;
2 cost events; 2 goals without metric definitions; 2 projects without target
dates or DoD; 5 pending unanswered `ask_user_questions`; CoS Reviewer assigned,
never run; `dod_guard_enabled` never set. Instance-wide: `activity_log` 1,324
rows, `heartbeat_run_events` 390, `heal_events` 5,933, `issue_comments` 389.
