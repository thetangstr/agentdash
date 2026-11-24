# Count distinct Codex tokens at the daily wake ceiling

Owner: Codex / AgentDash platform engineering. Local fix requested by dispatch `msg_533656ac4026`; no cap override or HQ release authorized.

Root cause: Codex native input includes its cached subset, which is forwarded unchanged through normalization to runFacts and cost events. The ceiling and agent-run complexity total add the subset again. Claude, Hermes, Pi and OpenCode expose separate input/cache counters; provider names and an agent's current adapter cannot identify a historical run's semantics. Gemini, Cursor and gateway adapters accept mixed raw conventions and retain their existing conservative additive treatment in this narrow Codex fix.

Plan:
1. Reproduce the supplied Sam/David/Jerry reconciliation with real disposable PostgreSQL fixtures and retained `adapter.invoke` events. Add exclusive, unknown, conflicting, missing-provenance and durable-facts cases before implementation.
2. Share one SQL expression between daily/no-op totals and new agent-run token/complexity records. A server-written runFacts adapter stamp is authoritative; otherwise require every scoped invocation event to identify Codex. Scope by company/run/agent; never multiply totals by joining invocation events. Unknown provenance stays additive. Gross Codex input is at least its cached subset if old counters are incomplete.
3. Persist the producing adapter in new runFacts so event retention does not erase identity. Historical rows are corrected on read where retained provenance exists, without rewriting raw counters or monetary costs.
4. Verify service, heartbeat/wake gate and adapter regressions; record commands/results and package this change separately from the existing intake patch. Review before submission; existing production authority applies.

Boundaries: no company/provider inference runs; no credentials or production writes. Historical rows whose invocation evidence has already been purged cannot safely be reduced. Existing materialized `agent_runs.token_count` rows are not automatically rewritten by an idempotent record insert. Mixed-adapter cumulative UI aggregates currently lack per-row provenance and are not redefined by this daily-ceiling repair; financial pricing is unchanged. A later normalization/API migration must explicitly address those surfaces rather than silently changing raw counters.

Acceptance: default 5M ceiling reports Sam 2,989,467 (not paused), David 3,956,421 (not paused), Jerry 12,256,186 (paused). Exclusive/unknown adapters keep cached tokens; company/agent scoping, UTC reset, exact boundary, explicit off, unmetered runaway and wake admission behavior stay covered.

## Implemented and verified locally, 2026-11-24

Review branch: `codex/fix-codex-token-ceiling-1124`, based directly on main `ddd92b654d75d89a2d8685a77363877883b60f26`. The earlier intake-retirement candidate and its working diff are excluded. This is a review candidate, not an approved release.

| Verification | Result |
| --- | --- |
| Final server sweep: ceiling, heartbeat gate, ceiling routes, self/owner wakes, run facts, heartbeat finalization, backfill, agent runs and cumulative usage baseline | 9 files, 163 tests passed |
| Codex/Claude/Pi/OpenCode parsers, Hermes ledger parser and shared UI display helpers | 6 files, 97 tests passed |
| Shared source typecheck | Passed |
| Server semantic source typecheck, current-source aliases, declaration output disabled | Passed |
| Independent review and focused re-review | Both requested fixes resolved; no remaining findings in reviewed scope |
| `git diff --check` | Passed |

Total: **260 passing tests**, with repeated runs excluded. The ceiling fixture checks assert both `tokensToday` and paused status, as well as matching no-op totals. Exclusive/unknown cases remain additive; invocation retries and malformed company/agent evidence cannot multiply or contaminate a run. Incomplete Codex counters retain at least their known cached units.

Review caught two extra issues and each received a failing regression before repair: another agent's malformed cost event could enter the run aggregate, and forced backfill could erase known Codex usage after switching the agent to Hermes. The former now filters by company/agent/run. Backfill selects the recorded adapter's source; stamped Hermes rows are retained and reported when the former ledger configuration cannot be recovered. Unstamped legacy backfill behavior remains unchanged.

Evidence directory: `/Users/Kailor/Storage/Scratch/yarda-setup-1119-checks/`. Final logs: `token-ceiling-verified.log`, `token-ceiling-adapters-green.log`, `token-ceiling-verified-types.log`, `token-ceiling-shared-types.log`. RED evidence: `token-ceiling-red.log`, `token-facts-red.log`, `token-run-totals-red.log`, `token-run-agent-scope-red.log`, `token-backfill-red.log`, `token-backfill-adapter-switch-red.log`. A SHA-256 manifest and portable patch are retained there as `token-ceiling-1124-receipt.json` and `token-ceiling-1124.patch`.

Harness limits: tests reused retained dependencies, with current shared and adapter-utility source aliases; no dependency installation or full fresh product build. Server semantic checking disables declaration emission because retained symlinked dependencies have known declaration portability problems. The first extra parser sweep could not resolve three adapters' utility imports; the explicit current-source utility alias resolved this and all six files passed. A verification sweep that overlapped the intentional cost-scope RED test failed that new regression; the final stable sweep above passed. Node emitted its existing experimental SQLite warning. No CI, query-plan benchmark or live HQ/provider acceptance is claimed.

No cap override, company assignment change, monetary repricing, model execution, merge or production deployment occurred. Existing release approval and host verification remain required.
