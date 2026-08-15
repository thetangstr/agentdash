# @agentdash/connect

Connect the coding agent on your machine — Claude Code or Codex — to your
AgentDash agent.

```sh
npx @agentdash/connect
```

It asks for two things, a link and a key, and does the rest.

## What it actually does

1. Finds which harnesses are installed (`claude`, `codex`).
2. **Checks the link and key work before touching anything.** A wrong key, a
   typo'd host and an instance that is down are three different messages, and
   you get them before any file is written.
3. Writes each harness's own native MCP config.
4. Prints every file it changed.

```
Connecting this machine to an AgentDash agent.
Found: Claude Code, Codex

Instance link (e.g. http://mkmini.local:3103): …
Agent key (input hidden): …

Checking http://mkmini.local:3103/api/mcp …
Connected. 72 tools available, agent briefing received.

Wrote:
  claude  ~/.claude.json
          stores the key in this file (mode 600)
  codex   ~/.codex/config.toml
          reads AGENTDASH_KEY_AGENTDASH at runtime; key stored in the keychain
```

## Why this instead of a prompt to paste

A prompt is a suggestion — editable, truncatable, and silent when it fails.
This is a config write with an exit code, and `--remove` puts everything back.

Nothing runs in the background. No daemon, no menu-bar app, no directories to
create, nothing to keep alive. It is a short script that edits two config files
you can read, and it is entirely reversible. That is a change your IT department
can review in a minute.

## Where the key goes

Being precise about this, because it differs by harness and it is the part worth
understanding:

| | where the key lives |
|---|---|
| **Codex** | the OS keychain. `config.toml` holds only the *name* of an environment variable, never the secret. One line in your shell profile reads it back at login. |
| **Claude Code** | `~/.claude.json`, in plaintext, at mode 600. This is how Claude Code stores HTTP MCP credentials; we cannot change it, so we say so rather than imply otherwise. |

The key is read from the terminal with echo off — never from a command-line
argument — so it stays out of your shell history and out of the process list.
If no keychain is available (common over SSH or on a fresh login), it falls back
to `~/.agentdash/<name>.key` at mode 600 and tells you it did.

## Commands

```sh
npx @agentdash/connect                  # interactive
npx @agentdash/connect --url <url>      # skip the URL question
npx @agentdash/connect --check          # is the connection still good?
npx @agentdash/connect --remove         # undo everything it wrote
npx @agentdash/connect --name <name>    # use a different MCP server name
```

`--check` exits non-zero when the connection is broken, so it works in a
monitoring script. Piping the key on stdin works too, for scripted installs:

```sh
printf '%s\n' "$KEY" | npx @agentdash/connect --url https://your-instance
```

## Requirements

Node 18 or newer, and at least one of Claude Code or Codex already installed.
This wires up what is already on the machine; it does not install a harness for
you.

Zero runtime dependencies.
