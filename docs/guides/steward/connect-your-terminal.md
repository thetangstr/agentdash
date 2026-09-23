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
4. When it finishes, **start a new Claude Code session**. Config is read at start; a session that was already open will not see the new tools. Codex users: open a new terminal too.

Keep the command exactly as printed. `agentdash-connect` is the full package name — a bare `agentdash` is somebody else's package and prints a harmless-looking help screen. `@latest` stops npx serving a cached old version that skips the inbox half.

## What it does

1. Finds which harnesses are installed (Claude Code, Codex).
2. Redeems the code — once — and checks the connection works before writing anything. A wrong code, a mistyped address and an instance that is down are three different messages.
3. Writes each harness's own config.
4. Sets up your inbox.
5. Prints every file it changed.

## What it writes, and why there are two credentials

| Written | What it is |
| --- | --- |
| `~/.claude.json` → entry `agentdash` | Your **agent's** key. Claude uses it to act as the agent: read issues, comment, do work. It cannot approve anything — by design |
| `~/.agentdash/bridge-token` (mode 600) | **Your** inbox credential. Bound to you, not the agent |
| `~/.claude.json` → entry `agentdash-inbox` | Your own inbox tools, launched with `npx -y agentdash-connect@latest mcp`. No secret in the file; it reads the token above |
| `~/agentdash-inbox/` | A folder with a `SessionStart` hook. Sessions started there show what is waiting on you |

The agent and you are different actors with different credentials on purpose: an agent must never hold authority over the approvals that constrain it. That is why asking Claude to approve something used to answer `403 Board access required` — it only had the agent's key. Since `agentdash-connect` 0.3.0 you have your own; see [Your inbox](./your-inbox).

## Check it

```sh
npx agentdash-connect --check
```

Expect `Claude configured` and `Status working — <n> tools available`. Then, in a new Claude Code session, ask *"use whoami and tell me who I am"* — you should get the agent's name, role and company, `autonomy: stewarded`, and `steward:` with your name.

## Undo

```sh
npx agentdash-connect --remove
```

Removes both Claude Code entries, the Codex entry, the shell-profile line and the stored key. It leaves your inbox credential and folder; delete `~/.agentdash/bridge-token`, `~/.agentdash/bridge-owner.json` and `~/agentdash-inbox/` to finish. To cut a machine off without touching it — a lost laptop — use **My Agent → Connected machines → Disconnect**; its key stops working at once.
