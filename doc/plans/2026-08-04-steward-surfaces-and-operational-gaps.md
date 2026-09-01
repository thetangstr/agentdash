# Steward surfaces & operational gaps — implementation plan

**Date:** 2026-08-04
**Basis:** acceptance-audit open items (`doc/plans/2026-07-29-agentdash-mk-acceptance-audit.md`
§Open work) re-verified against `main` @ `cd296cf5`; API surfaces confirmed by reading the code.
**Why now:** these are the gaps a design partner (MKThink) feels in their first hour. The
harness loop runs on timers and needs no poking; what's missing is the **human-facing edge** —
pairing a channel, editing a request, seeing why a change was refused.

**The load-bearing discovery** (changes the cost of this plan): for T1 and T2 the server API
**already exists and is tested** — what's missing is UI only. Nobody should write a new route
for T1/T2 without checking this section's route citations first.

**Standing rules:** strict TDD, RED captured first; gates G1-G6 from the harness plan; the
approvals service remains the only decision boundary; profile-gated routes 404 off-profile;
default-profile behaviour unchanged; agent-facing changes touch all four prompt surfaces (G6).
Lockfile is tracked; CI owns it; never hand-edit in a PR.

---

## T1. Channel pairing & revocation UI (the missing `HumanChannelBindings` surface)

**Today:** pairing is possible only by calling routes by hand. The server side is complete in
`server/src/routes/human-channels.ts`:

- `GET  /companies/:companyId/me/channels` (:55) — my bindings
- `POST /companies/:companyId/me/channels/telegram/pairing` (:74) — mint a pairing link/code
- `POST /companies/:companyId/me/channels/whatsapp/pairing` (:110)
- `POST /companies/:companyId/me/channels/teams/pairing` (:148) — throws 503 unless
  `TEAMS_BOT_APP_ID` is set (Teams deprioritized; see S1 of the staleness sweep)
- `POST /companies/:companyId/channel-bindings/:bindingId/revoke` (:220)
- `GET  /companies/:companyId/channel-bindings` (:237) — admin list

DB truth (`packages/db/src/schema/human_channel_bindings.ts`): one active binding per
(company, provider, user), one external identity maps to at most one active human per company
AND globally per provider — the UI never needs to police this, only render the server's
refusals.

**Build:**
1. `ui/src/api/human-channels.ts` — typed client for the six routes, following the shape of
   `ui/src/api/agent-governance.ts`.
2. A `MyChannels` section on the **My Agent** page (`ui/src/pages/MyAgent.tsx`) — these are
   `/me/` routes; the steward pairs *their own* identity, so it belongs on the steward's own
   page, not company settings. Per provider: current binding status, "Pair…" action rendering
   whatever the pairing endpoint mints (deep link / code), and "Revoke". Teams renders as
   "not available" when the 503 comes back — do not hide the row; the gap stays visible.
3. Admin view: a read-only bindings table on `ui/src/pages/CompanyAccess.tsx` (it already
   hosts `StewardshipAssignments`), backed by the admin list route, with revoke for
   owner/admin.

**Acceptance criteria:**
- T1a. A steward pairs Telegram end-to-end from My Agent (component calls the real route —
  G3, no fixture that bypasses it).
- T1b. Revoke from the UI immediately flips the row to revoked; a second revoke is a no-op
  (idempotency is server-side; the UI must tolerate the repeat).
- T1c. **Adversarial (G4):** a non-admin rendering CompanyAccess cannot see or revoke other
  users' bindings; the component handles the 403 path in a test.
- T1d. WhatsApp pairing renders the out-of-24h-window caveat noted in the runbook.
- T1e. Component tests exist beside the component (house pattern: `X.test.tsx`).

**Out of scope:** any new server route; Teams enablement; notification preferences.

## T2. Steward-request editor (make ceiling violations reachable)

**Today:** `ui/src/components/agent/AgentGovernancePanel.tsx` renders effective policy vs
steward request as a **read-only table**. The mutation path exists all the way down and has no
UI caller:

- Client fn already written: `agentGovernanceApi.updateRequest` (`ui/src/api/agent-governance.ts:41`)
  → `PUT /companies/:companyId/agents/:agentId/governance/request`
  (`server/src/routes/agent-governance.ts:86`).
- The typed refusal body already exists: `AgentPolicyCeilingErrorBody`
  (`ui/src/api/agent-governance.ts:20`) — the server names the violated ceiling per field.

**Build:** an edit mode on `AgentGovernancePanel` (or a sibling `StewardRequestEditor` it
opens) that lets the **current steward** edit all six request dimensions and submit via
`updateRequest` with the current `revision`. On 409/revision-mismatch: reload and say so. On
ceiling violation: render the violated ceiling **per field, next to the field** — this error
surface is the entire point; it exists server-side and has never been seen by a human.

**Acceptance criteria:**
- T2a. Steward edits request within ceiling → effective policy updates in place.
- T2b. **Adversarial (G4):** request exceeding the ceiling on each dimension class (list
  overflow, budget, destructive-mode rank, approval-mode rank) renders the server's named
  violation next to the offending field — asserted against the real route's error body (G3),
  not a hand-built object.
- T2c. Non-steward viewing the same agent gets no edit affordance (authority resolved
  server-side by `resolveConfigurationAuthority`; UI reflects it).
- T2d. Stale `revision` handled: concurrent edit test proves no lost-update.

## T3. Finish `AgentCeilingEditor` (owner side)

**Today:** the ceiling type has **six** dimensions (`packages/shared/src/types/agent-governance.ts:30-37`:
`permissions`, `monthlyBudgetCents`, `destructiveActions`, `dataScopes`, `providers`,
`minimumApproval`). `ui/src/components/settings/AgentCeilingEditor.tsx` exposes four —
**`dataScopes` and `providers` are missing** — and it has **no test file**. (The acceptance
audit said "4 of 7"; the type says six. Trust the type.)

**Build:** add the two missing list-dimension fields (same comma-separated + `*` wildcard
convention as `permissions`, `:139-145`); write `AgentCeilingEditor.test.tsx` covering all six
dimensions, wildcard handling, and one G4 case per T2b's taxonomy submitted via
`updateCeiling`.

**Acceptance:** all six dimensions round-trip through the editor against the real routes;
`grep -c` of dimension keys in the component matches the type; test file exists and runs in
the `ui` vitest project.

## T4. `outcome_unknown` operator surface (audit item 14)

**Today:** ambiguous connector writes are recorded with status `outcome_unknown`
(`server/src/services/connector-send-execution.ts:170`, `services/bridge.ts:699,726`,
`services/hubspot-connector.ts:544,550`) and correctly never retried — but **nothing lists
them**. The only route consumer is the write path (`routes/approvals.ts:65,473`). The agent
prompt even tells agents "You cannot read these yet"
(`services/agent-creator-from-proposal.ts:206`).

**Build:**
1. `GET /companies/:companyId/connector-send-executions?status=outcome_unknown` — new route,
   owner/admin + the requesting steward; company-scoped; profile-gated (404 off-profile).
2. `POST .../connector-send-executions/:id/reconcile` recording a human verdict
   (`confirmed_delivered` | `confirmed_failed`) with actor attribution — an audit record, not
   a retry. Reconcile does NOT resend; resending stays with the approvals flow.
3. UI: a small "Needs reconciliation" list — natural home is the Inbox's attention area or
   CompanySettings; implementer's choice (decision boundary below).
4. Update the prompt-surface sentence (G6, all four): agents can now tell their steward where
   to look.

**Acceptance criteria:**
- T4a. An `outcome_unknown` row created through the real HubSpot mock path (G3) appears in
  the list; reconciling it removes it and writes the audit record.
- T4b. **Adversarial (G4):** a member of another company, and a non-steward non-admin of the
  same company, both get nothing (404/403 per house rules).
- T4c. Reconcile is idempotent and revision-bound (a stale button cannot flip a later verdict).
- T4d. `workflow_events` emits on reconcile (B's substrate; `actorKind: 'human'`, no
  user-subject column — B3 forbids per-person aggregation).

## T5. `destructiveActions` action-time consumer (audit item 11) — DESIGN REQUIRED

**Today:** the dimension is validated on configuration write and intersected on merge
(`agent-governance.ts:166-169`), defaults to `approval_required`, and **no runtime path reads
it** — because nothing classifies an action as destructive. The type's own comment says it is
"inert until Task 4 gives them a runtime consumer".

**This slice is NOT mechanical.** The classifier is the design decision:

- **Where it binds:** the single enforcement point should be where connector sends and bridge
  tasks are authorized (the same chokepoints slice E used: `bridgeService.createTask` and the
  connector-send apply path in approvals). Not scattered per-connector.
- **What is destructive:** start with an explicit allowlist-of-classes, not inference:
  external writes that cannot be undone by a compensating write (HubSpot delete/merge,
  outbound messages to external humans are NOT destructive-class by default since approval
  already gates them — decide). Unclassifiable ⇒ treat as destructive (fail closed, matches
  slice E's E3 precedent).
- **What the modes mean at runtime:** `blocked` ⇒ refuse with a named-ceiling error;
  `approval_required` ⇒ raise through `approvalService` (the only decision boundary);
  `allowed` ⇒ proceed, but emit a `workflow_events` record either way.

**Must return for product confirmation before:** any classification that makes a previously
allowed action refuse in default-profile companies (default-profile behaviour unchanged), and
the initial destructive-class list itself.

**Acceptance (once the list is confirmed):** G4 adversarial test per mode; a test proving the
classifier fails closed on an unknown action class; all four prompt surfaces updated (G6) —
they currently *describe* the dimension (`agent-creator-from-proposal.ts:245`), so they must
start describing its enforcement truthfully.

## T6. Bridge push/long-poll (audit item 15) — deliberately last

`/bridge/poll` returns immediately (`routes/bridge.ts:72` documents "a plain poll"); a closed
laptop receives nothing; task outcomes are learned only by polling. Direction when picked up:
a held long-poll (`?waitMs=` bounded ~25s) is the smallest change that fits the existing
client; SSE/websocket is more than the bridge needs now. **Do not build during the MKThink
readiness window** — the first real cycle does not depend on it (the mini's bridge client
polls on an interval while the lid is open).

---

## Sequencing and the MKThink gate

Order: **T1 → T2 → T3** (the day-one steward surfaces, all UI-only against existing APIs),
then **T4** (operator honesty), then **T5** (needs the product-confirmation loop), **T6** last.

Independent of all six, the first real cycle is still gated on three answers only MKThink can
give (harness plan §Open questions — unchanged since 2026-08-02):

1. What exactly is the weekly artifact (name, contents)?
2. Are the SharePoint worksheets structured (named tables/ranges) or ad-hoc? (decides F4
   difficulty and the fetch-vs-trigger ratio)
3. Which HubSpot objects do the facts point at?

T1-T3 can ship before those answers exist; T4 should; the cycle itself cannot.

## Decision boundaries

The implementing agent may decide without confirmation: component placement/layout details
that preserve the authority model; exact list-input UX for wildcard dimensions; the
reconciliation list's home (Inbox attention area vs settings); route/table naming for T4;
long-poll timeout bounds for T6.

Must return for confirmation: anything in T5's confirmation list; any new decision surface
outside `approvalService`; any per-person metric (B3 forbids it structurally — do not add a
user-subject column anywhere in T4's events); weakening revision binding on any decide/reconcile
action.
