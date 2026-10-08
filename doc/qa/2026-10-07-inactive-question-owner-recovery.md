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


## Root browser and generated-artifact verification

Root inspected actual baseline components from `052acc60edb022d77e874386a593ca51e33dfb9e` and current components from `92cb1d9080325d00845723f6a107227081aa6f68` in a disposable real-component harness on loopback3479. The API is an explicit synthetic in-memory fixture, with no database, provider, customer data or production calls. This is component browser evidence, not a full authenticated application or persisted-runtime proof.

Before: readiness404 leaves no recovery controls. After: readiness404 still permits discovery, cancellation preview/confirmation and explicit replacement preview. The browser separately opened the fixture's replacement state, submitted a genuine typed answer through the canonical response UI, and observed “Working on first job.” Shared Chrome navigation interrupted the earlier sequence after replacement confirmation, so these browser steps are not claimed as one continuous end-to-end transaction. The independent real PostgreSQL/HTTP/SDK tests above establish persisted cancellation, hold preservation and exactly-one continuation.

At390px, measured document scrollWidth equals innerWidth390. Root viewed the before and replacement-review screenshots. Screenshots below contain only neutral synthetic content:

- [Before recovery fix](assets/2026-10-07-question-recovery/before-desktop.png)
- [After: recovery available](assets/2026-10-07-question-recovery/after-recovery-available.png)
- [After: replacement review](assets/2026-10-07-question-recovery/after-replacement-review.png)
- [After: replacement question](assets/2026-10-07-question-recovery/after-replacement-question.png)
- [After: answered](assets/2026-10-07-question-recovery/after-answered.png)
- [Mobile](assets/2026-10-07-question-recovery/after-mobile.png)

Generated search metadata was corrected at `840c8c5bfa79384a636fe1bcef198f975a6329fa`; its3 currentness tests passed, and independent review approved both this exact branch and the corrected composition `ffa268e2e2c940f3afb3a75fe978f08f06d39731`. Production source was unchanged by the search correction and screenshot evidence. Full composed typecheck passes; full composed test/build and required PR CI remain gating before landing. No production deployment or external provider execution is claimed.

## Local dependency composition before redaction lands

Fetched actual `origin/main` at `c557176cf807c370c0463f75811bc316a4cc7806` and merged it locally as `832e6341e`. Then composed exact redaction dependency `96cdaeea3a0eb6b0e11d064d261ec7d16f5074f7`. This is a preparatory local merge, not proof that the redaction PR has landed. After PR #1077 is squash-merged, actual updated main must be merged before final review or any push so the eventual recovery PR has narrow ancestry.

The sole merge-conflict file was the canonical default prompt. Its resolution and the generated-hire prompt source match the approved composed `ffa268e2` byte-for-byte, preserving security, SSH, redaction and recovery guidance. All 13 other recovery source/test paths match approved `92cb1d908` exactly. The main-relative patch for those 13 paths equals the original `052acc60e..92cb1d908` patch; both SHA-256 hashes are `911c1072d4899968485414b0245bedcdeeddc6751f052e09ecc88cd9b800d1d4`.

Regenerated route index, OpenAPI, MCP reference and documentation search index from real sources. Paperclip attribution remains present. Compared with actual main, search metadata adds only the recovery heading and the route count/digest change, and the route index adds the same three recovery routes.

Fresh composed verification: **179 tests passed** — server 146 across 9 suites, UI/search 27 across 4 suites, human MCP 2, shared ingress/cooperative redaction 4. Server suites include all five original recovery controls, agent-creation authority, budget-approval visibility, workspace-operation visibility and recovery-evidence redaction. The real SDK/HTTP test still records only one original-task wake/run after a genuine answer and rejects replay after a forced acknowledgment loss. The synthetic-adapter heartbeat control still holds unanswered input without adapter/quota use and resumes once. Server/UI/shared/MCP scoped typechecks, generated API/MCP drift, search currentness, and diff checks passed.

Commands used the task-owned `/tmp/agentdash-question-recovery-env/run-safe.sh`: `env -i`, PATH restricted to a synthetic node/pnpm bin plus `/usr/bin:/bin`, and synthetic HOME/XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME/XDG_STATE_HOME/HERMES_HOME/PAPERCLIP_HOME. Real provider commands/configuration, SSH, shared runtime ports and production resources were not used. Disposable database helpers retain the reserved-port exclusions.

Evidence: `/tmp/question-recovery-composed-{server,ui,mcp,shared}.log`, `/tmp/question-recovery-composed-{server,ui,mcp,shared}-types.log`, `/tmp/question-recovery-composed-{api,mcp}-drift.log` and `/tmp/question-recovery-composed-{route-regen,openapi-regen,mcp-regen,search}.log`. No broad monorepo build/test or deployment was run in this preparatory slice.
