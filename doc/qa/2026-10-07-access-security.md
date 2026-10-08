# Task 2 implementation report — 2026-10-07

Base for independent review: `97ec8e21f`. Initial implementation head: `7c63d332f`; subsequent correction evidence appears below.


## CI fixture correction after security review

Base: `06fd244c7168f3443fda1fe2c5fafb9e6bd0ab8b` (PR #1074). Completed CI shards identified four stale test expectations: approval-provenance-spoof's ordinary REST success supplied `bridge_inbox`, and three activity-list expectations omitted `visibleWhere`, `includeSystem`, and/or `since`.

Only test fixtures/assertions changed. The success control now requests and checks persisted `web` provenance. Activity expectations include the current arguments and require a SQL visibility condition; a compiled-query assertion verifies the financial event/action exclusions remain in that condition. Production permission and filtering code is untouched.

Validation used `/tmp/agentdash-security-ci-fixtures.py`, a disposable HOME/XDG/PAPERCLIP_HOME wrapper with explicitly allowlisted environment variables (PATH, synthetic home paths, TMPDIR, NODE_ENV, billing-disabled test flag and synthetic user names). The wrapper runs `pnpm -C server exec vitest run <paths> --maxWorkers=1 --fileParallelism=false`; real database suites retain the disposable PostgreSQL helper excluding 54329.

- Red: `approval-provenance-spoof.test.ts` and `activity-routes.test.ts`: **4 failed / 29 passed**, matching CI exactly (`/tmp/task2-ci-fixture-red.log`).
- Green: those two suites plus `agentdash-mk-approval-authority.test.ts`, `budget-activity-visibility.test.ts`, and `dashboard-cost-visibility.test.ts`: **90/90 passed** (`/tmp/task2-ci-fixture-green.log`).
- `pnpm -C server typecheck` under the same synthetic-home/allowlisted environment: **exit 0** (`/tmp/task2-ci-fixture-typecheck.log`); `git diff --check` clean.
- No sensitive configuration reads, live provider probes, broad suite, push or integration-branch changes. Root owns independent correction review and hosted CI confirmation.

## Security review correction round 2

Correction base: `b1dc5e37c48abd875299b0eda058fe3e55e69564`. Independent re-review found an additional HIGH bypass: a creator/current steward without spend authority could read monthly amounts through an allowed agent PATCH or configuration revision snapshots. This round closes those response paths; root must independently re-review the new commit before landing draft PR #1074.

A pure `redactMonthlySpendForReader` now handles structured monthly fields, with the existing `canReadCompanySpend` resolved at each route boundary. Agent list/detail, PATCH, create/hire, rollback, preflight and lifecycle mutation envelopes use it. Revision list/detail redact both before/after response snapshots while preserving stored history and existing credential sanitization. Configuration authority and all action gates remain unchanged. Authorized owner/agent controls retain actual amounts; unavailable values are null, never zero.

The hire envelope also uses the existing approval response redactor. Its explicitly typed `hire_agent` payload hides monthly fields for denied readers everywhere that helper is used, retaining credential protection. Arbitrary approval types and user prose are untouched. Direct creation still returns its one-time API key. The canonical default prompt and inherited `renderAgents` guidance explain configuration/history versus spend access; no deleted role bundles were recreated.

Fresh evidence (all Vitest commands use `pnpm -C server exec vitest run` and `--maxWorkers=1 --fileParallelism=false`):

- Before correction, `agent-config-read-steward-routes.test.ts`: **6 meaningful failures / 13 passes**. Steward and creator each leaked 876543 through PATCH, revision list and revision detail. `/tmp/task2-round2-red.log` also records an unrelated initial create-fixture missing timestamp; that fixture was fixed before its red evidence was collected.
- Before correction, `agent-create-authority.test.ts`: **2 failures / 32 passes**, both ordinary-member create/hire envelopes returned 876543 instead of null (`/tmp/task2-round2-create-red.log`).
- Core routes after correction: **53/53 passed** (`/tmp/task2-round2-green.log`). The new history cases verify actual stored snapshots remain unchanged, credential fields remain sanitized, and owner/agent readers retain actual amounts.
- Bounded existing controls: `agent-permissions-routes.test.ts` **79/79**, `onboarding-accepted-hire.test.ts` **22/22**, `budget-approval-spend-visibility.test.ts` **16/16**, plus core and redaction controls passed (`/tmp/task2-round2-controls.log`). One existing governance assertion expected a steward's submitted budget echoed; it now checks the null response and separately verifies the accepted 9000 value persists, while the ceiling refusal remains asserted.
- Final focused rerun: governance (54), configuration reads/history (19), creation authority (34) and redaction (8): **115/115 passed** (`/tmp/task2-round2-freeze.log`). Together with the unchanged passing controls above, **232 distinct scoped tests passed** after the governance expectation correction.
- `pnpm -C server typecheck`: **exit 0** on final code (`/tmp/task2-round2-typecheck-final.log`). `git diff --check`: clean.

No UI implementation or shared schema changed. Configuration history UI displays metadata/changed-key names rather than monetary snapshot values. Existing revision records and rollback semantics, approval provenance/idempotency and accepted-hire replay logic were not changed. This round used disposable PostgreSQL, ephemeral HTTP and synthetic filesystem state only; no provider calls, production contact, broad suite/build, push or merge. Root owns independent re-review and combined landing gates.

## Security review correction round 1

Correction base: `ee82e9107` (functional predecessor `4fb25e661`). This supersedes the initial #1057 approval-payload and mounted-403 coverage limitations; independent re-review is still required on the new frozen head.

The HIGH approval-payload disclosure was reproduced dynamically: 12 of the first 14 real-PostgreSQL route regressions failed. The new shared pure `redactApprovalForReader` preserves credential redaction and omits only `budgetAmount` / `observedAmount` for `budget_override_required` when the existing spend predicate denies access. Approval GET/list/create/approve/reject/override/revision/resubmit, issue-linked GET/link POST and both inbox builders apply the same response policy. Stored values, decision authority, project visibility and nonfinancial scope/escalation remain unchanged. Other approval types retain similarly named user fields.

Company create/PATCH/branding/archive responses now pass through `companyForReader`; mutation permission and archive behavior are unchanged. Regression tests prove plain-member PATCH/branding/archive still succeed and persist their intended state while returning null spend fields.

ApprovalDetail also suppresses cached monetary payload fields when the current company indicates unavailable spend, including its expanded Technical details. Its regression uses real nonzero amounts and proved red before the UI correction. Authorized UI controls retain actual amounts and the Costs link.

Fresh correction-round validation:

- `pnpm -C server exec vitest run src/__tests__/budget-approval-spend-visibility.test.ts --maxWorkers=1 --fileParallelism=false`: initial **12 failed / 2 passed** (`/tmp/task2-round1-red.log`), then **14/14 passed**. Expanded create/override controls bring the new suite to **16/16**.
- The new suite plus approval-authority, budget-project-visibility and dashboard-cost-visibility: **66/66 passed** (`/tmp/task2-round1-scoped.log`).
- UI ApprovalDetail, AgentDetail.config-access and ProjectDetail.budget-access: **9/9 passed** (`/tmp/task2-round1-ui-freeze.log`). The nonempty cached-amount regression failed before the correction (`/tmp/task2-round1-ui-red.log`). Both full detail pages are now mounted with an actual rejected 403 transport promise; no budget editor or zero-dollar fallback appears and escalation remains visible.
- Server typecheck: **exit 0** (`/tmp/task2-round1-server-typecheck-final.log`). UI typecheck initially found two missing test-error constructor arguments; these were corrected and the final result is recorded below.
- Existing inbox/idempotency/create-transaction/redaction controls: **42/42 passed** (`/tmp/task2-round1-existing.log`). Final UI typecheck: **exit 0** (`/tmp/task2-round1-ui-typecheck-final.log`). `git diff --check` passed.

No broad full-suite/build gate was run in this correction round, per root instruction. No new dependencies, policy, live provider operations, production access, PR or push. Root owns independent re-review and combined landing gates.

## Outcome and review units

- `8888ae5d5`: #1053. Both direct creation and hires reject agent-supplied CEO/CoS roles and `canCreateAgents: true` before configuration, environment, agent, approval or audit mutations. This includes CEO callers and CEO defaults/explicit false permissions. Board controls and ordinary agent hires remain supported. The hire tests also cover board-approval-enabled companies.
- `166958580`: #1054. REST approve/reject/override refuse telegram, teams, whatsapp and bridge_inbox provenance. Existing authority code retains assistant-grant enforcement and trusted server-selected connector channels. Revision/idempotency tests now use actual REST `web` provenance. The temporary timeout increase in this commit was reverted in `7c63d332f` after root review.
- `7c1e85bcf`: #1057. Company list/detail/stats, agent list/detail, budget overview and company financial activity use the existing spend predicate. Monthly amounts and stats tokens are null when unavailable. Financial events are filtered; monthly amounts in generic update events are omitted while nonfinancial changes remain. API types and company-card/agent-spend UI agree; unavailable is never zero. AgentDetail/ProjectDetail handle denied budget overview without displaying a zero-filled editor. Dashboard/ApprovalDetail keep budget-stop escalation without directing restricted readers to Costs.
- `7c63d332f`: operation visibility. Shared route guard checks each operation's workspace and run independently, including company consistency, project access and run-agent visibility, before reading log storage. Both related-list routes filter the other link. Null orphan links preserve company-visible history; present unresolved/cross-company links fail closed.

Both active prompt surfaces were updated. No removed role prompt bundles were recreated. No schema migration, dependency change, real provider/SSH execution, production contact or runtime enablement was performed. Test PostgreSQL uses the existing disposable helper, which excludes 54329; Supertest binds ephemeral HTTP ports. Agent-creation filesystem materialization uses synthetic PAPERCLIP_HOME and XDG directories and cleans up after tests.

## Decisions

Read `.omc/briefs/devin-20261003/decision-934-936.md` from the main checkout at root's direction. #1057 adopts recommendation A from #934: gate the full budget overview and preserve dashboard nonfinancial incident/paused counts. It does not change #936 archive semantics or create new permission roles.

Existing project-budget tests now grant their member fixtures explicit `agents:create` spend authority. They still prove that financial authority does not bypass project visibility. Separate plain-member regressions prove denied overview and hidden amounts.

## Fresh evidence

Commands below run from the isolated worktree; server/UI Vitest commands use `pnpm -C server exec vitest run` / `pnpm -C ui exec vitest run` followed by the paths listed.

| Check | Before | After / evidence |
|---|---|---|
| `src/__tests__/agent-create-authority.test.ts` | 20 privilege attempts incorrectly returned 201; 12 valid controls passed | 32/32 pass; `/tmp/task2-create-red.log`, `/tmp/task2-create-green.log` |
| `src/__tests__/agentdash-mk-approval-authority.test.ts` | 12 forged REST connector-channel cases accepted | 36/36 pass, including trusted service channels, assistant source, stale revisions and idempotency; `/tmp/task2-provenance-spend-red.log`, `/tmp/task2-final-server.log` |
| `src/__tests__/dashboard-cost-visibility.test.ts` | Company amounts exposed; later generic company.updated financial fields exposed | 5/5 pass; `/tmp/task2-provenance-spend-red.log`, `/tmp/task2-activity-red.log`, `/tmp/task2-spend-final.log` |
| `src/__tests__/budget-project-visibility.test.ts` and `budget-activity-visibility.test.ts` | Existing fixtures needed explicit spend authority under the new contract | 9/9 and 16/16 pass; combined spend suites 30/30; `/tmp/task2-spend-final.log` |
| `src/__tests__/workspace-operation-visibility.test.ts` | 6 failures: hidden links reached storage or leaked through related lists | 12/12 pass; only the log store is mocked, authorization and persistence use PostgreSQL; `/tmp/task2-second.log`, `/tmp/task2-operations-green.log` |
| UI `src/lib/company-card-figures.test.ts`, `src/pages/AgentDetail.test.tsx` | 2 failures: restricted values rendered as dollars/provider-token usage | Green, plus ApprovalDetail and dashboard controls: 77/77; `/tmp/task2-ui-red-new.log`, `/tmp/task2-ui-final2.log` |
| `src/__tests__/agent-permissions-routes.test.ts` | Existing controls | 79/79 pass; `/tmp/task2-server-targeted.log` |
| `src/__tests__/agent-visibility-routes.test.ts` | Existing controls | 18/18 pass; `/tmp/task2-visibility-expanded.log` |
| Existing `telegram-connector`, `teams-connector`, `whatsapp-connector`, `agentdash-mk-teams-delivery` suites | Synthetic connector controls | 56/56 pass; `/tmp/task2-connectors.log` |
| `pnpm --filter @paperclipai/shared typecheck` | — | exit 0; `/tmp/task2-shared-typecheck.log` |
| `pnpm --filter @paperclipai/server typecheck` | — | exit 0 on final code; `/tmp/task2-server-typecheck-final.log` |
| `pnpm -C ui exec tsc --noEmit` | Nullable fixture diagnostics resolved | exit 0; `/tmp/task2-ui-typecheck-final.log` |
| `pnpm check:architecture` | — | 0 errors, 6 existing localStorage-branding warnings; `/tmp/task2-architecture.log` |
| `git diff --check` | — | clean |

## Validation limits and follow-up owned by root

- The full `project-visibility.test.ts` run intermittently terminates one request with `socket hang up`, in different existing tests across two runs; all other assertions passed. The last affected `runs: list, live list` case passes when isolated (`/tmp/task2-project-isolated.log`). This remains a full-suite reliability limitation, not a clean aggregate pass claim.
- Initial concurrent suite startup exceeded an existing 20-second hook timeout. Retried with lower contention; the temporary timeout change was reverted as requested. Test-source loading also encountered a fixture duplicate issue-prefix error while authoring operation tests; fixed before the six meaningful baseline failures.
- Initial-round mounted-403 coverage gap is closed by security correction round 1 above. Both AgentDetail and ProjectDetail now have mounted denial regressions.
- Root owns the combined full workspace typecheck/test/build gate, independent security re-review after these fixes, dependency audit, PR creation and landing. No push, PR or merge was performed by this lane. Do not describe the candidate as release-ready until those gates pass.
- Root's in-progress edit to `doc/plans/2026-10-07-launch-security-and-reliability.md` was intentionally left untouched and uncommitted by this lane.
