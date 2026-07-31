# AgentDash-MK API

Endpoints available only in companies whose `productProfile` is `agentdash_mk`.
Off-profile they return **404**, not 403 — a non-profile company is
indistinguishable from one that does not exist.

Server authorization is authoritative everywhere below. UI gating and sidebar
visibility are presentation only.

## Stewardship

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/companies/:companyId/me/agent` | Any board user (own record only) |
| `GET` | `/api/companies/:companyId/agents/:agentId/stewardship` | Company member |
| `GET` | `/api/companies/:companyId/agents/:agentId/stewardship/history` | Company member |
| `POST` | `/api/companies/:companyId/agent-stewardships` | `agents:create` |
| `POST` | `/api/companies/:companyId/agents/:agentId/stewardship/transfer` | `agents:create` |

One active stewardship per human per company and one per agent, enforced by
partial unique indexes. Transfer is atomic: the old row is ended and the new one
inserted in a single transaction, and `transferReason` is **required** — the
row is the audit trail for why decision authority moved.

Ending a stewardship (transfer or member archival) also revokes that human's
channel bindings.

## Governance

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/companies/:companyId/agents/:agentId/governance` | Steward or admin |
| `PUT` | `/api/companies/:companyId/agents/:agentId/governance/ceiling` | `agents:create` |
| `PUT` | `/api/companies/:companyId/agents/:agentId/governance/request` | Steward or admin |

Effective authority is `owner ceiling ∩ steward request`. Both mutations carry
the `revision` last read; a stale value returns **409**
`AGENT_POLICY_REVISION_CONFLICT`. A steward request outside the ceiling returns
**422** `AGENT_POLICY_CEILING_EXCEEDED` with a `details.violations` array.

Lowering a ceiling clamps standing configuration in the same transaction and
revokes permission grants the ceiling no longer allows. It also revokes any
active human channel binding whose provider the ceiling no longer permits — a
ceiling that gated only *new* bindings would keep delivering this agent's
approval cards over the channel the owner just disallowed.

### Runtime enforcement of each ceiling dimension

| Dimension | Enforced at | On refusal |
|---|---|---|
| `permissions` | agent config and permission routes | **422** `AGENT_POLICY_CEILING_EXCEEDED` |
| `monthlyBudgetCents` | agent config, both budget routes, incident resolution | **422** `AGENT_POLICY_CEILING_EXCEEDED` |
| `providers` | `resolveActingAs`, channel binding | `provider_not_allowed`, **403** on binding |
| `dataScopes` | `resolveActingAs` | `data_scope_not_allowed` |
| `minimumApproval` | approval decision authority | **403**, or admin-decidable at `none` |
| `destructiveActions` | computed and stored; no runtime consumer yet | — |

The provider check runs **before** connection lookup, so a disallowed provider
answers "the ceiling does not allow this" rather than "no connection available"
— the latter reads as an invitation to set one up, and discloses connection
inventory for a provider the caller may not touch.

`dataScopes` filters rather than rejects: when several connections exist for a
provider, over-scoped ones are skipped and a compliant one is used. Only when
every candidate exceeds the ceiling is `data_scope_not_allowed` returned. A
connection with no recorded scopes is treated as within any ceiling, because
scope recording postdates most rows and failing them closed would turn
narrowing `dataScopes` into an outage for every legacy connection.

`minimumApproval` is the one dimension where the ceiling is a **floor**, so the
effective value is the *stricter* of ceiling and steward request. Lowering it to
`none` therefore takes both an owner and the steward. At `none`, administrators
may decide that agent's approvals on the ordinary path instead of writing an
emergency override; the relaxation is bounded to people who could already
override and adds no new class of decider.

Every dimension is inert outside `agentdash_mk`, and the default ceiling is
unrestricted on `permissions`, `providers`, `dataScopes`, and the budget — so
enabling the profile never removes authority by itself.

## Personal inbox

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/companies/:companyId/me/inbox` | Any board user (session-scoped) |
| `GET` | `/api/companies/:companyId/inbox/override` | `agents:create` |

There is deliberately no `userId` parameter — identity comes from the session.
The personal inbox returns the stewarded agent's approvals **plus** the user's
own work. Override items are marked `requiresOverride: true` and are decidable
only through the reasoned override action.

`GET /me/inbox` accepts `?status=open` (default) or `?status=all`. Any other
value is a **400**, not a silent fallback, so a client typo cannot quietly
narrow what a user sees. `all` includes resolved approvals for the Inbox tabs
that render decided work; it widens the *status* filter only — the identity
scope is unchanged, and a test asserts that.

The web Inbox scopes every tab to this response in a profile company, and the
sidebar badge reads the same set, so the badge and the tab it opens always
agree. The company-wide view lives on the Override screen.

## Approvals

| Method | Path | Who |
|---|---|---|
| `POST` | `/api/approvals/:id/approve` | Current steward of the requesting agent |
| `POST` | `/api/approvals/:id/reject` | Current steward of the requesting agent |
| `POST` | `/api/approvals/:id/override` | `agents:create`, reason required |

In `agentdash_mk`, decisions require `revision`, `idempotencyKey`, and
`channel` (`web` | `telegram` | `teams`). Default-profile companies keep the
pre-existing contract and may omit all three.

Replaying an idempotency key returns the original terminal result with no side
effects. Reusing one across approvals returns **409**
`APPROVAL_IDEMPOTENCY_KEY_CONFLICT`. `resubmit` advances the revision and
invalidates outstanding cards.

Deciding a `hire_agent` approval requires `agents:create` in every profile —
approving one creates an agent.

## HubSpot (per-user BYO key)

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/companies/:companyId/me/connections/hubspot` | Own key health |
| `POST` | `/api/companies/:companyId/me/connections/hubspot` | Own key, session identity |
| `POST` | `/api/companies/:companyId/me/connections/hubspot/rotate` | Own key |
| `POST` | `/api/companies/:companyId/me/connections/hubspot/recheck` | Own key |
| `POST` | `/api/companies/:companyId/me/connections/hubspot/revoke` | Own key or admin |
| `GET` | `/api/companies/:companyId/hubspot/:objectType` | **Agent key only** |
| `POST` | `/api/companies/:companyId/hubspot/:objectType/write` | **Agent key only** — files a request |

`objectType` is `contacts`, `companies`, or `deals`; anything else is a 400
rather than a pass-through to HubSpot.

Native rather than routed through the local-agent bridge, because only this path
makes the owner ceiling an *enforcement* mechanism: every read resolves through
`resolveActingAs`, where `providers` and `dataScopes` refuse it. A ceiling over a
bridge task constrains what may be **asked**, not what the machine **could** do.

**Validate before persist.** Connecting makes two calls: token introspection for
the portal and scopes, then a live CRM read. A token that introspects cleanly and
403s on every read would otherwise be stored as healthy and fail later inside an
agent run, far from the cure.

**Visibility is hard-forced `private`** and never read from input. A
workspace-visible connection is usable by every agent in the company through
`resolveActingAs`, which would turn one person's personal key into a shared
company credential.

**One active key per person per company**, enforced by a partial unique index
(migration `0104`), so the DB decides the race rather than a check-then-insert.
Two active keys is an ambiguity, not a richer setup: `resolveActingAs` picks the
newest and the older keeps working, so "revoke my key" would revoke one of them.

`recheck` reports **scopes lost** since the key was stored. A super admin can
narrow a private app's scopes at any time and nothing tells us; without this the
first symptom is a failing agent run.

Repeated `401`/`403` marks the connection `error`, which removes it from
`resolveActingAs` entirely — so the next read makes no request at all. That is
the durable breaker; the in-process counter only covers the window before that
write lands.

All free-text CRM properties are **framed, not sanitized**, before reaching an
agent: CRM notes are attacker-writable for inbound leads, and stripping
"instruction-looking" text would mangle legitimate notes while missing novel
phrasings. Non-string properties are left alone.

### Writes

An agent never writes. It files a request; the steward decides; the server
executes with the connection owner's credential. The write route returns **202**
with an approval id and `status: "pending_steward_approval"` — never a write
result. An agent that receives that has not changed the CRM.

The request becomes a `connector_send` approval carrying the target, the
properties, and a **sha256 digest of the properties**, so what executes can be
proven to be what was decided.

Everything is re-resolved at **execution** time, not request time: stewardship,
the owner ceiling through `resolveActingAs`, the connection's status, and that
the resolved connection is still the one that was approved. Authority checked
when a request is filed is stale by the time a human presses approve — a ceiling
narrowed in between must block the write, and does.

`approvals.expiresAt` has its first consumer here: a connector_send expires
after 24 hours. A CRM write approved a week late is acting on a world that has
moved.

Outcomes are recorded in `connector_send_executions`, one row per approval,
enforced by a unique index:

| Outcome | When |
|---|---|
| `succeeded` | provider returned 2xx |
| `failed` | 4xx, or a refusal before any call was made (expired, ceiling, revoked connection) |
| `outcome_unknown` | 5xx or transport failure — the write **may** have landed |

`outcome_unknown` is **never retried**. The row is claimed *before* the provider
call and already carries `outcome_unknown`, so a crash mid-flight leaves exactly
the truth. For a CRM of record a duplicate contact is worse than a missing one,
and only a human can tell which happened.

The execution row carries ids, counts, and the digest — never the written
properties. Those live on the approval, which has redaction on every read path;
copying them here would put CRM data in a second store with different access
rules.

Narrowing an owner ceiling **cancels pending connector_send approvals** for that
agent in the same transaction as the ceiling write. Already-decided approvals are
untouched — cancelling those would rewrite history, and the execution record is
where "was it honoured" lives.

**Known limit:** a HubSpot private-app token is portal-scoped and created by a
super admin, so writes attribute to *the app*, not to the person whose key it is.
AgentDash records who requested and who approved every write; HubSpot does not.
The product owner accepted this on 2026-07-30 and it is stated in the UI rather
than hidden. A public OAuth app is the fix and is not built here.

## Local agent bridge

A human enrolls their own machine — typically a local Claude — as an endpoint
that does work for AgentDash agents.

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/companies/:companyId/me/bridge/endpoints` | Own endpoints |
| `POST` | `/api/companies/:companyId/me/bridge/endpoints` | Request enrollment (inert) |
| `POST` | `/api/companies/:companyId/bridge/endpoints/:id/approve` | Owner or admin — mints the token |
| `POST` | `/api/companies/:companyId/bridge/endpoints/:id/revoke` | Owner or admin |
| `POST` | `/api/companies/:companyId/bridge/tasks` | **Agent key only** — file a task |
| `GET` | `/api/companies/:companyId/bridge/tasks` | **Agent key only** — read outcomes |
| `POST` | `/api/bridge/poll` | **Endpoint token only** |
| `POST` | `/api/bridge/result` | **Endpoint token only** |
| `POST` | `/api/bridge/decline` | **Endpoint token only** |

### What the ceiling does and does not do here

**The owner ceiling constrains what may be *asked* of an endpoint, not what the
endpoint *could* do.** A local Claude has its host machine's full reach — its
filesystem, its shells, its logged-in sessions — and nothing on this server can
bound that. This is inherent to running code on a computer we do not control and
is not fixable by more validation.

It is exactly why HubSpot was built as a native connector instead of as bridge
tasks: there every call resolves through `resolveActingAs`, where the ceiling is
a real gate that refuses. Here it is a request, not a gate.

The controls that **do** bind on this path: enrollment, the route allowlist,
approval-gating of act-class tasks, and audit.

### Enrollment

Two steps on purpose. `POST /me/bridge/endpoints` records the request and mints
**nothing** — `enrolled_at` stays null and the stored hash is a placeholder that
matches no token. Only `/approve` produces a credential, and the plaintext
appears in that one response and nowhere else. A machine cannot become someone's
endpoint by asserting that it is.

Declared capabilities (`bridge:read`, `bridge:act`) are validated at enrollment;
an endpoint that declares something outside the vocabulary is refused rather
than stored as an unknown.

### The route allowlist

A `bridge_endpoint` credential reaches **only** `/api/bridge/poll`,
`/api/bridge/result`, and `/api/bridge/decline`. The allowlist lives in
`middleware/auth.ts` beside where the actor is minted, not in the router — a
check far from the credential it governs is one that gets forgotten when someone
adds a route. On any other path the token is not even looked up, so the request
is indistinguishable from an unauthenticated one.

The actor is also minted with `type: "none"`, so every ordinary authorization
helper (which branches on `type`) refuses it by construction. Only the bridge's
own explicit `source === "bridge_endpoint"` check accepts it.

### Task delivery

Pull-only: the server never connects to a laptop, so no inbound port is needed.
The claim is a conditional `UPDATE` keyed on the row still being `queued`, so two
pollers racing cannot both receive the same task. Each claim issues a single-use
result token scoped to that endpoint.

`act` tasks are created `awaiting_approval` with a linked approval and are
invisible to polling until a steward approves through the ordinary approvals
service. Approve, reject, and **override** all drive the task — an overridden
approval that left its task stranded would be a silent hang.

### Lease lapse

Deliberately asymmetric. A lapsed `read` re-queues **once** — re-reading is
harmless, unbounded retries against a wedged endpoint are not. A lapsed `act`
terminates as `outcome_unknown` and **never** re-queues: the endpoint may have
completed the side effect before going quiet, and a duplicated side effect is
worse than a missing one. Same reasoning as connector sends.

### Results

Framed as `<untrusted-bridge-result>` on the way **in**, so nothing downstream
can read one raw by forgetting to frame it on the way out. Ending a stewardship
(transfer or archival) revokes that person's endpoints in the same transaction
as their channel bindings.

### Deferred

`/bridge/poll` is a plain poll, not a held long-poll — a client polls on an
interval. Bridge decisions are web-only in P0; the approval is an ordinary one,
so it reaches Telegram and WhatsApp cards, but no bridge-specific channel
affordance exists.

## Channels

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/companies/:companyId/me/channels` | Own bindings |
| `POST` | `/api/companies/:companyId/me/channels/telegram/pairing` | Own pairing, session identity |
| `POST` | `/api/companies/:companyId/me/channels/whatsapp/pairing` | Own pairing, session identity |
| `POST` | `/api/companies/:companyId/me/channels` | Own binding, session identity (**not** Telegram) |
| `POST` | `/api/companies/:companyId/channel-bindings/:id/revoke` | Bound user or admin |
| `GET` | `/api/companies/:companyId/channel-bindings` | `agents:create` |
| `POST` | `/api/connectors/telegram/webhook` | Telegram (secret header) |
| `GET` | `/api/connectors/whatsapp/webhook` | Meta (subscription handshake) |
| `POST` | `/api/connectors/whatsapp/webhook` | Meta (`X-Hub-Signature-256`) |
| `POST` | `/api/connectors/teams/messages` | Teams (validated activity) |

One provider identity binds to at most one active human per company, and each
human holds at most one active binding per provider. Rebinding requires an
explicit revocation.

Inbound events are deduplicated on `(provider, company_id, external_event_id)`
via a unique index. `external_channel_events` stores a payload **digest**, never
the payload.

### Pairing ceremony

`channel_pairing_challenges` holds short-lived single-use tokens and is
provider-generic, so WhatsApp and Teams reuse one implementation of the expiry,
replay, and replacement rules rather than growing three that drift.

Minting replaces any outstanding challenge for the same (company, provider,
human): a user who abandons a pairing must not leave a second live token
behind, because the first already travelled through a channel someone else may
have seen. The response carries a **deep link only** — the raw token is never
returned, so it cannot be logged or copied separately from the link the user is
meant to open.

`POST /me/channels` now **rejects `telegram` and `whatsapp` with 400**. That
route accepts a self-asserted external id and never proved the caller controls
it, so before the ceremonies existed a member could bind a colleague's account
to their own agent. Providers with no ceremony yet still use it.

Requires `TELEGRAM_BOT_USERNAME` (and `WHATSAPP_BUSINESS_NUMBER` for WhatsApp).
When unset the mint returns **503** and spends no token, rather than handing
back a `t.me/undefined?start=…` link that looks like it works.

### Telegram

Webhook authenticity is the `X-Telegram-Bot-Api-Secret-Token` header, checked
before parsing. `update_id` is the dedup anchor. Inline keyboard
`callback_data` carries an opaque 18-byte handle — never the approval id — and
callback queries are always answered, including on replay. Refusals return 200
with an explanatory answer, because a non-2xx makes Telegram retry forever.

Approval cards are **pushed** when an approval is created and again on every
resubmit, to the current steward's verified, unrevoked bindings and to nobody
else. Delivery never throws — it is a side effect of creating an approval, and a
provider outage must not fail the request that created it. A provider with no
delivery implementation is logged as *not delivered* rather than counted as
delivered, so a paired steward's silence is always attributable.

Telegram is **bidirectional**. A paired human's message is answered as their
agent, against durable conversation history keyed to the binding (not the human
or the agent — re-pairing produces a new binding and must not inherit the old
transcript). The reply is a `dispatchLLM` call, not a summon of the agent's own
runtime: an agent run is minutes long and a chat reply is seconds, so routing
chat through the run queue would make the channel feel broken. Escalating a
message into real agent work is a wakeup and is not implemented yet.

Two fail-closed guards on the message path. `is_bot` messages are dropped
before dispatch, because two bots in one chat answer each other until a rate
limit intervenes. Non-private chats get no reply and cannot complete a pairing:
a binding authenticates one human, not a room, so answering in a group would
disclose that human's agent's replies to everyone present.

A `/start <token>` deep link arrives before any binding exists, so it resolves
its company from the challenge instead. The order is **peek → claim → consume**:
consuming before claiming would let a Telegram redelivery find the token already
spent and tell the user their pairing failed, for a pairing that succeeded.

### WhatsApp

Authenticity is `X-Hub-Signature-256`, an HMAC-SHA256 over the **raw request
bytes**, checked before parsing or dispatch. Verifying against
`JSON.stringify(req.body)` instead would reject every authentic request:
whitespace survives the wire and does not survive a parse/serialize round trip.
`GET` answers Meta's one-time subscription handshake with `hub.challenge`.

`wamid` is the dedup anchor, claimed **per message**. One POST may carry several
messages, and each is claimed and dispatched on its own — treating the payload
as a single unit would let a duplicate suppress a distinct sibling beside it.

Pairing uses a `wa.me/<business>?text=<token>` link that prefills a message the
user sends **from their own handset**. That inbound message is the proof of
control. No surface anywhere accepts a phone number a human typed: numbers are
guessable in a way a Telegram user id is not, and a mis-paired binding leaks
both the content of approvals and the authority to decide them. The pairing
message also opens the messaging window, so the first approval card after
pairing is deliverable.

Approval cards are interactive reply buttons carrying the same opaque handles
Telegram uses. **Outside the 24-hour messaging window** a business may send only
a Meta-reviewed template, which this build does not assume an operator has
provisioned — so an out-of-window card is reported as *not delivered* and
logged, never downgraded to a text message Meta would reject. An undelivered
card must stay distinguishable from a steward who has not answered.

### Teams

**Inbound authentication is not wired.** `@microsoft/teams.apps` keeps Bot
Framework validation inside its `App`/`HttpPlugin` pipeline and exports no
standalone validator; until that pipeline is wired the endpoint rejects every
activity. Cards use `Action.Execute` (never legacy `Action.Submit`) and carry
an opaque handle. Everything downstream of validation — tenant, identity,
binding, revision, dedup — is implemented and fails closed.

## Delegation

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/issues/:id/child-contributions` | Company member |

Returns each child's complete comments, documents, and work products with
author provenance, plus `contributingAgentIds` and a `complete` flag. The
parent wake payload carries references and per-child counts only.

## Environment

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot API token for outbound calls |
| `TELEGRAM_WEBHOOK_SECRET` | Value required in `X-Telegram-Bot-Api-Secret-Token` |
| `TELEGRAM_BOT_USERNAME` | Bot handle used to build the `t.me/<bot>?start=` pairing link |
| `WHATSAPP_APP_SECRET` | Meta app secret; HMAC key for `X-Hub-Signature-256` |
| `WHATSAPP_VERIFY_TOKEN` | Value Meta echoes in the subscription handshake |
| `WHATSAPP_ACCESS_TOKEN` | Graph API token for outbound calls |
| `WHATSAPP_PHONE_NUMBER_ID` | Graph API phone-number id used to send |
| `WHATSAPP_BUSINESS_NUMBER` | Public number used to build the `wa.me` pairing link |
| `TEAMS_APP_ID` | Entra app (client) id |
| `TEAMS_APP_PASSWORD` | Entra client secret |

## Not in scope

No first-party Salesforce, Jira, SharePoint, or Google Drive integrations are
added by this work.

WhatsApp, HubSpot, and the local computer-agent bridge were excluded by the
original design and brought into scope by the
[2026-07-30 scope override](../superpowers/specs/2026-07-30-agentdash-mk-scope-override.md).
All three are implemented above. Microsoft Teams remains deprioritized by the
same decision.
