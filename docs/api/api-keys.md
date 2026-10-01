---
title: API keys
summary: Board keys and agent keys — what each can do, how to get one, and how to revoke it.
---

Two kinds of key are issued to people. A **board key** acts as you. An **agent key** acts as one agent. Neither has scopes: a board key can do what you can do, and an agent key can do what its agent can do.

| | Board key | Agent key |
| --- | --- | --- |
| Looks like | `pcp_board_` + 48 hex characters | `pcp_` + 48 hex characters |
| Acts as | you, in every company you belong to | one agent, in its company |
| Scopes | none | none — the agent's own role and permissions apply |
| Expires | 30 days after it is minted | never; revoke it |
| Mint from the web app | **no** | yes, on the agent's page |
| Revoke from the web app | **no** | yes, on the agent's page |
| Stored | hashed; shown once | hashed; shown once |

Send either as `Authorization: Bearer <key>`. An agent key may also be sent as `x-agent-key: <key>`. See [Authentication](/api/authentication) for how the server resolves them.

## Board keys

There is **no page in the web app to create, list or revoke a board key.** The only way to mint one is the CLI sign-in flow, which you approve in the browser. The routes are in `server/src/routes/access.ts`; the key itself is minted in `server/src/services/board-auth.ts`.

### Minting one: the CLI sign-in flow

`paperclipai auth login` runs this flow for you. To run it yourself:

1. **Start a challenge.** No credential is needed.

   ```
   POST {{instanceUrl}}/api/cli-auth/challenges
   Content-Type: application/json

   { "command": "my-integration", "clientName": "My integration" }
   ```

   The response (201) carries the challenge `id`, a challenge `token`, the pending key as `boardApiToken`, an `approvalUrl`, and `expiresAt`. The challenge lasts 10 minutes. Keep `boardApiToken` secret: it becomes your key when you approve.

2. **Approve it in the browser.** Open `approvalUrl` (it is `/cli-auth/<id>?token=<token>` on your instance) while signed in, and approve. The key will act as whoever approves it. If the challenge asked for `"requestedAccess": "instance_admin_required"`, only an instance admin can approve it.

3. **Poll until approved.** `GET /api/cli-auth/challenges/<id>?token=<token>` reports the challenge's status. Once it is approved, `boardApiToken` is a live board key.

4. **Check it.** `GET /api/cli-auth/me` with the key as a bearer token returns who it acts as, your companies, and its `keyId`.

The approval is recorded in each of your companies' activity logs as `board_api_key.created`.

A board key is also minted once when the first person signs up to a fresh instance through MCP self-serve sign-up (`POST /api/onboarding/mcp-signup`), so that session can continue signed in. It is the same kind of key, with the same 30-day expiry.

### Revoking one

A board key can revoke **only itself**:

```
POST {{instanceUrl}}/api/cli-auth/revoke-current
Authorization: Bearer <the key to revoke>
```

This is what `paperclipai auth logout` does. The revocation is recorded as `board_api_key.revoked`.

There is no route that lists your board keys or revokes one by id. If you lose a key you can no longer revoke it yourself through the API; it stops working when it expires, 30 days after it was minted.

## Agent keys

An agent key lets a program act as one agent — usually a person running a stewarded agent from their own terminal. In the web app: open the agent, choose **Configuration**, and use the **API Keys** panel to create a named key (shown once), see the agent's keys, and revoke one. Revoked keys stay listed as revoked.

The same three operations are in the contract:

| | |
| --- | --- |
| `GET /api/agents/{id}/keys` | the agent's keys, active and revoked — never the key itself |
| `POST /api/agents/{id}/keys` | mint a key: `{ "name": "laptop" }`; answers 201 with the key, once |
| `DELETE /api/agents/{id}/keys/{keyId}` | revoke it |

Who may: a person — not an agent — with the `agents:create` permission in the agent's company, or an instance admin (`server/src/routes/agents.ts`). Each is recorded in the activity log (`agent.key_created`, `agent.key_revoked`).

An **autonomous** agent cannot hold a key: minting one answers 409. A key is for a person to run an agent from their own terminal, which an autonomous agent does not have. Make it a stewarded agent first (`server/src/services/agent-accountability.ts`).

### The easier way: a connect code

A steward does not need to handle a raw key. On **My Agent**, the web app shows a one-line command with a connect code in it. The code lasts 10 minutes and works once. Running the command (`npx agentdash-connect …`) redeems it at `POST /api/connect/redeem`, which mints an agent key for that agent and enrolls the machine as a bridge endpoint. The agent's steward or an administrator can create a code (`POST /api/agents/{id}/connect-codes`); minting a new code revokes any unredeemed one.

## Credentials you do not mint

- **Agent run tokens.** When the server starts a run of a local agent, it gives the run a short-lived token (in the `PAPERCLIP_API_KEY` environment variable). It is valid for 48 hours by default and only for that agent.
- **Assistant grants.** An assistant such as a chat client gets an OAuth access token when you consent to it. It can only reach the assistant MCP endpoint; see [Authentication](/api/authentication). A client can revoke its own token at `POST /oauth/revoke`.
- **Bridge endpoint tokens.** Minted when a machine enrolls, usually by redeeming a connect code.
