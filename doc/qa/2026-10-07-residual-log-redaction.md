# Residual log redaction verification — 2026-10-07

Base: `0efe570ea46e5204f8ea1b5297ee8908f9f3916e`.
Scope: cooperative feedback bundle sanitization, workspace-operation log reads,
and the existing recovery evidence-tail scrub. No dependency, migration,
provider invocation, deployment, push, or production verification.

## Change and policy

The shared text redactor now drains the same resumable normalization, match,
and output-assembly steps in either synchronous or asynchronous mode. Pattern
order, original-input offsets, overlap claims and replacement policy are
unchanged. Async scans own their regex cursors, so another asynchronous request
or synchronous persist operation cannot move a suspended scan's cursor.

Feedback's async text path retains current-user redaction, runtime known keys,
all feedback-specific patterns, count semantics and post-redaction truncation.
It cooperates during the shared pass and between feedback pattern/match batches;
it does not run a second synchronous whole-string secret pass. Structured
values retain the existing structured-secret policy and yield between values.
Trace file reads, normalized adapter traces, run metadata/events and bundle log
construction use the asynchronous paths where large data can enter.

For valid NDJSON, feedback sanitizes decoded values and property names before
encoding. This is a deliberate correction to regex-on-serialized-JSON behavior:
escaped credentials cannot consume JSON delimiters. Its summary truthfully
counts decoded values/structured records (rather than claiming byte-for-byte
summary equality with the old raw-string pass). Truncation retains complete
records and still accounts for later redactions; `truncatedFields` records the
omitted suffix. Malformed legacy NDJSON falls back to the cooperative whole-text
policy, preserving crossline PEM, quoted and known-secret matches and the old
text truncation behavior.

Workspace-operation storage supplies internal raw bytes and start offsets;
reads extend the final record to its newline. The service uses the shared
cooperative serve reader, returns only content and raw-byte `nextOffset` plus
its established operation identifiers, and never serializes the raw buffer.
This store has no persist trust marks; every range is checked. The existing
run-log store's trusted-prefix and epoch-invalidation behavior is unchanged.

Recovery still reads the final 8KB and applies current-user + legacy sensitive
text + shared-secret rules before the existing evidence truncation. The shared
whole-text pass is now cooperative; event-message behavior is unchanged.

## Evidence

- Red: the first four feedback tests failed because the asynchronous paths did
  not exist. The workspace test failed parsing a page ending inside a record.
- Green: synthetic multiline feedback output, privacy summaries and truncation
  match the synchronous text/value policy. A queued `setImmediate` runs before
  completion; known secrets, PII, crossline keys, quoted values and PEM remain
  hidden. Cancellation rejects without publishing partial text/NDJSON counts.
- Fresh shared-policy holdouts: multiline keys, Unicode normalization, escaped
  JSON, >1MB scan-boundary content, oversized values, and interleaved async/sync
  scans. Existing synchronous and adversarial/performance suites passed.
- Workspace: 5,000 synthetic legacy records with escaped credentials and
  multibyte text reconstruct in order without skips/duplicates; all returned
  whole lines parse, raw cursors end at file newlines, and no raw metadata or
  seeded secrets are exposed.
- Recovery: a synthetic midline tail preserves the previous scrub output and
  current-user protection and yields with a forced checkpoint interval.
- Additional red/green: malformed legacy NDJSON originally lost crossline
  context; credential/PII property names originally escaped decoded-value
  sanitization. Both regressions were reproduced and fixed.
- Isolated combined run: **13 files, 450 tests passed**. Includes all shared
  redaction suites, feedback service, heartbeat process recovery, run-log store,
  run-log serve, and the new residual suites.
- Shared and server typechecks passed. Final affected rerun after the two
  NDJSON edge fixes: **4 files, 24 tests passed**; both scoped typechecks
  passed again. `git diff --check` passed. Full monorepo typecheck/test/build and
  independent security review belong to the integration owner; no PR-ready or
  production-performance claim is made by this slice.

The event-loop improvement is qualitative and reproduced: large feedback work
now admits a queued event-loop callback during processing, while the old
synchronous sanitizer cannot. This is not a measured production latency bound.

## Isolation and limitations

The new unit suites mock provider-key discovery and use synthetic credentials.
An initial invocation of existing run-log suites inherited the environment;
those helpers may have read default Hermes profile files through the production
redactor. No keys/configuration were printed or deliberately inspected, but that
initial execution cannot be claimed to have been fully isolated. The definitive
combined rerun used an allowlisted environment and temporary HOME,
XDG_CONFIG_HOME, HERMES_HOME, HERMES_PROFILES_DIR, AGENTDASH_HERMES_ROOT and
PAPERCLIP_HOME. Embedded test databases reserve port 54329; HTTP fixtures use
OS-assigned ports. No real provider/SSH invocation or production contact occurred.

Cooperative checkpoints cannot preempt one regex search/callback, JSON
parse/serialization, current-user/structural traversal, sort, allocation, or
join. An oversized single record still exceeds the normal byte budget, and
workspace reads may extend past limitBytes to complete it. Memory is still
proportional to the input; this does not turn feedback export into a streaming
or bounded-memory API. Cancellation works at the helper checkpoints when a
signal is supplied; this slice does not add route-disconnect cancellation or
interrupt storage I/O. Legacy arbitrary midline tails retain existing best-effort
partial-text semantics; no new guarantee is made for an unknown secret whose
label or prefix was outside the stored/read range.

## Reproduction

Run in the isolated Task 5 worktree with installed frozen dependencies. Use a
fresh temporary home and allowlisted environment; do not inherit credentials or
provider/transcript paths. The combined test selection is:

```sh
pnpm exec vitest run \
  packages/shared/src/redact-secrets.test.ts \
  packages/shared/src/redact-secrets-bypass.test.ts \
  packages/shared/src/redact-secrets-memo.test.ts \
  packages/shared/src/redact-secrets-perf.test.ts \
  packages/shared/src/redact-secrets-async.test.ts \
  server/src/__tests__/feedback-redaction.test.ts \
  server/src/__tests__/feedback-service.test.ts \
  server/src/__tests__/recovery-evidence-redaction.test.ts \
  server/src/__tests__/heartbeat-process-recovery.test.ts \
  server/src/__tests__/workspace-operation-log-redaction.test.ts \
  server/src/__tests__/run-log-serve-redaction.test.ts \
  server/src/__tests__/run-log-store.test.ts \
  server/src/__tests__/run-log-redaction.test.ts
pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck
```

Local evidence logs: `/tmp/agentdash-residual-isolated-tests.log`,
`/tmp/agentdash-residual-typecheck.log`,
`/tmp/agentdash-residual-final-tests.log`, and
`/tmp/agentdash-residual-final-typecheck.log`. These are execution logs, not
production evidence or committed artifacts.

## Independent review repair — round 1

Independent review of `d163c613a038dd6312cfb6b795530b01731abae7` requested two
repairs: numeric phone values bypassed decoded-string sanitization, and distinct
PII-bearing property names could collapse to one output name and lose a value.

Both were reproduced before implementation. The numeric regression failed on
nested/array phone numbers and standalone numeric NDJSON; the collision
regression failed on missing earlier values, including a whole-record truncation
case. Numeric NDJSON values now pass their serialized representation through the
existing feedback text policy. Values without a match retain their original
number type; detected values become JSON-safe strings with the existing marker.
General structured-value callers do not enable this numeric check, preserving
their earlier policy.

Key allocation reserves all sanitized base names before choosing suffixes, so a
later literal marker or suffix name cannot be overwritten. Repeated collisions
receive deterministic `__2`, `__3`, ... suffixes, skipping reserved/assigned names;
per-base suffix cursors avoid repeatedly scanning earlier collisions. Nested
records allocate independently. Suffixes and summary paths contain only sanitized
names. Tests retain every input value, verify repeatability, check exact redaction
counts, and account for numeric/key redactions beyond whole-record truncation.

Round 1 final verification: **2 files / 26 tests passed** (feedback redaction and
feedback service); shared/server scoped typechecks and `git diff --check` passed.
Every repair-round test invocation used an allowlisted environment and fresh
synthetic home/provider directories. No broad test run or production/provider
access was performed for this round. Evidence logs:
`/tmp/agentdash-redaction-r1-numeric-red.log`,
`/tmp/agentdash-redaction-r1-numeric-green.log`,
`/tmp/agentdash-redaction-r1-collision-red.log`,
`/tmp/agentdash-redaction-r1-final-tests.log`, and
`/tmp/agentdash-redaction-r1-final-typecheck.log`.
