# T5 — Destructive-action classifier & enforcement (design of record)

**Date:** 2026-08-04
**Supersedes** the "DESIGN REQUIRED" placeholder for T5 in
`doc/plans/2026-08-04-steward-surfaces-and-operational-gaps.md`.
**Product confirmation (owner, 2026-08-04):** "come up with the list for me; present it at
onboarding so they can add anything; default profile — I don't care."

## The principle (unchanged from the harness plan §F / T5)

An action is **destructive** when it is one of: cannot be undone by a compensating write;
reaches a party outside the company irreversibly; commits money; or executes outside
AgentDash's control (the bridge). **Unclassifiable write ⇒ treated as destructive (fail
closed)** — same posture as slice E's E3.

The owner ceiling already carries ONE `destructiveActions` mode
(`blocked | approval_required | allowed`, default `approval_required`;
`packages/shared/src/types/agent-governance.ts`). This slice does not add a mode — it defines
**which actions that mode applies to** (the classifier), then binds the mode at action time.

## The default destructive-action class list

The classifier keys off what the authorization chokepoint already knows: the connector
provider and the operation. Each class below is derivable from `(provider, operation)` or from
the bridge task class.

| Class | What it is | Why destructive | Example in AgentDash |
|---|---|---|---|
| `external_record_delete` | Delete or archive a record in an external system of record | Not recoverable by a compensating write | HubSpot delete a contact/deal/company |
| `external_record_merge` | Merge / dedupe records | Lossy; the pre-merge state cannot be reconstructed | HubSpot merge two companies |
| `external_bulk_mutation` | One action that writes many external records at once | Blast radius; a mistake multiplies | Bulk-update a HubSpot list |
| `outbound_external_message` | Send a message/email to a recipient **outside** the company | Cannot be unsent; reaches a real external person | WhatsApp/email to a lead or customer |
| `financial_action` | Move money or commit spend | Real-world irreversible effect | Send an invoice, issue a refund, change a plan |
| `access_grant_or_revoke` | Change who can access external data or systems | Widens/narrows a trust boundary silently | Add a SharePoint share; add a portal user |
| `external_publish` | Make content externally/publicly visible | Cannot be reliably un-published | Publish a doc, create a public share link |
| `local_machine_mutation` | A bridge task that changes state on a human's machine | The ceiling cannot bound what the machine does — asking is the only control | Bridge task that writes/deletes files or runs a state-changing command |
| `credential_or_connection_change` | Create / rotate / revoke a connection, key, or secret | Can lock out or expose access | Revoke a HubSpot BYO key |

Plus the catch-all, not shown as a togglable row but always in force:

- `unclassified_write` — any write-class action not matching a **known-safe** read/query class
  ⇒ treated as destructive. Reads are never destructive; everything unknown fails closed.

Deliberately **not** destructive (documented so the classifier is a closed allowlist, not a
guess): reads/queries/fetches of any provider; internal messages to the steward or an internal
teammate; drafting an artifact that is not yet sent/published; creating a record that is
trivially deletable *within* AgentDash's own store.

## Onboarding presentation

At `agentdash_mk` company creation (the onboarding flow), show the owner this default list with
each class's one-line "why", and let them **add** classes. Framed as: *"These agent actions
require your approval by default. Add anything else your business treats as sensitive."*

Persistence fork (this is the one real design decision):
- **The default list is a shared code constant** — no persistence needed to ship enforcement.
- **Owner-added custom classes need persistence.** The governance policy has no free-form
  column, so storing additions is a schema change → a migration. Per the standing no-migration
  guardrail, that half needs explicit approval.

Therefore T5 ships in two steps:
- **T5a (no migration, autonomous):** the classifier constant + the action-time enforcement +
  onboarding **display** of the default list (read-only). This is the safety-critical part and
  the thing the harness plan says must exist before the ceiling can bind anything.
- **T5b (needs a migration → explicit go-ahead):** the owner-**add** capability, persisting
  custom classes on the governance policy and rendering them in the ceiling editor.

## Enforcement (T5a)

- **One chokepoint**, not per-connector: the point where connector sends and bridge tasks are
  authorized (the same chokepoints slice E used — `bridgeService.createTask` and the
  connector-send apply path in `approvals`). Classify the action; read the effective
  `destructiveActions` mode from the resolved ceiling; then:
  - `blocked` ⇒ refuse with a named-ceiling error (the same error shape T2/T3 render).
  - `approval_required` ⇒ raise through `approvalService` (the only decision boundary).
  - `allowed` ⇒ proceed.
  - In every branch emit a `workflow_events` row (`actorKind` per the actor; **no** user-subject
    column — B3).
- **Fail closed:** an action the classifier cannot place ⇒ `unclassified_write` ⇒ treated as
  `approval_required` at minimum (never silently allowed).

## Default-profile decision

Owner is indifferent, so the safe choice: **enforcement is gated to `agentdash_mk`**, exactly
like the rest of the governance surface. Default-profile installs are unaffected — no existing
self-hoster's agent suddenly starts refusing an action. (Trivial to widen later if wanted;
widening is the risky direction, so it stays opt-in.)

## Acceptance (T5a) — gates G1,G3,G4,G6

- A test per mode (`blocked` refuses, `approval_required` routes through `approvalService`,
  `allowed` proceeds), asserted at the real chokepoint (G3), each mode exercised adversarially
  (G4).
- A **fail-closed** test: an unknown action class is treated as destructive, proven by a test
  that feeds an unclassified action and asserts it is gated, not allowed.
- The classifier is a closed allowlist: reads are never gated (a test proves a read of each
  provider is `allowed` regardless of mode).
- Onboarding shows the default list (component test).
- All four prompt surfaces updated (G6): agents are told destructive actions are gated and
  which classes count — the surfaces currently only *describe* the dimension
  (`agent-creator-from-proposal.ts:245`); they must now describe its enforcement truthfully.
- No migration, no new table/column; `workflow_events` reused; profile-gated (404 off-profile).

## Must-not (return for confirmation)

- Persisting owner-added classes (T5b — needs a migration).
- Making any action refuse in **default-profile** companies.
- Any per-person / user-subject dimension in the events (B3).
- Moving the decision boundary off `approvalService`.
