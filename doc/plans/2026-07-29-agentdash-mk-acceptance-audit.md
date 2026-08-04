# AgentDash-MK Acceptance Audit

**Date:** 2026-07-29 (re-verified 2026-07-30)
**Branch:** `codex/agentdash-mk`
**Design:** [`docs/superpowers/specs/2026-07-28-agentdash-mk-design.md`](../../docs/superpowers/specs/2026-07-28-agentdash-mk-design.md) §17

Every criterion from the design, with the evidence that supports it. A missing
live provider credential is a **verification gap**, not an implicit pass, and is
recorded as such.

**Verdict: 12 of 14 met, 1 partial, 1 not met.**

**Scope note (2026-07-30):** the product owner deprioritized Microsoft Teams and
brought WhatsApp, HubSpot, and the local computer-agent bridge into scope. See
[`2026-07-30-agentdash-mk-scope-override.md`](../../docs/superpowers/specs/2026-07-30-agentdash-mk-scope-override.md).
Criterion 10 is now **deprioritized, not abandoned**; criterion 13 is restated
there. The remaining criteria are unaffected.

## Repository verification

| Command | Result |
|---|---|
| `pnpm -r typecheck` | exit 0 |
| `pnpm test:run` | 4040 passed, 0 failed |
| `pnpm build` | exit 0 (all packages) |
| `pnpm --filter @paperclipai/db run check:migrations` | exit 0 |
| `pnpm exec playwright test --config tests/e2e/playwright-agentdash-mk.config.ts` | 2 passed against a live `local_trusted` server |

Migrations `0096`–`0105`, each additive and correctly chained. WhatsApp
added no table: it reuses `channel_pairing_challenges`, `channel_callback_tokens`,
and `external_channel_events`, which is the point of having made them
provider-generic.
`pnpm-lock.yaml` is tracked; CI owns it. [Superseded 2026-08-03: previously uncommitted — the lockfile is now tracked and the refresh-lockfile bot owns updates; see DEVELOPING.md.] The
`@microsoft/teams.apps` dependency in `server/package.json` therefore needs a CI
lockfile update before any build that installs from the lockfile alone.

### Known flake

`zk-permission-mandated-action.test.ts` — "flag ON: generates a proof, binds
proof_hash into attest inputs..." intermittently fails on
`permissionProof.anchored` under full-suite load. Observed twice on 2026-07-30,
passing in isolation both times, in runs whose diffs touched nothing in the ZK
path. Load-dependent, pre-existing, and not caused by this branch — recorded so
it is recognized rather than re-diagnosed. `run-vitest-stable.mjs` bails the
remaining packages when the server package fails, so a single flake also
depresses the reported total.

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

### 5. Ceilings reject every specified class of over-broad configuration — **MET**

`permissions` and `monthlyBudgetCents` are enforced at every write path
(`PATCH /agents/:id`, `PATCH /agents/:id/permissions`, both `costs.ts` budget
routes, and budget-incident resolution), including the `hardStopEnabled` /
`isActive` / `amount: 0` evasions.

`providers` and `dataScopes` gained runtime consumers on 2026-07-30. Provider
selection is refused in `connectorService.resolveActingAs` with
`provider_not_allowed` **before** connection lookup, and in
`humanChannelService.verifyBinding` with a 403. Data scopes filter the candidate
connections and return `data_scope_not_allowed` only when every one exceeds the
ceiling. Narrowing `providers` revokes standing channel bindings inside the same
transaction as the ceiling write.

`minimumApproval` is consumed by `approvalAuthorityService.requireDecisionActor`:
at the default `steward` the steward-only rule is unchanged; at `none` an
administrator may decide on the ordinary path.

**Still without a runtime consumer: `destructiveActions`.** It is computed,
stored, clamped, and rejected on write, but nothing reads it at action time —
there is no destructive-action classification in the codebase to hang it on.
Recorded here rather than claimed: the dimension is inert, not bypassable.

Evidence: `agentdash-mk-provider-ceiling.test.ts` (17 tests), including
default-profile no-op guards, the unrestricted-default guard, "prefers a
within-ceiling connection over refusing outright", "treats a connection with no
recorded scopes as within any ceiling", and "does not open the ordinary path to
non-administrators".

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

**One deliberate relaxation (2026-07-30):** when the *effective*
`minimumApproval` is `none`, an administrator may decide on the ordinary path
instead of writing an override. Because that dimension's ceiling is a floor and
the effective value is the stricter of the two sides, reaching `none` requires
both the owner and the steward to ask for it. Non-administrators gain nothing.
The default is unchanged and its test above still passes.

### 8. Web Inbox authenticated-user scoped and server-backed — **MET**

`GET /api/companies/:companyId/me/inbox` derives identity from the session with
no `userId` parameter, and returns the stewarded agent's work plus the user's
own. It takes `status=open` (default) or `status=all`; anything else is a 400
rather than a silent fallback to the default.

`status=all` exists because the Inbox's `recent` and `all` tabs render decided
work — scoping those against an open-only set would erase every resolved
approval instead of scoping it. Widening the status filter deliberately does not
widen the identity filter, and a test asserts that.

All four tabs now apply `restrictApprovalsToServerScope`, not just `mine`. The
sidebar badge reads the same server-owned scope from the same query key, so the
badge and the tab it opens can no longer disagree. `computeInboxBadgeData` takes
`serverScopedApprovalIds` with three states: absent (not a profile company —
every existing caller, unchanged), a `Set` (scoped), and `null` (profile scope
still loading — counts zero rather than flashing a number the tab contradicts).

Scoping `all` removes a company-wide view some people legitimately had, so the
tab carries a one-line notice, and for users the server confirms may use it, a
link to the Override screen where that view lives with matching controls.

Evidence: `agentdash-mk-inbox.test.ts` (15 tests, including "keeps status=all
scoped to the caller" and "rejects an unrecognized status filter rather than
guessing"); `ui/src/lib/inbox.test.ts` badge-scoping tests including "leaves the
count unscoped when the field is absent"; and a browser assertion in
`agentdash-mk-workforce.spec.ts`, because the scoping is wiring between a query
and a filter and unit tests cover both halves without proving they are connected.

### 9. Telegram: pairing, bidirectional conversation, approvals, dedup, revocation — **MET**

Webhook secret verified before parsing; `update_id` deduplication via unique
index; native approve/reject through the shared decision boundary; opaque
≤64-byte callback tokens; callbacks always answered; immediate revocation.

**Pairing ceremony** (added 2026-07-30). `channel_pairing_challenges`
(migration `0102`) holds short-lived single-use tokens and is provider-generic,
so WhatsApp and Teams reuse one implementation rather than growing three.
`POST /me/channels/telegram/pairing` mints a `t.me/<bot>?start=TOKEN` deep link
for the authenticated caller — the body is not read, so nobody can mint a link
that binds their account to someone else's agent. Redemption arrives at the
webhook as `/start TOKEN` and runs **peek → claim → consume**: consuming before
claiming would let a Telegram redelivery find the token spent and report a
failed pairing for one that succeeded.

`POST /me/channels` now rejects `provider: "telegram"` with 400. It accepted a
self-asserted external id and never proved the caller controlled it, so before
the ceremony a member could bind a colleague's Telegram account to their own
agent. Providers with no ceremony keep that route.

**Bidirectional** (added 2026-07-30). `steward-agent-replier.ts` answers a
paired human's message as their agent, against durable conversation history
keyed to the *binding* — re-pairing produces a new binding and must not inherit
the old transcript. The reply is a `dispatchLLM` call rather than a summon of
the agent's runtime; that choice and its limit are recorded in the file and in
the prompt surfaces, not left implicit.

Two fail-closed guards: `is_bot` messages are dropped before dispatch, and
non-private chats get no reply and cannot complete a pairing — a binding
authenticates one human, not a room.

Evidence: `telegram-connector.test.ts` (19 tests, up from 9) including
"consumes a pairing token exactly once", "does not double-bind when telegram
redelivers the same pairing update", "refuses to pair from a group chat", and
"does not answer a message from a bot"; `channel-pairing-routes.test.ts` (8
tests) including "mints for the authenticated caller and nobody else" and "no
longer accepts a self-asserted telegram identity on the generic bind route";
`MyAgent.test.tsx` (9 tests) including "never mints one until asked".

**Outbound delivery** (added 2026-07-30, after a false MET claim the same day).
`buildApprovalKeyboard` had existed, minted correct tokens, and been tested —
with no caller outside those tests. Nothing pushed a card when an approval was
created, so a steward never received a button to press. The tests asserted that
a card *decides* correctly and never that a card *arrives*.

`approval-card-delivery.ts` closes it, wired into approval creation and
resubmit. Verified bindings only — an unverified binding names an identity
nobody proved control of. The current steward only, because anyone else gets a
button the server refuses. It never throws: delivery is a side effect of
creating an approval, so a provider outage must not fail the request that
created it. Resubmit re-delivers, since advancing the revision kills every card
already sent. Providers with no delivery implementation are logged as *not
delivered* rather than counted as delivered.

Evidence: `approval-card-delivery.test.ts` (10 tests) including "does not
deliver to an unverified binding", "never lets a delivery failure escape to the
caller", and — the one that would have caught the original gap — "delivers when
an approval is created through the API, not only when the service is called".

**Verification gap, unchanged:** no live Telegram sandbox run has been
performed. The Bot API is exercised through a local double.

### 10. Teams equivalent with supported bot/app and Adaptive Cards — **NOT MET (accepted direction, not scheduled)**

Owner decision 2026-07-30: deprioritized. Revisited 2026-07-31: the owner
accepted publishing to the Teams Store *eventually*, which settles the approach
without scheduling the work. This criterion stands as written — Teams parity,
not a renegotiated notifier. It is parked, not waived, and no test is skipped.

**The blocker recorded here until 2026-07-31 was wrong.** It stated that the SDK
exports no standalone validator. `ServiceTokenValidator` does exist, standalone,
issuer-pinned and `serviceUrl`-bound; it is simply not re-exported from the
package root. The real blocker is that Microsoft deprecated multi-tenant bot
creation after 2025-07-31 and this project holds nothing grandfathered, so
cross-tenant reach requires AppSource publication.

Sequenced plan, pre-engineering verifications, and the endorsement-validation
sign-off requirement: [`2026-07-31-teams-store-path.md`](2026-07-31-teams-store-path.md).

`@microsoft/teams.apps` ^2.0.14 is a dependency, cards use `Action.Execute`
(a test asserts no `Action.Submit` anywhere), and the decision path enforces
tenant, identity, binding, revision, and dedup — all failing closed.

**Inbound Bot Framework token validation is not wired.**
`defaultVerifyActivity` rejects every request, so **no real Teams activity can
reach the decision path** — the flow is exercised only through an injected test
validator.

*Corrected 2026-07-31:* this previously said the SDK "exports no standalone
validator". It does export one — `ServiceTokenValidator` at
`@microsoft/teams.apps/dist/middleware/`, standalone, issuer-pinned,
`serviceUrl`-bound — just not from the package root. The real blocker is that
Microsoft deprecated multi-tenant bot creation after 2025-07-31 and this project
has no grandfathered registration, so cross-tenant reach appears to need
AppSource publication. Recorded because the wrong premise had propagated to
three places and would have mis-scoped the work. Proactive outbound delivery, the app
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
the excluded integrations; the owner's scope override made absence the wrong
test. What matters is that no surface promises a capability that does not exist
and none omits one that does.

Every item the override brought into scope has now landed, and the surfaces moved
with it in the same commits: WhatsApp, HubSpot reads, HubSpot steward-approved
writes, and the local agent bridge each updated `docs/api/agentdash-mk.md` and
all four prompt surfaces alongside their code.

The scope debt named in §6 of the addendum is **paid in full**:

- `docs/api/agentdash-mk.md` "Not in scope" no longer lists WhatsApp, HubSpot, or
  the bridge; each has a reference section instead.
- `agent-instruction-bundles.test.ts` — the assertion "does not promise the
  deferred local computer-agent bridge" is **inverted**. It now requires every
  surface to describe the bridge, its act-class approval rule, its untrusted
  results, and — the part that matters most — that the ceiling cannot bound what
  an enrolled machine is able to do.
- Salesforce, Jira, SharePoint, and Google Drive remain excluded, unchanged.
- Microsoft Teams remains deprioritized, and criterion 10 still records the
  unwired inbound validation rather than hiding it.

### 14. Tests, typecheck, suite, build, browser suites pass — **MET**

See the verification table above. Live Telegram and Teams sandbox runs have
**not** been performed and remain verification gaps.

## Open work

1. **Teams inbound validation** — wire `App`/`ExpressAdapter` (blocks §10).
   *Deprioritized 2026-07-30 by owner decision; unchanged in substance, parked
   until Teams is re-prioritized. Reuses the pairing-challenge table from item 2
   when it resumes.*
2. ~~**Telegram pairing challenge and bidirectional conversation** (blocks §9).~~
   Closed 2026-07-30, including outbound approval-card delivery, which was
   missing entirely and briefly claimed complete before being caught.
3. ~~**Inbox `all`/`recent`/`unread` scoping** and the sidebar badge (blocks §8).~~
   Closed 2026-07-30.
4. ~~**`providers` / `dataScopes` ceiling enforcement** (blocks §5).~~ Closed
   2026-07-30. `destructiveActions` still has no runtime consumer — tracked as
   item 11 rather than left implied.
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
10. **Newly in scope 2026-07-30**, sequenced after the blockers above.
    ~~WhatsApp connector~~, ~~HubSpot native BYO-key reads~~ and ~~HubSpot
    steward-approved writes~~ shipped 2026-07-30. Still outstanding: the local
    computer-agent bridge. These are additions beyond the fourteen criteria, not
    gaps in them; see the scope-override addendum.
13. **HubSpot writes attribute to the app, not the person.** A private-app
    token is portal-scoped and created by a super admin, so a write made with
    one member's key is indistinguishable in HubSpot from any other. The product
    owner accepted this on 2026-07-30 and writes shipped on that basis; the
    caveat is stated in the UI rather than hidden. AgentDash records who
    requested and who approved every write, HubSpot does not. A public OAuth app
    remains the real fix.
14. **`outcome_unknown` has no operator surface.** An ambiguous write is
    recorded and never retried, which is correct, but nothing yet lists these
    for a human to reconcile against the CRM. Until that exists the record is
    discoverable only by query.
12. **WhatsApp out-of-window delivery.** Outside the 24-hour messaging window an
    approval card is reported undelivered rather than sent, because a
    Meta-reviewed utility template is an operator provisioning step this build
    does not assume. Someone has to decide whether to provision one and accept
    per-conversation billing on that path.
11. **`destructiveActions` runtime consumer.** The dimension is rejected on
    configuration write and clamped on narrowing, but no action-time check reads
    it, because nothing in the codebase classifies an action as destructive yet.
    That classification has to exist before the ceiling can bind anything.
15. **The bridge has no push and no long-poll.** `/bridge/poll` returns
    immediately; a client polls on an interval, and a closed laptop receives
    nothing. An agent that files a task learns the outcome only by polling
    `GET /bridge/tasks`. Nothing wakes it — the same gap connector sends have.
16. **Lapsed leases are swept only when `sweepLapsedLeases` is called**, and
    nothing schedules it. Until it is on a timer or a heartbeat, a claimed task
    on a machine that went quiet stays `claimed` indefinitely rather than
    expiring.
17. ~~**`revokeBindingsForEndedStewardship` in `human-channels.ts` is dead
    code.**~~ Closed 2026-07-30, and it was more than a duplicate. The dead
    helper logged one `human_channel.binding_revoked` row per revoked binding;
    the inline version that actually runs logged only
    `agent.stewardship_ended`. So the audit trail answered "the stewardship
    ended" but never "this Telegram binding and this enrolled laptop stopped
    being able to act, and why" — recoverable only by joining a `revoked_at`
    timestamp against a stewardship row and hoping they matched.

    Deleting the dead code would have cemented that gap. Both inline sites now
    audit per revoked binding and per revoked endpoint, in the same transaction
    as the revocation, and the helper is removed.
