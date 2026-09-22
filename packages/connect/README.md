# agentdash-connect

Connect Claude Code (or Codex) on your machine to your AgentDash agent — and to
your own AgentDash inbox, so you can ask what is waiting and approve or reject
right in the chat.

## Connect

Open your agent's **My Agent** page, press **Create a connect code**, and copy
the prompt it shows into Claude Code. That is the whole install. The prompt
runs one command, which looks like this:

```sh
npx -y agentdash-connect@latest --url https://your-instance KVTX-8F02
```

When it finishes, **restart Claude Code** — new tools load only when a session
starts — and ask:

> What's waiting on me in AgentDash?

The code works once and expires ten minutes after it is made. If it is refused,
create another; nothing was written.

Prefer a terminal? Run the command yourself — same result. Use the full name
`agentdash-connect`: a bare `npx agentdash` is an unrelated package that prints
a help screen and looks like success.

## What it sets up

Two connections, deliberately kept apart:

- **Your agent** (`agentdash` in Claude Code): the agent's own identity, for its
  work and its mandate. It can never decide an approval — an agent must not
  decide what constrains it.
- **You** (`agentdash-inbox` in Claude Code): your own inbox, acting with your
  authority. `inbox_sync` shows what is waiting; `inbox_decide` approves or
  rejects one item when you say so, and can decide only what you could decide
  on the AgentDash page.

It lists every file it writes when it finishes:

| file | what |
|---|---|
| `~/.claude.json` | both Claude Code entries; the agent key sits here at mode 600, which is how Claude Code stores HTTP MCP credentials |
| `~/.agentdash/bridge-token` | your inbox credential, mode 600 |
| `~/.agentdash/bridge-owner.json` | whose inbox this is, mode 600 |
| `~/agentdash-inbox/` | optional: start Claude Code here and your inbox appears as the session opens |
| `~/.codex/config.toml`, a shell-profile line, the OS keychain | Codex only; the key is in the keychain (or `~/.agentdash/agentdash.key` at mode 600 when none is available), never in the config |

If this machine's inbox already belongs to someone else, it keeps theirs and
tells you. To replace it, run the command in a terminal and answer yes.

Nothing runs in the background — no daemon, nothing to keep alive.

## Commands

```sh
npx agentdash-connect --check          # is the connection still good? (non-zero if not)
npx agentdash-connect --remove         # remove both Claude Code entries and the Codex setup
npx agentdash-connect inbox            # print your inbox (what the optional folder's hook runs)
npx agentdash-connect mcp              # serve your inbox tools over stdio (Claude Code launches this)
```

`--remove` leaves your inbox credential in place; delete `~/.agentdash/` and
`~/agentdash-inbox/` to remove that too.

## Requirements

Node 18 or newer, and Claude Code or Codex already installed.
