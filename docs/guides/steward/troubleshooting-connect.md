---
title: Troubleshooting Connect and Inbox
summary: What you see, what it means, what to do — almost everything is the wrong address, an old CLI, or the wrong credential
audience: steward
order: 4
---

Almost everything below is one of three things: the wrong address, an old CLI, or the wrong credential. Find the line that matches what you see.

| What you see | What it means | Do |
| --- | --- | --- |
| The invite link or `{{instanceUrl}}` does not load | You are not on the network the instance publishes on | Ask your admin which network or VPN to use, then retry |
| **No agent assigned** on My Agent | Your admin has not made you the agent's steward yet | Tell them — see [Onboard a steward](../board-operator/onboard-a-steward) |
| Connect: `The code is refused` / not valid | Expired (10 minutes) or already used | Create a new code on My Agent; nothing was written |
| Connect prints a help screen for some other tool, then exits 0 | You ran the bare name `agentdash`, an unrelated npm package | Use the full `agentdash-connect`, copied from My Agent |
| Paired, but no **Inbox connected** line | A cached pre-0.2 CLI, or `@latest` was dropped | `npx agentdash-connect --remove`, then rerun the exact command from My Agent |
| `Kept the existing inbox connection` | You answered N to replacing another person's inbox | Rerun with a fresh code and answer **y** — it is your machine |
| No `agentdash-inbox` entry in `~/.claude.json` | Connected before `agentdash-connect` 0.3.0 | Reconnect with a fresh code |
| Claude says `403 Board access required` when approving | It used the agent's key. Correct refusal — agents cannot decide | Ask it to use the inbox tools (`inbox_sync`, `inbox_decide`). If those are missing, see the row above |
| `inbox_decide` refused: already decided / revision moved on / not yours | The approval changed, or belongs to another steward | Nothing to fix; check the board |
| Claude does not see the new tools | The session started before connect finished | Start a new Claude Code session |
| **Connected machines** shows **read-only** for your machine | Endpoint minted by an old CLI | `npx agentdash-connect --remove`, then reconnect with a fresh code |
| The invite email never arrived | Delivery is best-effort | Your admin can copy the link from **Company Settings → Invites → Invite history** and send it directly |

Still stuck: send your admin the exact text on screen, not a paraphrase. The difference between "refused", "not found" and "cannot reach" is the diagnosis.
