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

The local Codex/Claude computer-agent bridge is not implemented yet. No
first-party Salesforce, Jira, SharePoint, or Google Drive integrations are added
by this work.

WhatsApp and HubSpot were excluded by the original design and brought into scope
by the [2026-07-30 scope override](../superpowers/specs/2026-07-30-agentdash-mk-scope-override.md).
WhatsApp is implemented above; HubSpot is not yet.
