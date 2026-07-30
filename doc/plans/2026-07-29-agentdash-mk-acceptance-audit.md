# AgentDash-MK Acceptance Audit

**Date:** 2026-07-29
**Branch:** `codex/agentdash-mk`
**Design:** [`docs/superpowers/specs/2026-07-28-agentdash-mk-design.md`](../../docs/superpowers/specs/2026-07-28-agentdash-mk-design.md) §17

Every criterion from the design, with the evidence that supports it. A missing
live provider credential is a **verification gap**, not an implicit pass, and is
recorded as such.

**Verdict: 9 of 14 met, 4 partial, 1 not met. AgentDash-MK is NOT complete.**

**Scope note (2026-07-30):** the product owner deprioritized Microsoft Teams and
brought WhatsApp, HubSpot, and the local computer-agent bridge into scope. See
[`2026-07-30-agentdash-mk-scope-override.md`](../../docs/superpowers/specs/2026-07-30-agentdash-mk-scope-override.md).
Criterion 10 is now **deprioritized, not abandoned**; criterion 13 is restated
there. The remaining criteria are unaffected.

## Repository verification

| Command | Result |
|---|---|
| `pnpm -r typecheck` | exit 0 |
| `pnpm test:run` | 3894 passed, 0 failed |
| `pnpm build` | exit 0 (all packages) |
| `pnpm --filter @paperclipai/db run check:migrations` | exit 0 |
| `pnpm exec playwright test --config tests/e2e/playwright-agentdash-mk.config.ts` | 1 passed against a live `local_trusted` server |

Migrations `0096`–`0101`, each additive and correctly chained.
`pnpm-lock.yaml` is intentionally uncommitted; CI owns it. The
`@microsoft/teams.apps` dependency in `server/package.json` therefore needs a CI
lockfile update before any build that installs from the lockfile alone.

## Criteria

### 1. Profile enables without changing non-profile behavior — **MET**

`companies.product_profile` defaults to `default` (migration `0096`). Every
profile gate no-ops off-profile: `agentGovernanceService.isProfileCompany`,
`approvalAuthorityService.requireDecisionAuthority` (short-circuits at
`approval-authority.ts`), and the connector/cost guards.

Evidence: `agentdash-mk-profile.test.ts`; `agent-governance.test.ts` "skips
ceiling enforcement for default-profile companies" and "leaves default-profile
authority unchanged"; `agentdash-mk-approval-authority.test.ts` "keeps existing
board approval behavior for default-profile companies".

**Caveat:** `589f6f55` deliberately narrows authority in *all* profiles
(hire-approval decisions, host workspace commands, company connector autonomy,
mandated actions). That is an intentional platform hardening, not a profile
effect, but it does change default-profile behavior and is called out here so
it is not discovered in review.

### 2. Constraints enforce one active stewardship both directions — **MET**

Partial unique indexes `agent_stewardships_active_user_uq` and
`agent_stewardships_active_agent_uq`, both `WHERE ended_at IS NULL`
(migration `0097`).

Evidence: `agent-stewardships.test.ts` "enforces one active stewardship per
company user and per company agent" and the concurrent-transfer test.

### 3. Transfer atomic, history retained — **MET**

`agentStewardshipService.transfer` ends the old row and inserts the new one in
one transaction under an advisory lock, emitting exactly one
`agent.stewardship_transferred`.

Evidence: `agent-stewardships.test.ts` "transfers atomically, preserves history,
and records reason and actor"; "member archival ends active stewardship while
preserving the agent".

### 4. Stewards manage only their assigned agents — **MET**

`resolveConfigurationAuthority` resolves per target agent and never widens.
`STEWARD_PATCHABLE_AGENT_FIELDS` restricts the patch surface; `role`,
`adapterConfig`, `runtimeConfig`, `spentMonthlyCents`, `status`, `reportsTo`
are admin-only, as are configuration rollback, instructions *location*, and
granting `agents:create`.

Evidence: `agent-governance.test.ts` — "does not let stewardship widen into
company-wide agent administration", "refuses to let a steward promote their
agent to a privileged role", "refuses steward writes to host-executed workspace
commands", "refuses a steward granting their own agent agent-creation
authority", "refuses steward changes to where instructions are stored".

This criterion failed three consecutive reviews before these controls existed.

### 5. Ceilings reject every specified class of over-broad configuration — **PARTIAL**

Enforced: `permissions` and `monthlyBudgetCents`, at every write path
(`PATCH /agents/:id`, `PATCH /agents/:id/permissions`, both `costs.ts` budget
routes, and budget-incident resolution), including the `hardStopEnabled` /
`isActive` / `amount: 0` evasions.

**Not enforced: `providers` and `dataScopes`.** `assertAgentMutationWithinCeiling`
is never called with either. `destructiveActions` and `minimumApproval` are
computed and stored but have no runtime consumer. Design §6.3 explicitly
requires provider selection to be ceiling-bound; there is no agent-scoped
provider selection surface today, so the dimension is inert rather than
bypassable — but the criterion says *every* class.

### 6. Accepted and rejected changes retain actor and revision provenance — **MET**

`applyUpdate` audits accepted changes inside the transaction and rejected ones
on the base connection, so a rollback cannot take the audit with it.
`assertAgentMutationWithinCeiling` audits denials too.

Evidence: `agent-governance.test.ts` — "durably audits a rejected steward
request without persisting the rejected policy", "rejects a stale revision with
409 and audits the conflict", "audits a ceiling rejection raised from the agent
configuration routes".

### 7. Steward-only approvals; override explicit, reasoned, audited — **MET**

`requireDecisionAuthority` grants ordinary decisions to the current steward of
the requesting agent only — an owner who is not the steward is refused and must
use `POST /approvals/:id/override`, which demands a reason at both schema and
service layers and audits under its own `approval.emergency_override` action.

Evidence: `agentdash-mk-approval-authority.test.ts` — 17 tests including "denies
an owner the ordinary decision path", "requires a reason for an emergency
override", "fails closed when a replayed key arrives after the stewardship
moved on".

### 8. Web Inbox authenticated-user scoped and server-backed — **PARTIAL**

`GET /api/companies/:companyId/me/inbox` derives identity from the session with
no `userId` parameter, and returns the stewarded agent's work plus the user's
own. The Inbox `mine` tab consumes it via `restrictApprovalsToServerScope`.

**But `all`, `recent`, and `unread` still render the unscoped company approval
list.** Aggregation moved for one tab, not for the Inbox. Payloads are redacted
on that route so this is metadata exposure, not credential exposure, and the
server refuses the resulting decisions — but the criterion is not met.

Also open: the sidebar badge counts unscoped approvals and can disagree with the
tab.

### 9. Telegram: pairing, bidirectional conversation, approvals, dedup, revocation — **PARTIAL**

Delivered: webhook secret verified before parsing, `update_id` deduplication
via unique index, native approve/reject through the shared decision boundary,
opaque ≤64-byte callback tokens, callbacks always answered, immediate
revocation.

**Not delivered:**
- **No pairing ceremony.** Bindings are created through the authenticated route.
  Identity is genuinely session-derived, but there is no signed, short-lived
  deep-link challenge as §10 describes.
- **Not bidirectional.** An inbound message from a paired user is logged and
  dropped — `handleUpdate` never dispatches to the agent and never replies.
  Telegram is approve/reject only.

Evidence: `telegram-connector.test.ts` (9 tests).

### 10. Teams equivalent with supported bot/app and Adaptive Cards — **NOT MET (deprioritized 2026-07-30)**

Owner decision: Teams is low priority and yields to the other criteria and to
WhatsApp/HubSpot/bridge. No code is removed and no test is skipped — the gap
below stands as written and stays visible in the E2E spec. This criterion is
parked, not waived.

`@microsoft/teams.apps` ^2.0.14 is a dependency, cards use `Action.Execute`
(a test asserts no `Action.Submit` anywhere), and the decision path enforces
tenant, identity, binding, revision, and dedup — all failing closed.

**Inbound Bot Framework token validation is not wired.** The SDK exports no
standalone validator; validation lives inside its `App`/`HttpPlugin` pipeline,
which is not connected. `defaultVerifyActivity` rejects every request, so **no
real Teams activity can reach the decision path** — the flow is exercised only
through an injected test validator. Proactive outbound delivery, the app
manifest, and pairing are also absent.

Per the handoff's own rule, Teams cannot be presented as complete while Telegram
itself is partial (§9).

### 11. CEO-to-three-stakeholders with agent-authenticated execution — **MET**

Two specs, both passing against a live `local_trusted` server.

`tests/e2e/agentdash-mk-workforce.spec.ts` covers the governance scenario as a
board actor: four agents, ceilings, a refused over-broad request, three
delegated children, a web decision, replay, and consolidation with full
artifacts.

`tests/e2e/agentdash-mk-agent-auth.spec.ts` covers the agent-authenticated half.
Every agent gets its own API key and `APIRequestContext`, and the CEO agent
delegates, each stakeholder agent writes its own contribution, the Product agent
requests a governed action, and the CEO agent consolidates — all under
`x-agent-key`, none as the board.

The trap this closes: in `local_trusted` an unrecognized agent key does not
fail. `agentAuth` calls `next()` and the actor falls back to the implicit local
board, an instance admin. A spec that sent the header and asserted 200 would
pass with the key misspelled or revoked. So `agentContext()` refuses to return a
context until `GET /api/agents/me` returns that exact agent id, and a garbage
key is asserted to 401 there.

Negative coverage, pinned to exact refusals rather than `>= 400` ranges:
Marketing's key on Engineering's issue → `403 Agent cannot mutate another
agent's issue`; an agent deciding its own approval → `403`, with a follow-up
read asserting the approval is still `pending` so a refusal that wrote anyway
cannot pass.

### 12. Final result links every contribution and reconstructs the audit chain — **PARTIAL**

`GET /api/issues/:id/child-contributions` returns complete comments, documents,
and work products with author provenance, plus `contributingAgentIds` and a
`complete` flag. The wake payload carries counts and references only, asserted
by a test that neither the comment nor the document body appears in it.

**Nothing forces a parent agent to actually cite what it fetched.** That is
agent behavior; the prompt block instructs it, but the system does not enforce
it, so "the final result links every required contribution" is a documented
expectation rather than a guarantee.

### 13. Every P0 surface agrees with the current scope decision — **MET**

Restated 2026-07-30. The original criterion asserted *absence* of the bridge and
the excluded integrations; the owner's scope override makes absence the wrong
test. What matters is that no surface promises a capability that does not exist
and none omits one that does.

Today: no Codex/Claude computer-agent bridge, no HubSpot, and no WhatsApp code
exists, and `docs/api/agentdash-mk.md` plus the prompt-drift test in
`agent-instruction-bundles.test.ts` both say so. Consistent.

Salesforce, Jira, SharePoint, and Google Drive remain excluded — that half of
the original criterion is unchanged.

As each in-scope integration lands, its PR must move the API doc, the four
prompt surfaces, and (for the bridge) invert the drift test in the same commit.
The debt table lives in §6 of the scope-override addendum.

### 14. Tests, typecheck, suite, build, browser suites pass — **MET**

See the verification table above. Live Telegram and Teams sandbox runs have
**not** been performed and remain verification gaps.

## Open work

1. **Teams inbound validation** — wire `App`/`ExpressAdapter` (blocks §10).
   *Deprioritized 2026-07-30 by owner decision; unchanged in substance, parked
   until Teams is re-prioritized. Reuses the pairing-challenge table from item 2
   when it resumes.*
2. **Telegram pairing challenge and bidirectional conversation** (blocks §9).
3. **Inbox `all`/`recent`/`unread` scoping** and the sidebar badge (blocks §8).
4. **`providers` / `dataScopes` ceiling enforcement** (blocks §5).
5. ~~**Agent-authenticated E2E** (blocks §11).~~ Closed 2026-07-30 by
   `tests/e2e/agentdash-mk-agent-auth.spec.ts`.
6. CLI and MCP approval clients omit decision metadata and will 400 in a profile
   company.
7. No steward-request editor in the UI, so ceiling violation messages are
   unreachable; `AgentCeilingEditor` has no test and exposes 4 of 7 dimensions.
8. `HumanChannelBindings` settings component (Task 6 file list) not built.
9. Pre-existing platform gaps left open by choice: routines gated on
   `tasks:assign` (which operators hold), and caller-supplied `agentId` on issue
   checkout and cost-events.
10. **Newly in scope 2026-07-30**, sequenced after the blockers above: WhatsApp
    connector, HubSpot native BYO-key connector (read, then steward-approved
    writes), and the local computer-agent bridge. These are additions beyond the
    fourteen criteria, not gaps in them; see the scope-override addendum.
