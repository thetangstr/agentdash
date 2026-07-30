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
The personal inbox returns the stewarded agent's open approvals **plus** the
user's own work. Override items are marked `requiresOverride: true` and are
decidable only through the reasoned override action.

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
| `POST` | `/api/companies/:companyId/me/channels` | Own binding, session identity |
| `POST` | `/api/companies/:companyId/channel-bindings/:id/revoke` | Bound user or admin |
| `GET` | `/api/companies/:companyId/channel-bindings` | `agents:create` |
| `POST` | `/api/connectors/telegram/webhook` | Telegram (secret header) |
| `POST` | `/api/connectors/teams/messages` | Teams (validated activity) |

One provider identity binds to at most one active human per company, and each
human holds at most one active binding per provider. Rebinding requires an
explicit revocation.

Inbound events are deduplicated on `(provider, company_id, external_event_id)`
via a unique index. `external_channel_events` stores a payload **digest**, never
the payload.

### Telegram

Webhook authenticity is the `X-Telegram-Bot-Api-Secret-Token` header, checked
before parsing. `update_id` is the dedup anchor. Inline keyboard
`callback_data` carries an opaque 18-byte handle — never the approval id — and
callback queries are always answered, including on replay. Refusals return 200
with an explanatory answer, because a non-2xx makes Telegram retry forever.

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
| `TEAMS_APP_ID` | Entra app (client) id |
| `TEAMS_APP_PASSWORD` | Entra client secret |

## Not in scope

The local Codex/Claude computer-agent bridge is **P2** and not implemented. No
first-party Salesforce, HubSpot, Jira, SharePoint, Google Drive, or WhatsApp
integrations are added by this work.
