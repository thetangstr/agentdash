# Inactive pinned question owner recovery — local verification

Date: 2026-10-07. Base: `052acc60edb022d77e874386a593ca51e33dfb9e`. Branch: `codex/backlog-question-recovery-20261007`.

## Approved contract and measurable change

Implements the missing recovery slice in `doc/plans/2026-09-29-workforce-onboarding-implementation.md` Task 5b1a and composed proof 177, within launch Task 7. Historical proof counts and uncompleted broader transport/launch gates remain historical.

Before: a new active accountable member can read the original issue (HTTP 200), but private-source readiness returns 404. The old inactive owner cannot cancel; the new owner cannot read/cancel the pending private question or replace it. Required input remains held. A fresh real PostgreSQL/HTTP regression failed at safe recovery discovery (HTTP 400 instead of 200), because the operation was absent.

After: the same fixture completes safe discovery → explicit prepared cancellation → persisted cancellation/audit receipt → explicit canonical replacement → genuine replacement answer. Cancellation supplies no answer, retains the original pinned owner and required hold, and creates zero wakeups. The real MCP SDK/HTTP/heartbeat proof persists exactly one wakeup and one queued heartbeat run for the original task after the genuine answer. A forced failure after wakeup leaves `recovery_required`; repeating the same handle creates no second wakeup/run. This is local persisted continuation evidence, not a live provider execution claim.

## Implemented boundaries

- Two additive registry operations, `human_questions.recovery.list` and `human_questions.recovery.cancel` (24 registered operations total). Recovery is restricted to required workforce questions on the current assignee.
- Safe metadata/readback/receipt contains only issue and interaction IDs, state, resolver ID and resolution time. It excludes private prompts, answers, titles, cancellation text and source IDs. Ordinary original-question read remains owner-only.
- Existing foundation authority witnesses current credential, active member, issue/project access, current assignee and accountable/steward chain, and the old owner's membership including inactive rows. Writes retain company-first locking. No network/filesystem/provider work was added under locks.
- Mere administrators and cross-company IDs are refused. Confirmation refuses old-owner reactivation, accountability change, membership/key revocation and project-access revocation.
- Web sessions use existing preview/apply semantics and the canonical cancellation/replacement operations. Their durable receipt is the persisted interaction/audit, not a board-key handle. Repeated cancellation or repeated replacement with the reviewed preconditions is refused. UI clears a sent confirmation and reads current state after an uncertain acknowledgment.
- Workforce UI discovers recovery from enrollment's first-job ID even when readiness is 404. Native human MCP and bridge use the same finite registry. Existing replacement and answer paths remain canonical.
- Current source has consolidated CEO/CoS/worker prompts into the default bundle. Updated the canonical default block and proposal-creator inheritance comment; did not resurrect removed CEO/CoS files. Human MCP playbook and generated MCP/API references are synchronized.

## Fresh verification

110 distinct focused tests passed: 83 server tests, 24 UI tests, 2 native human MCP tests and 1 shared ingress test. The receipt assertion was rerun after its final addition. All four scoped typechecks passed: server, UI, shared and MCP server. `git diff --check`, API reference drift and MCP reference drift passed. The API generator still reports its existing unsupported `updateAgentSchema` conversion; drift check passes and this slice changes only two enum entries in generated OpenAPI.

| Check | Evidence log |
| --- | --- |
| Real PostgreSQL/HTTP red regression | `/tmp/question-recovery-red.log` |
| UI red discovery regression | `/tmp/question-recovery-ui-red.log` |
| Server: human-control, source authority, workforce questions, heartbeat runtime, human auth (83) | `/tmp/question-recovery-regressions.log` |
| Final receipt-specific rerun | `/tmp/question-recovery-receipt-final.log` |
| UI: questions, detail queries, onboarding (24) | `/tmp/question-recovery-ui-final.log` |
| Native human MCP (2), shared ingress (1) | `/tmp/question-recovery-mcp-regressions.log`, `/tmp/question-recovery-shared.log` |
| Real SDK/HTTP persisted continuation and unknown acknowledgment | `/tmp/question-recovery-sdk.log` |
| Scoped TypeScript | `/tmp/question-recovery-{server,ui,shared,mcp}-types.log` |
| Generated references | `/tmp/question-recovery-{api,mcp}-drift.log` |

Tests ran with `env -i`, PATH `/opt/homebrew/bin:/usr/bin:/bin`, and synthetic HOME/XDG_CONFIG_HOME/HERMES_HOME/PAPERCLIP_HOME below `/tmp/agentdash-question-recovery-env`. Disposable PostgreSQL uses dynamically allocated ports excluding 54329 and 3100/3120/3199/3300; HTTP listeners use port 0. No provider/customer credentials, real SSH, runtime service restarts or live project data were used.

Commands after applying that environment:

```sh
# From server/
node ../node_modules/vitest/vitest.mjs run src/__tests__/human-control.test.ts src/__tests__/human-workforce-source-authority.test.ts src/__tests__/workforce-questions.test.ts src/__tests__/workforce-heartbeat-runtime.test.ts src/__tests__/human-control-auth.test.ts
# From ui/
node ../node_modules/vitest/vitest.mjs run src/components/WorkforceQuestions.test.tsx src/pages/WorkforceDetailQueries.test.tsx src/pages/WorkforceOnboarding.test.tsx
# From packages/mcp-server/ and packages/shared/, respectively
node ../../node_modules/vitest/vitest.mjs run src/human.test.ts
node ../../node_modules/vitest/vitest.mjs run src/__tests__/human-control.test.ts
# From repository root, each project separately
node node_modules/typescript/bin/tsc -p server/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p ui/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p packages/mcp-server/tsconfig.json --noEmit
node scripts/ci/check-api-reference-drift.mjs
node scripts/ci/check-mcp-reference-drift.mjs
```

## Limits and handoff

Ready for independent review as a bounded local fix. No push, PR, merge, production change or deployment was performed. No new dependencies or schema changes. Full monorepo builds/tests and browser screenshot/e2e suites were outside the assigned scope and were not run. No claim of full application transport parity, external provider execution, overall workforce readiness, quality/cost acceptance, or resolution of held architecture decisions #934/#936.
