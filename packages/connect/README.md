# agentdash-connect

Connect the coding agent on your machine — Claude Code or Codex — to your
AgentDash agent.

```sh
npx -y agentdash-connect@latest --url https://your-instance KVTX-8F02
```

You rarely type this yourself. Your agent's **My Agent** page has a
**Create a connect code** button that produces this exact line with a fresh
code already in it — copy it from there and run it on the machine you work on.
It works the same in a macOS/Linux terminal and in PowerShell on Windows.

## Before you run it

- **Use the full package name, `agentdash-connect`.** `npx agentdash` resolves
  to an unrelated package on the public npm registry that is not part of this
  project. It prints a help screen and exits 0, which looks like success.
- **Keep `@latest`.** A bare package name lets npx serve whatever its cache
  holds, and a cached pre-0.2 CLI pairs the agent but silently skips the inbox
  half, with no error. `-y` skips npx's "Ok to proceed?" prompt.
- **Run it within ten minutes.** A connect code works once and expires ten
  minutes after it is created, which is also why it is safe on a command line.
  If it is refused, create a new one; nothing was written.
- **Use an address that resolves from where you are.** `.local` names usually
  do not resolve over a VPN. When the address you are browsing from differs
  from the one the instance publishes, the My Agent page offers both, yours
  first.

## What it actually does

1. Finds which harnesses are installed (`claude`, `codex`).
2. **Checks the link and credential work before touching anything.** A wrong
   code, a typo'd host and an instance that is down are three different
   messages, and you get them before any file is written.
3. Writes each harness's own native MCP config.
4. When the instance supports it (v2026.914.0 and later), sets up your inbox —
   see below.
5. Prints every file it changed.

```
Connecting this machine to an AgentDash agent.
Found: Claude Code, Codex

Redeeming code KVTX-8F02 …
Paired as Quill at Halden & Co., for this machine (laptop (darwin)).

Checking https://your-instance/api/mcp …
Connected. 72 tools available, agent briefing received.

Wrote:
  claude  ~/.claude.json
          stores the key in this file (mode 600)
  codex   ~/.codex/config.toml
          reads AGENTDASH_KEY_AGENTDASH at runtime; key stored in the keychain

Inbox connected for Jonah Lee (jonah@example.com):
  token   ~/.agentdash/bridge-token
          your inbox credential (mode 600) — questions for you arrive with it
  inbox   ~/agentdash-inbox/.claude/settings.json
  inbox   ~/agentdash-inbox/README.md

Open ~/agentdash-inbox in Claude Code and anything waiting on you appears as the session starts.
```

## The inbox

Redeeming a code also connects **you**, not just your agent: the instance mints
an inbox credential for the person who created the code. It is deliberately a
different credential from the agent key — an agent must never be able to read
its steward's inbox.

| file | what it is |
|---|---|
| `~/.agentdash/bridge-token` | your inbox credential, mode 600 |
| `~/.agentdash/bridge-owner.json` | whose inbox this is and which instance — display metadata only, mode 600 |
| `~/agentdash-inbox/.claude/settings.json` | a `SessionStart` hook that runs `npx -y agentdash-connect@latest inbox --ack --quiet-when-empty` |
| `~/agentdash-inbox/README.md` | a short note on what the folder is for |

Start or resume a Claude Code session **in `~/agentdash-inbox`** and the hook puts what is
waiting on you into the session: approvals needing your decision first, then
agents that stopped, then work that finished. It is a separate folder so it can
never interrupt a session anywhere else — the hook applies only to sessions
started there.

Two things it does not do:

- **It does not decide.** The session tells you what is waiting; approving and
  rejecting happen on the AgentDash page.
- **It does not carry the evidence.** Only the ask and a pointer arrive, because
  anything delivered into a session becomes model context.

If this machine's inbox already belongs to someone else, pairing asks before
replacing it and defaults to keeping what is there. The agent pairing goes
ahead either way.

## Nothing left running

A config write with an exit code, not a prompt to paste — and `--remove` puts
the agent connection back.

No daemon, no menu-bar app, nothing to keep alive. The inbox is read only when
you start or resume a session in its folder. Everything written is a small file
you can read, listed on screen as it is written — a change your IT department
can review in a minute.

`--remove` undoes the agent half: the MCP config entries, the shell-profile
line and the stored key. It leaves the inbox half in place. To remove that too,
delete `~/.agentdash/bridge-token`, `~/.agentdash/bridge-owner.json` and the
`~/agentdash-inbox` folder.

## Where the key goes

Being precise about this, because it differs by harness and it is the part worth
understanding:

| | where the key lives |
|---|---|
| **Codex** | the OS keychain. `config.toml` holds only the *name* of an environment variable, never the secret. One line in your shell profile reads it back at login. |
| **Claude Code** | `~/.claude.json`, in plaintext, at mode 600. This is how Claude Code stores HTTP MCP credentials; we cannot change it, so we say so rather than imply otherwise. |

A connect code comes back from the instance as an agent key; you never see it.
If you pair with an agent key directly instead of a code, it is read from the
terminal with echo off — never from a command-line argument — so it stays out
of your shell history and out of the process list. If no keychain is available
(common over SSH or on a fresh login), it falls back to
`~/.agentdash/<name>.key` at mode 600 and tells you it did.

## Commands

```sh
npx -y agentdash-connect@latest --url <url> <code>   # redeem a connect code
npx agentdash-connect                  # interactive: asks for the link and a code or key
npx agentdash-connect --url <url>      # skip the URL question
npx agentdash-connect --check          # is the connection still good?
npx agentdash-connect --remove         # undo the agent connection
npx agentdash-connect --name <name>    # use a different MCP server name
npx agentdash-connect inbox            # read your inbox (what the SessionStart hook runs)
```

`inbox` options: `--ack` marks what was fetched as seen, so the next session
shows only what is new; `--quiet-when-empty` prints nothing when there is
nothing waiting; `--server <url>` and `--token-file <path>` override the
defaults. It never exits 2, so an unreachable instance cannot stop a session
from starting.

`--check` exits non-zero when the connection is broken, so it works in a
monitoring script. Piping the key on stdin works too, for scripted installs:

```sh
printf '%s\n' "$KEY" | npx agentdash-connect --url https://your-instance
```

## If it does not work

| what you see | what it means |
|---|---|
| a help screen for some other tool, then exit 0 | you ran `npx agentdash`; use `agentdash-connect` |
| the code is refused | it expired or was already used; create a new one |
| paired, but no "Inbox connected" line | a cached older CLI — rerun with `@latest` — or an instance older than v2026.914.0 |
| the host cannot be reached | a `.local` name over a VPN, usually; use the address you are browsing from |

## Requirements

Node 18 or newer, and at least one of Claude Code or Codex already installed.
This wires up what is already on the machine; it does not install a harness for
you.

Zero runtime dependencies.
