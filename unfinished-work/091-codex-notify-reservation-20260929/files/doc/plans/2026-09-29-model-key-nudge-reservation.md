# Model-key notification reservation — 2026-09-29

Base: PR #843 head `853c95ae7cad40f5e286386a4e06645bf4820a3b`.
Owner: Codex correction in `codex/notify-reservation-20260929`; Devin's worktree remains untouched.

## Required behavior

`POST /api/onboarding/request-model-key` permits one notification **attempt** per company/requester per ten-minute window. A short transaction checks and durably records that attempt under a fail-fast advisory lock. It commits and releases its connection before external email starts. Contending reservations return bounded 429 responses; subsequent attempts use the durable row across app instances. Failed, skipped, partial or unexpectedly interrupted delivery does not remove the reservation or make delivered messages retryable within the window. Preserve per-recipient statuses and the existing key/address redaction and membership gates. The inherited billing 404 fix stays as-is.

## Implementation sequence

1. Install the exact lockfile offline in this isolated worktree and run the existing onboarding/billing tests for a clean baseline.
2. Add an embedded-PostgreSQL HTTP regression using the real route, transaction, SQL and activity writer; stub only outbound delivery. Before production changes, demonstrate that the original implementation cannot complete duplicates or unrelated pool queries while the first email is blocked.
3. Replace blocking lock acquisition with `pg_try_advisory_xact_lock`; use an honest short retry response when a reservation is in progress. Resolve recipients and names, record the intended attempt, and return that data from the transaction. Send only after commit. Keep delivery results separate from attempt logging.
4. Update the existing lightweight route fixtures for the try-lock result and honest attempt cooldown. Add real database tests for cross-pool contention, independent keys, reservation rollback before send, durable cooldown from another route/pool, and partial/failed delivery.
5. Run focused regressions, typecheck and build. Run full tests if resource capacity permits; otherwise record the precise outstanding verification for root. Inspect the corrective diff against the original PR head. Do not commit, push, create a PR, merge, deploy or contact live systems.

## Verification contract

- With delivery held unresolved, more duplicate HTTP requests than the test pool's connection capacity finish promptly with 429, an unrelated query completes, one durable attempt exists, and one batch is delivered after release.
- An independently held advisory lock yields prompt in-flight 429 without a send or reservation.
- A database error after reservation insertion rolls back the row and occurs before any send; a later healthy request may proceed.
- Partial/failed/skipped delivery preserves the committed attempt; another app/pool gets cooldown 429 with truthful wording. Changing requester or company is independent.
- The HTTP response retains only recipient names/statuses and never key material or email addresses.

## Tradeoffs

The record represents an attempt, not guaranteed delivery. A process crash after reservation and before delivery may require waiting for the cooldown; this deliberate bounded tradeoff prevents duplicate delivery after ambiguous external side effects. No new table, outbox, dependency or general logging refactor is added in this narrow correction. `logActivity` still publishes before its containing transaction commits; the reservation failure test proves no mail precedes commit, and the wider activity publication contract remains a separate concern.

## Evidence

- Frozen offline install completed without a lockfile change; workspace package build completed.
- Baseline inherited onboarding/billing suites: **83/83 passed**.
- RED against original PR head: **5 failed, 1 passed**, with the expected stalls, mail-before-reservation-failure, dishonest cooldown and lost marker after interrupted delivery. No production code had changed.
- GREEN after correction: **89/89 passed**, including **6/6 actual embedded PostgreSQL regressions, zero skips**. `pnpm -r typecheck` completed successfully.
- `pnpm build` completed successfully (including server, UI and CLI); Vite reported its existing large-chunk warning.
- Final scoped rerun on the finished patch: **89/89 passed**, including **6/6 actual embedded PostgreSQL regressions, zero skips**, in 12.95 seconds. `git diff --check` is clean.
- Independent review found the UI's generic 429 label still claimed delivery. The existing `ProviderKeyBlocked` test now covers both recent-attempt and in-flight responses: **RED 2 failed / 9 passed**, then **GREEN 11/11 passed** with the neutral "Please wait" label and exact server alert. UI typecheck completed successfully after this correction. The ownership extension is limited to that component and its existing test.
- Full `pnpm test:run` stopped with exit 1 in the inherited CLI suite after shared, database, adapter, MCP, plugin and UI suites passed (UI: **233 files / 1,438 tests**). CLI: **2 failed / 184 passed / 4 skipped tests**. Failures were `doctor.test.ts:99` (one warning rather than zero) and `worktree.test.ts` (embedded PostgreSQL reseed initialization failure). The full runner did not reach its server remainder; those inherited files are unchanged. The focused server suites above passed independently.

## Corrective patch for review

The six-file unstaged patch is relative to the inherited #843 head. New test/plan files have intent-to-add index entries so the complete patch includes them. No commit or push was made.

```sh
git -C /Volumes/mac_studio_ssd/Projects/agentdash/.claude/worktrees/codex-notify-reservation-20260929 diff 853c95ae7cad40f5e286386a4e06645bf4820a3b
```

The production delta changes `onboarding-v2.ts` (fail-fast reservation acquisition, durable attempt before delivery, honest 429 wording, delivery outside the transaction) and one cooldown label in `ProviderKeyBlocked.tsx`. The inherited billing 404 and first-run timeout remain in the base and are absent from this corrective diff. Existing route fixtures now return the try-lock result; actual database assertions live in the new six-case test file. Independent review and integrated release verification belong to root.
