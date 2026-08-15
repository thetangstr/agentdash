# Connecting a person's own machine to AgentDash

**Status:** proposal, not started
**Author:** drafted 2026-08-15, ahead of the MKThink Mac Mini install

## The problem, stated precisely

Today, connecting someone's Claude Code or Codex to their AgentDash agent means
handing them **a prompt to paste**. A prompt is a suggestion. It can be edited,
truncated, pasted into the wrong window, or simply not work — and when it fails
it fails as a conversation, with no exit code and nothing to inspect. The other
path we offer, the local harness bridge, asks people to make directories and
leave something running, which reads as heavy and invites an MDM conversation we
will lose in a Microsoft shop.

Neither is an *installation*. That is the actual gap. Not capability — the
capability is already there, and better than we were treating it.

## What I verified on this machine (2026-08-15)

Both harnesses already speak remote MCP with bearer auth as a first-class,
documented feature. No SDK, no daemon, no custom protocol is needed for the
connection itself.

| | verified |
|---|---|
| Claude Code 2.1.224 | `claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"`, scopes `local` / `user` / `project` |
| Claude Code plugins | full lifecycle: `plugin marketplace`, `install`, `update`, `validate`, `tag`, `details` |
| Codex CLI 0.147.0 | `codex mcp add <name> --url <url> --bearer-token-env-var <ENV_VAR>` — reads the token **from an env var, never argv** |
| `POST /api/mcp` | live, stateless, bearer = agent key; returns 401 on a bad key over `http://mkmini.local:3103` |
| `@agentdash/mcp-server` | published bin `agentdash-mcp` (stdio), config via `PAPERCLIP_API_URL` + `PAPERCLIP_API_KEY` |
| `agent_api_keys` | already carries `name`, `lastUsedAt`, `revokedAt`; `GET`/`POST`/`DELETE /agents/:id/keys` all exist |

Note Codex's `--bearer-token-env-var`: the harness authors reached the same
conclusion we did about secrets in argv. We should meet them there.

## Recommendation

Three layers. Each is independently useful, each ships on its own, and **layer 1
alone closes the gap the user is describing.** Nothing here runs in the
background on anyone's machine.

### Layer 1 — `npx @agentdash/connect` (the connector CLI) — *build first*

One command, no install, no directories, no daemon. It replaces the prompt with
a config write.

```
npx @agentdash/connect KVTX-8F2Q
```

That argument is **a connect code, not the key** — short-lived, single-use,
harmless if seen. This is the piece that makes the whole thing stable:

1. The CLI redeems the code against the instance over TLS and receives a
   **device-scoped agent key**, named for the machine's hostname
   (`CoS — titus-macbook`). This reuses the existing bootstrap-invite pattern
   (`pcp_bootstrap_<48hex>`) and the `agent_api_keys.name` column we already have.
2. It **verifies before it writes**: calls `initialize`, then shows
   *"You are connecting as CoS at MKThink. 71 tools. Continue?"* Nobody discovers
   a wrong key later, mid-task.
3. It **detects installed harnesses** (`claude`, `codex`) and writes native
   config for each one found, using the documented commands above.
4. It stores the key in the **OS keychain** (macOS Keychain / libsecret / DPAPI)
   and hands Codex the env-var name rather than the secret. The key never enters
   argv, shell history, or a plaintext dotfile.
5. It prints **exactly what it wrote and where**, and `--remove` undoes all of it
   in one command.

Why this answers the privacy and MDM concern better than a plugin or a daemon:
there is nothing resident. It is a short script that edits two config files you
can read, and it can be reversed. That is a reviewable change; a background agent
is a procurement conversation.

Scope: `--check` (re-verify an existing connection), `--remove`, `--scope user|project`,
non-interactive `--code` for scripted installs. Exit codes that mean something.

**Cost: ~1–2 days.** Depends on one new server endpoint (redeem a connect code →
mint a named key) plus a "Connect this machine" panel in the UI that displays a
code instead of a raw key.

### Layer 2 — the `agentdash` Claude Code plugin

This is where "a skill is too thin" gets its real answer. A plugin is a single
**versioned, updatable** unit that bundles what a bare MCP connection cannot:

- the MCP server config itself (so the plugin *is* the connection)
- the **mandate** surfaced as a skill, so the agent's rulebook travels with the install
- slash commands — `/agentdash:status`, `/agentdash:inbox`, `/agentdash:handoff`
- the playbook, versioned alongside the tools it describes

Distributed as a marketplace: `claude plugin marketplace add agentdash/plugins`
then `claude plugin install agentdash`. Crucially, `claude plugin update` means
we can fix a broken playbook for every user without anyone re-pasting anything —
the thing a prompt can never do.

**Cost: ~2–3 days.** Claude Code only; Codex users stay on layer 1, which is why
layer 1 ships first and stands alone.

### Layer 3 — device and key lifecycle in the UI

The primitives exist in the table; almost none of it is exposed. Today, if Titus
loses a laptop there is no story.

- list connected devices per agent: name, last used, created
- revoke one device without disturbing the others (`DELETE` route already exists)
- rotate in place — `npx @agentdash/connect --rotate` — no re-onboarding
- surface `lastUsedAt` so a dead connection is visible before someone reports it

**Cost: ~1–2 days.**

## Explicitly not building

- **A daemon or menu-bar app.** Fails the privacy test and the MDM test, and
  earns nothing the layers above don't already provide.
- **A custom wire protocol or our own SDK for the transport.** Both harnesses
  ship MCP over HTTP already. Writing our own is work we would then have to
  maintain against two moving targets.
- **A cloud relay** (`agentdash.cloud`). Still deferred, still greenfield, and
  orthogonal: layer 1 works identically against a LAN hostname or a public URL,
  because all it ever writes is whatever `publicBaseUrl` says.

## Sequencing

1. Server: connect-code endpoints (issue + redeem → named device key)
2. UI: "Connect this machine" shows a code, not a key
3. `@agentdash/connect` CLI, published to npm
4. Layer 3 device list — small, and it makes layer 1 supportable
5. Layer 2 plugin, once the connection itself is boring

For the Mac Mini install specifically, layers 1 and 3 are what matter. Layer 2 is
polish that can follow the first real week of use.

## Open question for Yang

The connect code assumes the person's laptop can reach the instance directly.
On the client's LAN that is `http://mkmini.local:3103` (now what the instance
advertises, and what the CLI would write). Off that network it needs Tailscale or
the deferred relay. Worth deciding whether "works in the office" is the promise
for the first six months, or whether remote access is day-one scope.
