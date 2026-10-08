# Hosted Invitation Beta Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent backend and UI tasks; root integrates and verifies before deployment. Track steps with checkboxes.

**Goal:** Keep the public hosted waitlist open while a single-use invitation approves one email-verified customer's instance.

**Architecture:** Extend cloud-owned invitation records with an explicit hosted purpose and durable consumption bound to an account and box. Signup stores an invitation ID until email verification; atomic verification creates one box and a recoverable approved waitlist entitlement. Existing verified customers redeem through their cookie session. The existing provision queue retains its kill switch and daily cap.

**Tech Stack:** TypeScript, Express, Drizzle/Postgres, React, Vitest. No new dependencies.

**Spec:** Founder request “lets up it up, waitlist + invitation code”; reviewed design in `.omc/qa/2026-10-08-hosted-invite-beta/design-review.md` in the parent checkout.

## Global Constraints

- Hosted codes are single-use and purpose-separated from reusable self-hosted codes.
- Require verified email; never consume at signup or store raw codes in the database, logs, URL or audit.
- Preserve all rate limits, account restrictions, one-live-box constraints, kill switch, claim readiness, spend alarms and daily cap.
- Persist approved admission before delivery; an interruption must leave recovery possible.
- Use only the authorized hosted cloud project. No HQ restart, protected ports, provider calls, MKThink contact, bulk waitlist approval or fleet upgrade.
- No secrets in tool output or reports. Review, required CI and matching-head merge precede production deployment.
- Invitation admission changes human onboarding only, with no new worker prompt behavior.

## Task 1: Purpose-separated hosted admission (backend owner)

**Files:** `cloud/src/db/schema.ts`, generated `cloud/src/db/migrations/**`, `cloud/src/invites.ts`, `cloud/src/front-door/service.ts`, `cloud/src/jobs/queue.ts`, `cloud/src/routes/public.ts`, `cloud/src/routes/internal.ts`, `cloud/src/admin/run.ts`, `cloud/src/index.ts`, cloud tests.

**Interfaces:** Signup accepts optional `invitationCode?: string`. Public config adds `invitationCodesEnabled: true`. Authenticated `POST /api/cloud/invitation/redeem` accepts `{code:string}` and returns `{ok:true, provisioning:"queued"|"waitlisted"|"already_started", reason?:string|null}`; ordinary errors retain `{error,code}`. Never accept client account/box IDs or approval booleans. Admin `invites add-hosted <label>` issues a hosted one-use code; existing invite commands remain self-hosted. Metadata list includes purpose and consumption without raw code/hash.

- [x] Run existing cloud invitation/front-door tests as baseline in a short, synthetic test HOME.
- [x] Add failing regressions for no-code waitlist, verified hosted admission, purpose isolation, revocation/expiry/used-code rejection, resend, concurrent redemption, idempotency, existing waitlisted redemption, and cap/kill-switch deferral/recovery.
- [x] Add purpose default `self_hosted`, hosted consumption fields and signup FK through a generated additive cloud migration; legacy rows retain reusable semantics.
- [x] Validate bounded invitation input under rate limits; persist only the invitation ID at signup. Lock and consume the email token and invitation inside the successful verification transaction, with account/box binding and an approved waitlist entry. Refused verification rolls back the token and entitlement.
- [x] Reuse this approval primitive for session-bound existing waitlisted redemption; reject strangers, blocked accounts and other-account consumption, while same-account retries are idempotent.
- [x] Queue with `approved:true` after durable approval. Promote preexisting waiting rows when approval is deferred; never bypass kill switch/cap. Ensure release sweep recovers interruption after approval.
- [x] Add explicit hosted issuance without changing self-hosted validation/import. Tests capture synthetic code values only, never real secrets.
- [x] Run focused suites, cloud typecheck/build and self-review; report commands, outcomes and remaining limits. Do not commit until root integrates task files.

## Task 2: Waitlist and invitation UX (UI owner)

**Files:** `ui/src/marketing/cloud/api.ts`, `ui/src/marketing/pages/Start.tsx`, `StartProgress.tsx`, `Start.css`, `ui/src/marketing/cloud/front-door.test.ts`, scoped browser interaction tests if the existing harness supports them.

**Interfaces:** Use Task 1 request/response names. Optional signup field is `invitationCode`; redemption is `cloudApi.redeemInvitation(code)`. Feature-detect `invitationCodesEnabled` so a new frontend remains compatible with an old backend during deployment.

- [x] Add meaningful failing submission/redemption tests in the existing harness.
- [x] Show an optional invitation field when enabled; clearly state no-code signup joins the waitlist and a code grants admission after email verification, subject to available capacity.
- [x] Send supplied code only in JSON request bodies; no query strings, storage or analytics. Keep normal email/name/slug/terms behavior.
- [x] Allow a verified waitlisted customer to redeem on progress page. Show server errors accessibly; prevent duplicate submits, clear code on success and refresh status. Approved copy must promise notification when capacity is available, not immediate delivery.
- [x] Run focused UI tests/typecheck and capture before/after at an owned ephemeral port. Preserve design and Paperclip credit; no customer-specific copy.

## Task 3: Integration, ops and release (root owner)

**Files:** cloud runbook, this plan and QA provenance. PR uses all sections of `.github/PULL_REQUEST_TEMPLATE.md`.

- [ ] Verify current cloud project access, release, proxy trust and safe internal readiness metadata before changes. Identify migration/runtime services explicitly; do not use default CLI project targets.
- [x] Document hosted single-use issuance, revocation, email verification, existing waitlist redemption and approved-capacity deferral. Keep live codes out of reports.
- [ ] Obtain independent spec/security review, correct findings and re-review changed scope.
- [ ] Run appropriate combined typecheck/tests/build; retain evidence and explicitly label any environmental test failures. Run required hosted checks at the exact PR head.
- [ ] Prepare PR and preview; merge only the reviewed, green exact head. Deploy additive migration before cloud runtime, then compatible frontend. Keep rollback/provenance.
- [ ] Verify public no-code waitlist and invalid-code gates, then an owned invited signup/email/provision/claim canary when target access permits. Do not claim customer-ready before observing delivery. Enable only bounded invitation admission, keeping waitlist and capacity gates.
- [ ] Report live URL, shipped SHA, tested flow and any concrete deployment/access blocker. No raw codes or account secrets.

## Source validation and visual evidence

Baseline: 49 cloud front-door/invitation tests passed before edits. Backend: 157 focused tests, cloud typecheck/build and generated migration/role checks passed. UI: 77 marketing tests and typecheck passed; independent focused interactions 26/26 passed after the config retry correction. Hosted runtime delivery is separate and awaits project access.

| State | Before | After |
|---|---|---|
| Signup | [Before](assets/2026-10-08-hosted-invitation-beta/start-before.png) | [Invitation field](assets/2026-10-08-hosted-invitation-beta/start-after.png) |
| Verified waitlist | [Before](assets/2026-10-08-hosted-invitation-beta/progress-before.png) | [Redemption](assets/2026-10-08-hosted-invitation-beta/progress-after.png) |

[Mobile signup](assets/2026-10-08-hosted-invitation-beta/start-mobile.png) has zero horizontal overflow at 390px. These captures use a synthetic local API and do not prove hosted provisioning.
