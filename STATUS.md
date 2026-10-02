# STATUS — devin/leaks-20261002 (#933 + #946)

Phase: PR_OPEN
PR: https://github.com/thetangstr/agentdash/pull/970 (not merged)
Blockers: none
Last verification: all green —
  `pnpm -r typecheck` (workspace), `pnpm build` (workspace),
  vitest touched files + adjacent suites (see below)

## Scope

- #933: project-scoped visibility for `budget_policy`/`budget_incident`
  activity rows (REST feed + `activity.logged` live events), the assistant
  digest's decision list, and the sidebar badge / pending-decisions count —
  mirror the #930 pattern (`approvalVisibilityCondition`).
- #946: agents holding `users:manage_permissions` / `users:invite` /
  `joins:approve` must never receive member emails on `/members`,
  `/invites`, `/join-requests` (or the mutation responses that echo the same
  member records / join-request rows). Reuse `member-email-visibility.ts`
  from PR #945.

## Plan

1. `routes/visibility.ts`: extend `activityVisibilityCondition` with a
   `details.scopeType/scopeId` project conjunct for budget entities.
2. `realtime/live-event-visibility.ts`: `liveEventRefs` extracts the budget
   row's project scope; missing scope id fails closed.
3. `services/assistant-digest.ts`: filter ranked approvals through
   `approvalBudgetProjectId` vs `input.visibleProjectIds`; classify a
   project-scoped digest's budget override as linked to that project.
4. `services/sidebar-badges.ts` + `routes/sidebar-badges.ts`: compose
   `approvalVisibilityCondition` into the actionable-approvals query.
5. `services/waiting-on-you.ts`: pass `approvalVisibilityCondition` to
   `approvals.list` (same leak class; feeds Home/Decisions badge).
6. `routes/access.ts`: map all nested user profiles and
   `requestEmailSnapshot` through `visibleMemberEmail` on the three GETs
   and the mutation responses that echo member/join-request records.
7. Tests: embedded-PG real-route coverage — off-list viewer, listed viewer,
   admin, agent with grants — plus `liveEventRefs` unit coverage and a
   websocket delivery assertion.
8. Verify: focused vitest, `pnpm typecheck`, `pnpm build`; OpenAPI drift
   check since response shapes gain `email: null` semantics (no shape
   change expected — keys already exist).

## Log

- Read COMMON.md, issue-933.md, issue-946.md, AGENTS.md, doc/GOAL.md,
  doc/PRODUCT.md, doc/SPEC-implementation.md, doc/DEVELOPING.md,
  doc/DATABASE.md. Explored visibility.ts, live-event-visibility.ts,
  activity.ts/service, budgets.ts writers, assistant-digest.ts,
  sidebar-badges route+service, waiting-on-you.ts, access.ts loaders and
  routes, member-email-visibility.ts, reference tests.
- Implemented plan items 1–6. All four budget `logActivity` writers carry
  `details.scopeType`/`scopeId`, so both the SQL conjunct and the live-event
  ref extraction key off the same pair. Join-request create/auto-approve
  echoes left untouched — they return the submitter's own snapshot.
- Tests written: new `budget-activity-visibility.test.ts` (feed, badges,
  digest, pending-decisions; off-list / listed / creator / admin / on- and
  off-list agents), `liveEventRefs` budget cases + a real-websocket delivery
  test in `live-events-project-visibility.test.ts`, and a granted-agent
  describe block in `member-email-visibility-routes.test.ts` (granted agent,
  member manager, granted-but-not-manager human, ungranted agent 403s).
- Verification: `pnpm -r typecheck` clean; `pnpm build` clean. Vitest:
  budget-activity-visibility 13/13, live-events-project-visibility 11/11,
  member-email-visibility-routes 12/12, plus activity-routes 18,
  activity-service 7, assistant-digest 11, waiting-on-you 6,
  waiting-on-you-reviews 6, budget-project-visibility 9, activity-router 5,
  live-event-visibility-epoch 2, agent-visibility-routes 12,
  join-approval-tier-route 6, invite-summary-route 6,
  invite-accept-auto-approve 5, invite-list-route 1,
  invite-accept-existing-member 1 — all pass.
  (`waiting-on-you.test.ts` initially failed resolving the unbuilt
  `@agentdash/mcp-server` workspace dist; `pnpm --filter
  @agentdash/mcp-server build` fixed the environment, tests pass.)
