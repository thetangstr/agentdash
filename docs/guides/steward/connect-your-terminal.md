---
title: Connect Your Terminal
summary: One command pairs your Claude Code with your agent and gives you your own inbox — what it does, what it writes, and why there are two credentials
audience: steward
order: 2
---

One command, generated for you on **My Agent**, pairs your Claude Code with your agent and gives you your own inbox. Ten minutes — and the code inside the command expires in ten minutes, so do this at your terminal, on the machine you actually work from.

## Run it

1. On **My Agent**, press **Create a connect code**. The page shows a line like:

   ```sh
   npx -y agentdash-connect@latest --url {{instanceUrl}} KVTX-8F02
   ```

2. **Copy command** and run it in a terminal — macOS/Linux terminal or Windows PowerShell, same line.
3. If it asks `This machine's inbox currently belongs to <someone>. Replace it? [y/N]` — answer **y** on your own machine.
4. When it finishes, **start a new Claude Code session**. Config is read at start; a session that was already open will not see the new tools. Codex users: open a new terminal too. Claude Desktop users: quit and reopen Claude Desktop, then do the one-time project step in [Claude Desktop](#claude-desktop).

Keep the command exactly as printed. `agentdash-connect` is the full package name — a bare `agentdash` is somebody else's package and prints a harmless-looking help screen. `@latest` stops npx serving a cached old version that skips the inbox half.

## What it does

1. Finds which harnesses are installed (Claude Code, Claude Desktop, Codex).
2. Redeems the code — once — and checks the connection works before writing anything. A wrong code, a mistyped address and an instance that is down are three different messages.
3. Writes each harness's own config. Your agent's tools go to Claude Code and Codex; Claude Desktop gets only your inbox tools.
4. Sets up your inbox, and adds your own inbox tools to every client it found.
5. On a Mac, at a terminal, asks whether to show a notification when an agent hands you work (default no; see [Your inbox](./your-inbox)).
6. Prints every file it changed.

## What it writes, and why there are two credentials

| Written | What it is |
| --- | --- |
| `~/.claude.json` → entry `agentdash` | Your **agent's** key. Claude uses it to act as the agent: read issues, comment, do work. It cannot approve anything — by design |
| `~/.agentdash/bridge-token` (mode 600) | **Your** inbox credential. Bound to you, not the agent |
| `~/.claude.json` → entry `agentdash-inbox` | Your own inbox tools, launched with `npx -y agentdash-connect@latest mcp`. No secret in the file; it reads the token above |
| `~/agentdash-inbox/` | A folder with a `SessionStart` hook, the `agentdash-coworker` review rules (`.claude/skills/`) and an `AGENTS.md` with the same rules for Codex. Sessions started there show what is waiting on you |
| `~/.codex/config.toml` → `[mcp_servers.agentdash-inbox]` | Your own inbox tools in Codex, beside the agent's `[mcp_servers.agentdash]`. No secret in the file |
| Claude Desktop's `claude_desktop_config.json` → entry `agentdash-inbox` | Your own inbox tools in Claude Desktop. Merged into the file, never replacing it; the previous file is saved next to it as `claude_desktop_config.json.agentdash-backup-<time>` first. No secret in the file |
| `~/agentdash-inbox/claude-desktop-project.md` | The review rules for a Claude Desktop project (see below) |
| `~/Library/LaunchAgents/com.agentdash.connect.watch.plist`, `~/.agentdash/watch.json`, `~/.agentdash/connect-runtime/` | Only if you said yes to notifications: the launchd agent that checks every 15 minutes, its settings, and the copy of `agentdash-connect` it runs |

The agent and you are different actors with different credentials on purpose: an agent must never hold authority over the approvals that constrain it. That is why asking Claude to approve something used to answer `403 Board access required` — it only had the agent's key. Since `agentdash-connect` 0.3.0 you have your own; see [Your inbox](./your-inbox).

## Claude Desktop

Claude Desktop keeps its config in `~/Library/Application Support/Claude/` on macOS and `%APPDATA%\Claude\` on Windows; there is no Claude Desktop on Linux. It has no project folder and no session-start hook, so it cannot start the review by itself. Do this once:

1. In Claude Desktop, create a project, for example **AgentDash inbox**.
2. Paste the contents of `~/agentdash-inbox/claude-desktop-project.md` into the project's instructions.
3. Start inbox chats in that project. Claude reviews what is waiting first; in any other chat it uses your inbox tools only when you ask.

Claude Desktop may not be able to open files the inbox tools save in `~/agentdash-inbox/incoming/`. When it cannot, it says so rather than guessing.

## Installed a client later?

```sh
npx agentdash-connect clients
```

Adds your inbox tools to every client now on this machine (Claude Code, Claude Desktop, Codex) using the inbox connection you already have. No new connect code needed.

## Check it

```sh
npx agentdash-connect check
```

It reports, without changing anything:

- your agent's tools in Claude Code and Codex, and whether they work (`Status working — <n> tools available`);
- your inbox tools in Claude Code, Claude Desktop and Codex: `connected`, `not connected`, or `not installed`;
- whose inbox this machine holds, its name, and its capabilities;
- `bridge:work`: `present`, or `missing — review not enabled; reconnect with a new connect code`. Without it, your own Claude cannot review your agents' work or send anything back from this machine. **My Agent → Connected machines** shows the same thing;
- `Review`: `ready`, or `not turned on for your company yet` when an administrator has not enabled co-worker review.

It exits 0 when everything this machine has works and review is enabled for it. `--check` does the same. Then, in a new Claude Code session, ask *"use whoami and tell me who I am"* — you should get the agent's name, role and company, `autonomy: stewarded`, and `steward:` with your name.

## Undo

```sh
npx agentdash-connect --remove
```

Removes both Claude Code entries, both Codex entries, the Claude Desktop entry (backing that file up first), the shell-profile line, the stored key and the notification agent, if you turned it on. It leaves your inbox credential and folder; delete `~/.agentdash/bridge-token`, `~/.agentdash/bridge-owner.json` and `~/agentdash-inbox/` to finish. To cut a machine off without touching it — a lost laptop — use **My Agent → Connected machines → Disconnect**; its key stops working at once.
