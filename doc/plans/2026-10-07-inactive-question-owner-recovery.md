# Inactive question owner recovery implementation plan

**Goal:** Let the exact active current accountable human recover a held question after its pinned owner becomes inactive, without reading the old private prompt or answering implicitly.

**Architecture:** Add issue-scoped safe recovery discovery and a prepare/confirm cancellation operation to the canonical human registry. Witness current identity, membership, issue/project, assignee/accountability and old-owner membership under existing company-first acceptance locks. Reuse cancelled-question replacement and genuine answer continuation. Browser session preview/apply and named-human MCP/bridge call the same operations.

**Spec:** `doc/plans/2026-09-29-workforce-onboarding-implementation.md`, Task 5b1a and composed proof at line 177; launch plan Task 7.

**Constraints:** Isolated branch `codex/backlog-question-recovery-20261007`; no schemas, dependencies, live resources, providers, secrets, service restarts, push or merge. Synthetic isolated environment and disposable PostgreSQL only. Existing private owner visibility and required-input holds remain enforced.

- [x] Red: extend real PostgreSQL/HTTP source-authority tests with member-level replacement owner, readiness 404, safe metadata, confirmed cancellation, canonical replacement, genuine answer, and one same-task continuation.
- [x] Implement `human_questions.recovery.list` and `.cancel` in `services/human-control/questions.ts`; add authority witnesses in `authority.ts` and finite descriptors in shared contracts. Safe metadata contains IDs, state and receipt only.
- [x] Add session read/preview/confirm route adapters and UI recovery controls independent of readiness. Never repeat an uncertain mutation; refresh canonical metadata.
- [x] Verify refusal after owner reactivation, accountability change, membership/key/project access revocation, wrong administrator, cross-company IDs and replay; prove old question remains private.
- [x] Sync native MCP playbook/generated reference and the current canonical agent prompt bundle and proposal inheritance surface; document cancellation/hold/replacement semantics and evidence limits.
- [x] Run focused real-PG, human-control, MCP and UI regressions plus scoped type checks. Record red/green evidence and freeze a Lore commit for independent review.

Verification: `doc/qa/2026-10-07-inactive-question-owner-recovery.md`. Full monorepo and hosted checks remain outside this bounded handoff.
