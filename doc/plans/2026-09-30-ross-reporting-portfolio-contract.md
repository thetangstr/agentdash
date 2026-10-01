# Ross reporting contract and portfolio-context preparation — 2026-09-30

Bounded offline preparation package for launch-plan milestone 4 ("Make Ross continuously informed and prove portfolio operation"). This package implements *planning and validation only*. It activates no routine, schedules no wake, calls no provider, persists no portfolio store, and grants no authority. Real activation waits for governed owner adoption and the milestone-3 first-company outcome loop.

## Scope

Owned files:

- `scripts/ross/reporting-contract.mjs` — validated company-owner reporting terms, deterministic mapping to native routine/trigger/run-request boundaries, and pure checkpoint planning.
- `scripts/ross/portfolio-context.mjs` — private user-bound portfolio context assembly over the existing envelope reader, plus an inference-readiness descriptor.
- `scripts/ross/reporting-contract.test.mjs`, `scripts/ross/portfolio-context.test.mjs` — synthetic tests only.
- This document.

`scripts/ross/assistant-portfolio.mjs` is reused unchanged; its existing envelope handling (per-company whoami recheck, per-company failure isolation, bounded output) is the grant-check substrate.

## Reporting terms

`buildReportingContract(terms)` validates and normalizes:

- `companyId`, `projectId`, `reporterAgentId` — UUIDs; the reporter is the assignee of any mapped routine.
- `ownerApproval { reference, decidedBy, decidedAt }` — explicit approval provenance. Recorded, marked `verification: 'not-performed'`, `grantsAuthority: false`. The module never verifies or fabricates approval.
- `timezone` — IANA zone validated through `Intl`.
- `reviewWindows` — exactly three `{ id, weekdays, localTime }` entries; weekdays restricted to Monday–Friday (working-day semantics), unique windows and non-overlapping instants.
- `eventTriggers` — 0–4 `{ id, kind: 'api' | 'webhook', label, signingMode }`; webhooks require a native signing mode (default recommendation `hmac_sha256`), api triggers carry none.
- `dueWithinMinutes` — the due-checkpoint interval (a four-hour cadence is `240`).
- `coalescing` — `coalesce_if_active` or `skip_if_active`; `always_enqueue` is rejected because duplicate triggers must not produce duplicate planned work.
- `missedReport { escalateAfterMinutes, escalateTo: 'board' }`.
- `budget { maxRunsPerCheckpoint, maxRunSeconds, maxTokensPerRun, maxUsdPerWindow }` — all four explicit; no silent defaults, no unknown-as-zero.
- `sourceFreshnessMs` — fixed at one hour (`REPORT_SOURCE_FRESHNESS_MS`), independent of cadence. A report may satisfy the four-hour due cadence while its source is stale; `assessReportTiming` returns the two verdicts separately and never relabels stale as fresh.

## Deterministic native mapping

`mapReportingContractToNative(contract)` produces payloads shaped to `createRoutineSchema`, `createRoutineTriggerSchema` and `runRoutineSchema`:

- One `paused` routine (`concurrencyPolicy` from the contract, `catchUpPolicy: 'skip_missed'`). Paused is deliberate: contract changes grant nothing, and a board actor with `tasks:assign` must activate after governed owner adoption.
- One `schedule` trigger per review window: `m h * * <weekdays>` cron in the contract timezone — the same timezone-aware cron the native `nextCronTickInTimeZone` consumes.
- One `api` or signed `webhook` trigger per event trigger.
- A `runRequestTemplate` (`source: 'api'`, deterministic `idempotencyKeyTemplate`).

`readiness.status` is `'partial'` with explicit `unsupported` entries: due-checkpoint deadlines, missed-report escalation, budget caps, and holiday calendars are not expressible on the native routine payload; each names the required hook.

## Checkpoint planning

`planReportingCycle(contract, { now, events, deliveries, horizonDays })` enumerates window checkpoints in company local time over a bounded horizon (≤14 days) and returns descriptors only:

- Obligation statuses: `upcoming`, `open`, `missed`, `delivered`, `delivered-late`.
- A delivery satisfies the latest unmet obligation at or before it; earlier missed checkpoints stay missed.
- Events attach to the containing open obligation or create a bounded ad-hoc obligation (≤10); duplicate event ids and clustered events coalesce into a single planned request per obligation via deterministic idempotency keys. Undeclared trigger ids are recorded under `uncoalescedEvents`, never planned.
- Missed obligations carry an `escalation` descriptor (`pending`/`required`, `hook: 'native-missed-checkpoint-detector-absent'`) — surfaced honestly, not executed.
- Unmatched deliveries and uncoalesced events are reported, not rewritten.

`zonedTimeToUtcMs` resolves wall-clock windows across DST: ambiguous fall-back times resolve to the earliest occurrence; nonexistent spring-forward times resolve forward by the transition delta.

## Portfolio context

`createPortfolioContextAssembler({ userId, reader, revalidateGrant })` builds an ephemeral, private, user-bound context:

- `reader` is the existing assistant portfolio reader; its own per-company `whoami` pre/post identity checks, per-company failure isolation and output bound remain in force.
- `revalidateGrant(companyId, userId)` is a required caller-supplied current-grant recheck at assembly time — no default-permit. A revoked or unproven grant excludes only that company (`grant-revoked-or-unchanged-unproven`); other companies stay usable.
- Envelopes whose `data.companyId` disagrees with the selected company, or whose `asOf` is invalid/future, drop that company (`source-consistency-failed`). Excluded rows carry only `companyId` + `reason`; no error bodies or cross-company content leak.
- The result is marked `binding.kind: 'user'`, `companyBound: false`, `companyMemory: false`, `permissionAuthority: false`, `persistence: 'ephemeral-no-store'`, `synthesis: 'none'`. Combined context is never a company memory/document/session.

`portfolioInferenceReadiness(runnerContract)` returns `not-ready` (`inference-runner-contract-absent` or `-invalid`) unless a shaped governed-inference contract (pinned model/provider/endpoint, explicit run/token/USD caps, approval reference) is supplied; even then it returns `contract-present-not-dispatched`. Every actual GLM turn still requires a native approved governed budget/run receipt; cost stays `unknown-until-governed-receipt`. There is no direct provider/model call path in this package.

## Hooks required for later native activation

1. Owner adoption: a board actor with `tasks:assign` creates the mapped routine/triggers and activates it; the contract artifacts are inputs, not authority.
2. Missed-checkpoint detector + board notification route — nothing native detects an absent report today.
3. Checkpoint deadline evaluation — compare `routine_runs` against planned `dueAt` values.
4. Budget/token caps — configured through the existing heartbeat budget/quota path under governed owner adoption.
5. Holiday calendar — cron weekdays cannot express regional holidays.
6. Governed inference runner contract — required before any real portfolio turn; synthetic A/B remains preparation until a real second company completes the milestone-4 evidence loop.

## Verification

```sh
node --test scripts/ross/reporting-contract.test.mjs scripts/ross/portfolio-context.test.mjs
```

15 tests (9 + 6), all synthetic. This package does not satisfy real two-company activation, provider receipts, or launch acceptance; those remain milestone-4 exit evidence.
