# MKThink Comment Contract and Recovery Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real agents persist run-attributed issue comments through the supported API and prevent separate recovery mechanisms from exceeding one per-task aggregate provider budget.

**Architecture:** Add one adapter-neutral output contract to the shared runtime prompt and both live instruction-bundle sources. Add a universal claim-time gate for automatic retry chains; it walks retry ancestry, aggregates prior turns/tokens/provider estimate/runtime, and cancels before adapter invocation when any limit is exhausted. Exhaustion blocks the issue, records an idempotent visible comment and structured execution-state reason, cancels sibling automatic wakes, and excludes the issue from timer work discovery until a human intervenes.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL, Vitest, existing heartbeat and issue services.

---

### Task 1: Explicit run-attributed comment contract

**Files:**
- Modify: `packages/adapter-utils/src/server-utils.test.ts`
- Modify: `server/src/__tests__/agent-instruction-bundles.test.ts`
- Modify: `packages/adapter-utils/src/server-utils.ts`
- Modify: `server/src/onboarding-assets/default/AGENTS.md`
- Modify: `server/src/services/agent-creator-from-proposal.ts`

- [ ] Add assertions that every runtime guidance surface names `POST $PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments`, bearer agent authentication, `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`, and the injected task/agent/run variables; reject the observed company-scoped comment route.
- [ ] Run the two focused test files and capture assertion failures caused by the missing explicit contract.
- [ ] Add the smallest shared prompt lines and a named `agent-output-contract` block to the two current instruction-bundle sources.
- [ ] Rerun the focused tests and record the passing counts.

### Task 2: Aggregate automatic-recovery budget

**Files:**
- Modify: `server/src/__tests__/heartbeat-process-recovery.test.ts`
- Create: `server/src/services/task-recovery-budget.ts`
- Modify: `server/src/services/heartbeat.ts`

- [ ] Add integration regressions that seed retry ancestry and prove the next automatic run currently reaches `running` when each independent limit is exhausted: one automatic retry, 12 provider turns, 500,000 total provider tokens, `$0.25` list-estimated cost, or five minutes aggregate runtime.
- [ ] Assert the desired fail-closed result: adapter execution is never called, queued/sibling automatic wakes are cancelled, the issue is blocked with `executionState.recoveryBudget.status=exhausted`, and one visible comment/run event exposes consumed values and limits.
- [ ] Run the focused recovery tests and capture the expected failures against current behavior.
- [ ] Implement pure aggregation/decision/format helpers and call the decision once from `claimQueuedRun` before quota, workspace, or adapter work.
- [ ] Persist the exhausted marker before cancelling the refused run, cancel other live automatic retry runs/wakes for the same issue, and make timer work discovery ignore exhausted issues.
- [ ] Rerun the focused recovery tests and the existing heartbeat recovery suite.

### Task 3: Verification, review, and isolated acceptance

**Files:**
- Modify only if verified review findings require a focused remediation.
- Add immutable evidence outside git under the isolated staging instance data directory.

- [ ] Run targeted prompt/recovery tests, `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.
- [ ] Run security/privacy checks for authorization headers, run attribution, company scoping, secret redaction, and absence of production/client paths or credentials.
- [ ] Commit with the Lore protocol and request an independent code review against `origin/main`; fix all verified Critical/Important findings and rerun affected gates.
- [ ] Only after source gates and review pass, back up the isolated loopback staging DB, deploy the branch to its existing worktree instance, and drive the synthetic Titus RFP through browser/API operator surfaces with Claude Max.
- [ ] Require one run-attributed comment, completed task, truthful dashboard/setup status, reconciled subscription-included usage, persistence across restart, zero new usage for one full 300-second idle interval, pause/resume without replay, and rollback proof.
- [ ] Push the branch and open a small PR using every section of `.github/PULL_REQUEST_TEMPLATE.md`; do not merge it.
