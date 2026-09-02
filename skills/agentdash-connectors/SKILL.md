---
name: agentdash-connectors
description: >
  Connector autonomy, send identity and resolution order for AgentDash connectors, plus the Gmail and Slack specifics. Load this when you are asked to send through, read from, or reason about a connector — it is not in your standing mandate because most agents have no connection.
---

# Agentdash Connectors

> Moved out of the standing agent mandate on 2026-09-02. It was generated into every
> agent's `AGENTS.md` whether or not the capability existed, and this instance has no
> connections at all. The rules below are unchanged — they apply the moment the
> capability does exist, which is why they are opt-in rather than deleted.

## Connectors & connections

Connections let agents interact with external services (email, calendar, CRM, etc.) through a governed autonomy model. Each connection stores encrypted OAuth tokens and is company-scoped.

### Autonomy model

Every connection carries an `autonomy` config with three action classes: `read` (fetch/list data), `draft` (create draft content), and `send` (perform a visible external action like sending an email). Each class has an autonomy level: `full`, `draft_only`, `approve_to_send`, `blocked`, or `read_only`.

### Send identity

- `delegated` — action appears as the human connection owner
- `delegated_attributed` — action appears as the human connection owner with a "Drafted by {Agent}" footer
- `service` — action appears as the workspace service account

### Resolution order

The acting-as resolver determines effective autonomy and identity. Priority (highest first): per-agent override, per-connection setting, workspace default.

### API endpoints

- `GET /api/companies/:companyId/connections` — list connections (filter by `provider`, `status`, `ownerId`)
- `POST /api/companies/:companyId/connections` — create a connection
- `GET /api/connections/:id` — get a single connection
- `PATCH /api/connections/:id` — update settings (sendIdentity, autonomy, visibility)
- `POST /api/connections/:id/revoke` — revoke a connection (clears token)
- `GET /api/companies/:companyId/connections/resolve?agentId=&actionClass=&provider=` — resolve acting-as identity
- `GET /api/companies/:companyId/connector-defaults` — get workspace defaults
- `PUT /api/companies/:companyId/connector-defaults` — set workspace defaults
- `GET /api/companies/:companyId/agents/:agentId/connector-overrides` — get per-agent overrides
- `PUT /api/companies/:companyId/agents/:agentId/connector-overrides` — set per-agent overrides

### Usage

Before performing an external action, call the resolve endpoint. If `ok: false`, respect the block — comment on the Issue with the blocked action and the `reason` (`no_connection` or `autonomy_blocked`). Do not bypass autonomy controls.

## Gmail connector

The Gmail connector lets agents read and send email through the owner's Gmail account, governed by the autonomy model above.

### Scopes

Connections are created with one of two scope levels:
- **Read-only** (`gmail.readonly`) — search, list, and read threads in the owner's mailbox only
- **Read+Send** (`gmail.readonly` + `gmail.send` + `gmail.compose`) — read plus draft/send capability

A read-only connection blocks all send and draft attempts with HTTP 422 `GMAIL_READ_ONLY_SCOPE`.

### Autonomy enforcement for send

- `draft_only` — creates a Gmail draft in the owner's account; nothing sends until the owner approves
- `full` (autonomous) + read+send scope — sends directly as the configured identity; the action is audited
- `blocked` — the send action is rejected

### Gmail API endpoints

- `POST /api/companies/:companyId/connectors/gmail/oauth/initiate` — start OAuth flow (body: `{ redirectUri, scopes?: "read_only" | "read_send" }`)
- `POST /api/companies/:companyId/connectors/gmail/oauth/callback` — exchange auth code for tokens (body: `{ code, state, redirectUri }`)
- `GET /api/companies/:companyId/connectors/gmail/:connectionId/search?q=...` — search mailbox
- `GET /api/companies/:companyId/connectors/gmail/:connectionId/messages` — list recent inbox
- `GET /api/companies/:companyId/connectors/gmail/:connectionId/threads/:threadId` — read a thread
- `POST /api/companies/:companyId/connectors/gmail/:connectionId/drafts` — create a draft (body: `{ to, subject, body }`)
- `POST /api/companies/:companyId/connectors/gmail/:connectionId/send` — send email (body: `{ to, subject, body, agentId? }`)

### Send identity for Gmail

- `delegated` — sends from the owner's Gmail address
- `delegated_attributed` — sends from the owner's Gmail address with a "Drafted by {AgentName}" footer
- `service` — sends from a configured service alias

## Slack connector

When a workspace has a Slack connection (provider `slack`), agents can be summoned from Slack via @-mention and post results back.

### Inbound

A Slack @-mention or slash-command triggers an agent run scoped to the workspace. The Slack message becomes the conversation's first message. You do not need to poll Slack — the connector dispatches events to you.

### Outbound

To post a message to Slack, call `POST /api/connectors/slack/send` with `{ companyId, connectionId, channel, text, threadTs?, agentId }`. The connector respects autonomy controls:
- `full` — message posts immediately
- `draft_only` — returns a draft payload without posting; surface it to the board for manual send
- `approve_to_send` — creates an approval step; the board clicks Approve in Slack or the dashboard

Always reply in the originating thread (`threadTs`) when responding to an inbound mention. Never broadcast to the channel unless the task explicitly requires it.

### Revoking

When a Slack connection is revoked (`POST /api/connections/:id/revoke`), all posting and reading stops immediately. If your outbound call returns a connection-revoked error, stop retrying and comment on the Issue.
