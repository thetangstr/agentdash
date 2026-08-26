# MKThink Staging MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before each commit or hand-off.

**Goal:** Prove an isolated MKThink staging loop in which invited humans resume and complete their own onboarding, task counts and costs are truthful, and timer heartbeats never invoke a model while idle.

**Architecture:** Reuse `onboarding_sessions` as a permission-neutral `(company,user)` lifecycle; do not call workspace bootstrap or the legacy agent-creation wizard for invitees. Treat `DashboardSummary.tasks.open` as the sole open-task definition. Apply configured token pricing at run-ledger ingestion only when adapter cost is absent, and gate timer wakes on assigned actionable work before enqueue.

**Tech Stack:** TypeScript, Express, Drizzle/PostgreSQL, React 19, TanStack Query, Vitest, Playwright, embedded PostgreSQL.

---

## Timebox and decisions

- 0–20 min: isolation receipt, clean baseline, plan.
- 20–55 min: invited-member onboarding and dashboard/setup-status regressions.
- 55–80 min: usage-cost visibility and timer idle gate regressions.
- 80–105 min: isolated authenticated fixtures, browser/API acceptance, pause/resume and rollback proof.
- 105–120 min: full gates, independent review, remediation, Lore commits, push/PR.
- Use the exact local base `b19bf176`; do not rebase onto stale `origin/main` during this slice.
- Rejected: `/api/onboarding/bootstrap` for invitees, because it grants owner and `agents:create`.
- Rejected: the legacy onboarding wizard, because it creates agents/tasks and violates MKThink stewardship rules.
- Rejected: client-only progress, because close/reopen must resume from server state.
- Minimal invitee content: persisted `welcome` then `workspace` steps describing the company, membership role, work/inbox surfaces, and safe agent stewardship; completion only records the user lifecycle.

## Execution record

- Implemented on isolated branch `codex/mkthink-staging-mvp` from local base `b19bf176`; no production connection or client data was used.
- Isolated runtime: authenticated/private `http://127.0.0.1:3221`, embedded PostgreSQL in the worktree-specific `mkthink-staging-mvp` instance on port `54421`.
- Staging token prices were passed explicitly at process launch (15 cents/M input, 60 cents/M output, markup 1). An ambient worktree `.env` was rejected after it polluted test configuration.
- Synthetic browser/API acceptance proved invite start, persisted resume, completion without re-onboarding, one task pickup plus run-attributed comment, two stable run records after idle polling, pause/resume without replay, four matching open tasks, and a 14-cent visible cost for 908k input tokens.
- Rollback checkpoint: `mkthink-staging-checkpoint-20260826-103008.sql.gz`; gzip integrity and stop/restart continuity passed.
- Full `pnpm test:run`, `pnpm -r typecheck`, `pnpm build`, architecture, migration, diff, and targeted security-pattern gates passed. Repository-wide forbidden-token and dependency-audit gates remain red from unchanged baseline findings and are promotion blockers, not waived by this slice.
- Independent review found one bounded-polling defect; a red/green regression and per-agent timer-check baseline resolved it, and re-review reported no remaining source findings.
- Promotion branch `codex/mkthink-staging-mvp-pr` was subsequently rebased onto the now-current `origin/main` at `a02aaaa4`; the uniqueness migration was regenerated as `0122_funny_valkyrie.sql`. Current main has removed the dedicated CEO and Chief-of-Staff onboarding asset files, so the rebase preserved those deletions and retained the explicit board-only note in the two surviving prompt-generation surfaces instead of resurrecting stale prompts.

### Task 1: Per-user invited-member onboarding

**Files:**
- Modify: `packages/db/src/schema/onboarding_sessions.ts`
- Create: generated migration and snapshot under `packages/db/src/migrations/`
- Create: `server/src/services/member-onboarding.ts`
- Modify: `server/src/services/index.ts`
- Modify: `server/src/routes/access.ts`
- Modify: `server/src/routes/onboarding-v2.ts`
- Modify: `packages/shared/src/types/` onboarding exports
- Create/modify tests: `server/src/__tests__/invite-accept-auto-approve.test.ts`, access manual-approval coverage, and `server/src/__tests__/member-onboarding.test.ts`
- Create: `ui/src/pages/MemberOnboarding.tsx` and test
- Modify: `ui/src/api/onboarding.ts`, `ui/src/components/CloudAccessGate.tsx`, `ui/src/App.tsx`, `ui/src/pages/InviteLanding.tsx` and their tests
- Modify every prompt-generation surface present on the promotion base with an explicit non-applicability note because this is board-session-only behavior; do not resurrect prompt files deleted by current `main`.

- [ ] Add failing DB/service tests proving one in-progress session per `(companyId, createdByUserId)`, resume without duplication, cross-user/company isolation, completion, and completed-row non-reopening.
- [ ] Run `pnpm exec vitest run server/src/__tests__/member-onboarding.test.ts server/src/__tests__/invite-accept-auto-approve.test.ts` and confirm failures are caused by missing lifecycle behavior.
- [ ] Add the unique index and service methods `startOrResume`, `getCurrent`, `advance`, and `complete`; generate the migration with `pnpm db:generate`.
- [ ] Start/resume the lifecycle in the same transaction that activates a human membership in both auto-approve and manual-approval paths; exclude bootstrap and agent joins.
- [ ] Add authenticated company-scoped status/advance/complete endpoints that bind the user ID exclusively from `req.actor.userId`.
- [ ] Add failing UI tests proving invite success routes to member onboarding, close/reopen redirects back to the saved step, completion reaches the board, completed users stay on the board, and first-company bootstrap behavior is unchanged.
- [ ] Implement the dedicated permission-neutral onboarding page and guard; store no secrets or authority-bearing data in session context.
- [ ] Rerun the focused server/UI tests to green.
- [ ] Commit using Lore trailers.

### Task 2: One truthful open-task definition

**Files:**
- Modify: `packages/mcp-server/src/journey.ts`
- Modify: `packages/mcp-server/src/journey.test.ts`
- Modify: `server/src/__tests__/dashboard-service.test.ts`
- Modify: `ui/src/pages/Overview.tsx`
- Modify: `ui/src/pages/Overview.test.tsx`

- [ ] Replace the stale MCP fixture with `{ tasks: { open: 4, inProgress: 1, blocked: 0, done: 2 } }`; verify the existing implementation fails with `openTasks === 0`.
- [ ] Add dashboard-service coverage for all seven issue statuses and cross-company exclusion: open must equal `backlog + todo + in_progress + in_review + blocked`.
- [ ] Add a UI assertion that the large “open tasks” value is `tasks.open`, not overlapping buckets added together; verify it fails.
- [ ] Type the MCP dashboard payload as `DashboardSummary`, read `dashboard.tasks.open`, and render `tasksOpen` directly in Overview.
- [ ] Run focused MCP/server/UI tests to green and commit with Lore trailers.

### Task 3: Staging-visible configured token cost

**Files:**
- Modify: `server/src/services/usage-billing.ts`
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/__tests__/usage-billing.test.ts`
- Create/modify heartbeat ledger test for effective cost and `usageJson.costUsd`
- Modify ignored worktree `.paperclip/.env` with explicit synthetic pricing only.

- [ ] Add failing tests for finite non-negative env parsing and effective per-run cost: adapter cost wins when larger; configured token cost fills a missing/zero adapter cost; subscription-included stays zero.
- [ ] Implement one shared token-cost function used by billing and heartbeat ledger ingestion; persist the effective `costUsd` plus an explicit cost source in `usageJson`.
- [ ] Set staging-only test prices to 15 cents/M input and 60 cents/M output with markup 1; do not add them to tracked environment files or production config.
- [ ] Run focused tests to green and commit with Lore trailers.

### Task 4: Idle timer wake and logging invariant

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Create: `server/src/__tests__/heartbeat-timer-gate.test.ts`
- Modify schema/migration only if a measured query lacks an existing suitable index.

- [ ] Add a failing embedded-Postgres test with a due enabled agent, mocked adapter, and no assigned actionable issue; assert zero wake requests, zero runs, zero adapter calls, and an idle-skip counter.
- [ ] Add failing cases for assigned `todo`/`in_progress` work enqueuing once, `blocked`/`in_review` not enqueuing, a second poll before 300 seconds not enqueuing, and an active run not being misreported as newly enqueued.
- [ ] Gate timer enqueue on a company-scoped indexed existence query for visible assigned `todo`/`in_progress` issues; skip active runs before enqueue and never INFO-log no-work polls.
- [ ] Preserve manual, assignment, approval, automation, and callback wake paths unchanged.
- [ ] Run focused heartbeat and mandate pause/resume/idempotency tests to green; commit with Lore trailers.

### Task 5: Isolated staging acceptance and rollback

**Files/artifacts:**
- Isolated worktree config: `.paperclip/config.json` and `.paperclip/.env` (ignored)
- Synthetic fixtures only under instance `mkthink-staging-mvp`
- Evidence receipts under `/tmp/mkthink-staging-*`

- [ ] Change only the isolated config to `authenticated/private` on `127.0.0.1:3221`; retain generated worktree credentials.
- [ ] Start the worktree service and prove `/api/health` reports the isolated instance/runtime identity.
- [ ] Create synthetic founder/invitee accounts, an `agentdash_mk` company, stewardship/agent, and one genuine synthetic task without external client data or provider secrets.
- [ ] Browser/API prove login; invite acceptance starts onboarding; advancing then close/reopen resumes; completion does not re-onboard; dashboard and setup status agree.
- [ ] Use a deterministic local test adapter to pick up the synthetic task and add a real issue comment; verify no timer run/model call/token increase after completion.
- [ ] Prove manual pause/resume does not replay a mandate; prove token-bearing usage creates non-zero visible cost from staging prices.
- [ ] Back up the isolated instance, stop the service, verify ports close, restart the accepted commit, and verify health/data continuity; record the receipt.

### Task 6: Verification, review, and GitHub hand-off

- [ ] Run targeted changed-area tests, then `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.
- [ ] Run dependency audit, security/privacy/static gates defined by `package.json` and `.github/workflows/pr.yml`; run relevant authenticated Playwright specs.
- [ ] Dispatch an independent code reviewer against the base/head SHAs; fix every verified Critical/Important issue and rerun affected/full gates.
- [ ] Review the final diff for unrelated changes, secrets, client identifiers/data, and prompt-surface compliance.
- [ ] Push the clean `codex/mkthink-staging-mvp-pr` promotion branch and create a PR to `main` using every section of `.github/PULL_REQUEST_TEMPLATE.md`; do not merge.
- [ ] Capture CI status, exact commits/test counts/runtime receipt/resource impact/rollback proof, and a separated production-promotion checklist.
