# Cloud billing SC-8 implementation plan

> **For agentic workers:** Execute this plan inline using superpowers:executing-plans and superpowers:test-driven-development. This worker owns the isolated SC-8 worktree; no recursive delegation or commits are authorized.

**Goal:** Implement issue #769 as local, reviewable code: one Stripe endpoint, authenticated byte-preserving fanout, billing provisioning and operator rotation, and per-box Resend credentials with cleanup.

**Architecture:** The control plane verifies Stripe's timestamped HMAC before parsing a bounded raw body. A box-row lock serializes delivery and its durable event ledger; Stripe retries until a box accepts the exact bytes and the ledger commits. The actual box now commits its event ledger and company entitlement together, retrieves current Stripe state after locking the company, and defers notifications until commit. Per-box webhook and Resend secrets are encrypted in dedicated box columns before variable upsert; a stable provider key name reconciles a crash before persistence. Operator changes use the existing private IP plus bearer guard.

**Tech stack:** Existing Express 5, Drizzle/Postgres, Node crypto/fetch, Vitest/embedded Postgres, existing box Stripe runtime for an independent signature verification test. No dependencies added.

**Spec:** `docs/superpowers/specs/2026-09-25-self-serve-cloud-design.md` §3.7; GitHub issue #769.

## Global constraints

- Base `347ffaea5aba76cf818bccc3f3f9d19e0967d980`; branch `codex/cloud-billing-sc8-20260929` in `.claude/worktrees/codex-cloud-billing-20260929`.
- Preserve `capabilities.claimTrackingReady=false`, provisioning kill switch, edge-live gate, company boundaries and claim/cleanup guards.
- No live APIs, keys, registrations, email, fleet operations, local3199 writes, deployment, commit, push, PR or merge.
- No key material in job payload/error, audit detail, URLs, responses or logs; only `Secret`, authenticated encrypted credential columns, and outbound authorization/variable payloads may hold it.
- SC-8 does not absorb the separate billing404 work in PR843 or change voice, websocket, UI, Monica or ExecOS.

## Task 1: Checkout routing metadata

**Files:** `server/src/services/billing.ts`; new `server/src/__tests__/cloud-billing-metadata.test.ts`.
**Interface:** Checkout keeps `{companyId}` on the session and subscription; append `box_slug` only when `AGENTDASH_BOX_SLUG` is set. Reject invalid configured slugs rather than issuing unroutable checkout.

- [x] Write and run tests asserting both metadata locations and self-hosted behavior; observe the missing session metadata failure.
- [x] Construct one metadata object in `createCheckoutSession` and reuse it in `metadata` and `subscription_data.metadata`.
  ```ts
  const metadata = { companyId, ...(slug ? { box_slug: slug } : {}) };
  ```
- [x] Run the new test plus existing billing-service/trial tests.

## Task 2: Raw Stripe forwarding and durable delivery

**Files:** new `cloud/src/billing/stripe.ts`, `webhook.ts`; `cloud/src/app.ts`, `config.ts`, `db/schema.ts`, migration; new `cloud/src/__tests__/cloud-billing.test.ts`.
**Interfaces:** `stripeSignature(raw: Buffer, secret: Secret, timestamp?: number): string`; `verifyStripeSignature(raw, header, secret, now?)`; `stripeWebhook({db,config,log,alerter,fetch?})` Express handler.

- [x] Write red tests for raw-byte preservation, real Stripe `constructEvent`, tamper/time denial, unknown slug alert/no outbound request, concurrent duplicate/retry/crash window and reordered subscriptions.
- [x] Add encrypted `stripe_webhook_secret_enc`, provider credential fields, singleton encrypted billing state and `stripe_deliveries(event_id,payload_hash,box_id)`.
- [x] Verify incoming `t` and every `v1` using constant-time digest comparison; enforce 300-second tolerance. Parse JSON only after signature passes.
  ```ts
  createHmac("sha256", secret.reveal()).update(`${timestamp}.`).update(raw).digest("hex")
  ```
- [x] Mount `POST /api/cloud/stripe/webhook` before JSON middleware with a 256kb, uncompressed raw-body limit. Missing endpoint configuration returns503; invalid signature/body400; transient transport/durable-write failure502. A completed duplicate returns200.
- [x] Route only signed metadata to a syntactically valid slug found in the DB. Use its recorded `*.up.railway.app` host, no redirects, and a 10-second timeout. Unknown/missing slug is acknowledged and alerted without forwarding. Missing box secret refuses delivery.
- [x] Lock the box, check immutable event ID plus raw hash, retrieve current subscription for `customer.subscription.*`, forward fresh Stripe-format per-box HMAC plus the existing edge credential, then atomically update `planTier` and insert the success ledger. Crash before commit permits retry; the corrected box ledger/entitlement transaction supplies downstream idempotence.
- [x] Register the one endpoint only through an explicit guarded admin operation; stable Stripe idempotency key and encrypted response secret make retry safe. No boot-time provider writes.

## Task 3: Provisioning and Resend lifecycle

**Files:** new `cloud/src/billing/credentials.ts`, `resend.ts`; `cloud/src/railway/provisioner.ts`, `jobs/cleanup.ts`, `index.ts`; new provisioning/lifecycle tests.
**Interfaces:** `billingVariables(db, boxId, config, signal?)` returns an in-memory variable map; `revokeBoxMail(db, boxId, config, signal?)` clears encrypted credentials only after successful revocation.

- [x] Red-test provisioned `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, optional additional price IDs, `STRIPE_TRIAL_DAYS=14`, `AGENTDASH_FREE_AGENT_CAP=2`, `RESEND_API_KEY` and `AGENTDASH_EMAIL_FROM=AgentDash <no-reply@mail.agentdash.cloud>`.
- [x] Require the shared restricted `agentdash-boxes` key and separate control/Resend management credentials and verified domain ID for production provision jobs; preserve fixture-only legacy dependency injection. Refuse before project creation when inputs are missing.
- [x] Generate the webhook secret once and encrypt it before variable writes. Reuse an encrypted per-box mail token; if a create crashed before persistence, list all provider pages, revoke keys matching exactly the stable UUID-derived name, then recreate a `sending_access` key restricted by `domain_id`. Verify configured domain is `mail.agentdash.cloud` and verified.
- [x] Keep credentials out of job rows/logs/provider exception text. Serialize credential creation using the same box-row lock. Provider responses are never included in errors.
- [x] Add Resend revocation after guarded project deletion and before `mark_deleted`; retry/404 are idempotent. A failed revocation leaves cleanup pending.
- [x] Run crash, orphan, pagination, permission/domain, provider-error redaction, retry, cleanup-refusal and no-duplicate-key tests.

## Task 4: Private administration and operator guide

**Files:** new `cloud/src/billing/admin.ts`; `cloud/src/routes/internal.ts`, `admin/run.ts`, `admin/cli.ts`; new CLI/fleet tests; `doc/runbooks/cloud-control-plane.md`.
**Interfaces:** `configureStripeEndpoint(db, config)` returns non-secret endpoint ID/url; `rotateBoxKey(db, config, client, workspaceId, Secret)` returns slugs/counts, never the key.

- [x] Red-test `admin stripe rotate-box-key` takes its only credential from stdin, refuses positional credentials/invalid key, and does not echo provider failures.
- [x] Persist the new restricted key encrypted as the future provisioning source, then upsert each DB-known live box's Stripe variable after exact workspace, project-name, box-tag, environment/service guards. Failures return fixed reason codes and can be retried. Railway upsert uses `skipDeploys=true`; keep the old provider key valid until separately approved redeployment is complete.
- [x] Route both commands behind the existing admin guard; return non-secret summaries and append audit events containing IDs/counts only.
- [x] Document least privileges, configuration, Stripe endpoint creation, rotation/revocation order, replay semantics, Resend crash recovery and the unrun live acceptance gates.

## Review correction: actual downstream retry and event order

**Expanded ownership authorized by root:** `server/src/services/entitlement-sync.ts`, `stripe-webhook-ledger.ts`, new `billing-webhook-processing.ts`, route wiring and necessary tests.

- [x] Reproduce both actual route/DB failures before fixing: an older active event regranted a canceled company; a failed company update left a committed ledger row that poisoned same-event retry.
- [x] Claim the original event using `ON CONFLICT DO NOTHING RETURNING` inside the same transaction as company writes. Failed writes roll back the ledger; duplicates do not abort the transaction.
- [x] Lock the company before retrieving current Stripe state. Pin returned subscription ID, customer, company metadata and hosted box slug. Bound SQL lock wait to 2 seconds and provider request to 5 seconds with zero SDK retries; sanitized provider errors permit Stripe-owned retry.
- [x] Queue downgrade/trial notifications for after commit. Add `customer.subscription.trial_will_end` to the sole endpoint's explicit event allowlist.
- [x] Exercise exact signed UTF-8 raw bytes from the real cloud handler into the real box router, separate real databases and real Stripe signature verification: stale cancellation, ledger rollback/retry and actual trial email notifier with fake transport. Test routing denial and actual lock contention too.

## Task 5: Verification and handoff

- [x] Run targeted billing/CLI/provision/cleanup tests and cloud typecheck first; resolve every SC-8 regression.
- [x] Run frozen-install verification, `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, and cloud suite separately if root runner excludes it. Preserve command exit codes/log summaries and identify pre-existing failures against the base when needed.
- [x] Inspect the diff for secret serialization, missing signature verification, SSRF/redirects, unknown-slug forwarding, launch-gate changes and unrelated edits. Report files/diff/fresh results to root; no commit or live execution.

## Primary references checked 2026-09-29

- [Stripe webhooks](https://docs.stripe.com/webhooks): raw bytes, duplicate deliveries, retry and event-order semantics.
- [Stripe endpoint creation](https://docs.stripe.com/api/webhook_endpoints/create): endpoint URL, event selection and creation-only signing secret.
- [Stripe current subscription](https://docs.stripe.com/api/subscriptions/retrieve): current-state reconciliation for reordered deliveries.
- [Resend official OpenAPI](https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml): API-key `permission=sending_access`, `domain_id`, pagination and deletion. Domain restriction is documented in the primary schema even though the short REST reference omits it.
- [Resend API-key creation](https://resend.com/docs/api-reference/api-keys/create-api-key), [list](https://resend.com/docs/api-reference/api-keys/list-api-keys), [delete](https://resend.com/docs/api-reference/api-keys/delete-api-key).

## Frozen correction checkpoint (2026-09-29)

- Fresh command: `pnpm exec vitest run server/src/__tests__/cloud-billing-box-retry.test.ts server/src/__tests__/billing-trial-lifecycle.test.ts cloud/src/__tests__/cloud-billing-integration.test.ts cloud/src/__tests__/cloud-billing-credentials.test.ts` — **31 passed, zero skipped**, exit 0. Log: `/tmp/codex-sc8-correction-final.log`.
- Composed regressions use the real control-plane handler, real box router, separate real Postgres databases and real Stripe signature verification. They preserve exact signed whitespace/UTF-8 bytes; verify canceled entitlements on both DB rows; inject a company-write failure then replay the same event with both ledgers rolled back; and invoke the actual trial email notifier with a fake transport after commit exactly once. Actual lock contention exited in about 2050ms and retried successfully.
- Initial actual box reproductions failed before the repair: canceled company became `pro_active`; injected update failure left one committed ledger row. The final composed suite closes both defects.
- Source frozen; independent review found no remaining actionable source findings and reran the correction suite with 31 passes. Fresh full `pnpm -r typecheck` passed, exit 0 (`/tmp/codex-sc8-typecheck-corrected.log`). `pnpm build` also passed, exit 0 (`/tmp/codex-sc8-build-corrected.log`). Fresh `pnpm test:run` failed in unchanged CLI tests before reaching cloud/server; details follow. The earlier unchanged OpenCode adapter timeout passed on this fresh full rerun, demonstrating a transient failure in this checkout; the earlier run remains a failed gate.
- No provider, fleet, local3199, claim/provision/edge activation, release or commit occurred. Live acceptance remains the runbook's separate approved gate.

## Final local verification evidence

| Gate | Actual outcome |
|---|---|
| Frozen offline install | `pnpm install --frozen-lockfile --offline` passed; no dependency/lockfile changes. |
| Full typecheck | `pnpm -r typecheck` passed, exit 0; `/tmp/codex-sc8-typecheck-corrected.log`. |
| Full build | `pnpm build` passed, exit 0; `/tmp/codex-sc8-build-corrected.log`. Existing Vite chunk-size warnings only. |
| Full test runner | `pnpm test:run` failed, exit 1, at CLI: unchanged doctor repair test expected warned=0 but got1; two worktree embedded-Postgres initialization failures. It passed UI1442 and earlier projects, including OpenCode and MCP204. Cloud/server were not reached. `/tmp/codex-sc8-test-run-corrected.log`. |
| CLI failure isolation | Worktree35 passed on isolated rerun (`/tmp/codex-sc8-cli-worktree-retry.log`); unchanged doctor failed again (`/tmp/codex-sc8-cli-doctor-retry.log`). CLI test/implementation files match the base. No full base checkout was executed and no unrelated CLI repair was made. |
| Complete cloud coverage | Full cloud run:20 suites/265 tests passed,2 suite setup failures/19 skipped because embedded Postgres initialization failed before assertions (`/tmp/codex-sc8-cloud-full-corrected.log`). Focused retry of admin-guard+DB passed19/19 (`/tmp/codex-sc8-cloud-setup-retry.log`), covering all284 cloud tests across these runs. |
| Actual box billing family | Family run76 passed, one old exact Checkout payload assertion failed, one existing test skipped (`/tmp/codex-sc8-box-family-final.log`). Updated only that expected payload for the intended new session company metadata; focused Checkout15 passed (`/tmp/codex-sc8-checkout-contract-final.log`). Other family tests include actual trial lifecycle7, composed cloud→box8, metadata3, entitlement19, billing service11, webhook integration1, reconciliation3 and secret6. |
| Independent review | Frozen runtime source review found no remaining actionable findings; reviewer independently reran correction31 and signature/fanout13. Only the subsequent expected Checkout assertion/comment changed, with runtime source still frozen. |
| Diff/static boundary | `git diff --check` passed. No dependencies, main checkout, voice/UI/websocket or launch-gate source changed. |

The implementation is locally reviewable; **the full test runner gate is not green**. No commit, PR, merge, deployment, endpoint registration, provider email, fleet key operation, local3199 mutation, claim/provision/edge activation or live acceptance proof occurred. Notifications retain existing best-effort delivery semantics after commit; this does not add a durable notification outbox. A future PR should explain the internal billing-only new service with the applicable `[no-prompt-update]` CI bypass; no agent-facing behavior contract changed.

## Final frozen file set

- `cloud/src/__tests__/cloud-billing-admin.test.ts`
- `cloud/src/__tests__/cloud-billing-credentials.test.ts`
- `cloud/src/__tests__/cloud-billing-integration.test.ts`
- `cloud/src/__tests__/cloud-billing.test.ts`
- `cloud/src/__tests__/db.test.ts`
- `cloud/src/admin/cli.ts`
- `cloud/src/admin/run.ts`
- `cloud/src/app.ts`
- `cloud/src/billing/admin.ts`
- `cloud/src/billing/credentials.ts`
- `cloud/src/billing/resend.ts`
- `cloud/src/billing/stripe.ts`
- `cloud/src/billing/webhook.ts`
- `cloud/src/config.ts`
- `cloud/src/db/migrations/0009_cloud_billing.sql`
- `cloud/src/db/migrations/meta/0009_snapshot.json`
- `cloud/src/db/migrations/meta/_journal.json`
- `cloud/src/db/schema.ts`
- `cloud/src/index.ts`
- `cloud/src/jobs/alerts.ts`
- `cloud/src/jobs/cleanup.ts`
- `cloud/src/railway/provisioner.ts`
- `cloud/src/routes/internal.ts`
- `doc/plans/2026-09-29-cloud-billing-sc8.md`
- `doc/runbooks/cloud-control-plane.md`
- `server/src/__tests__/billing-checkout-routes.test.ts`
- `server/src/__tests__/billing-trial-lifecycle.test.ts`
- `server/src/__tests__/cloud-billing-box-retry.test.ts`
- `server/src/__tests__/cloud-billing-metadata.test.ts`
- `server/src/routes/billing.ts`
- `server/src/services/billing-webhook-processing.ts`
- `server/src/services/billing.ts`
- `server/src/services/entitlement-sync.ts`
- `server/src/services/stripe-webhook-ledger.ts`
