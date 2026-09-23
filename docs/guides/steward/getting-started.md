---
title: Getting Started as a Steward
summary: Your first sign-in, what My Agent is, and the three things to do in your first twenty minutes
audience: steward
order: 1
---

You are a **steward**: one person who runs one agent from their own terminal and answers for what it does. Being set up means three things, in this order — you can sign in and see your agent on **My Agent**, your terminal is connected, and you have decided one real approval from your own Claude session. About twenty minutes.

## Before you start

| Need | Why |
| --- | --- |
| Reach `{{instanceUrl}}` in a browser | That is the address this instance publishes. If it does not load, you are not on the network it lives on — ask your admin which network or VPN to use |
| Claude Code installed and signed in (Codex also works) | The connect step wires up what is already on your machine; it does not install a harness |
| Node 18 or newer (`node -v`) | The connect command runs through `npx` |
| Your admin has assigned you an agent | Until then **My Agent** says *No agent assigned* — nothing on your side is wrong |

## First sign-in

1. Open the invite link your admin sent. It opens from the network the instance publishes on.
2. Enter your name and a password of at least 8 characters. If you already have an account here, the page offers **sign in** instead.
3. Two short welcome screens follow — **Continue**, then **Open dashboard**.
4. Bookmark `{{instanceUrl}}`. Open **My Agent** in the left nav.

What you should see: your agent's name at the top, what it is working on, and a **Connecting as <your name>** line above a **Create a connect code** button.

If instead it says **No agent assigned. A company owner or administrator assigns your agent.** — tell your admin. They have not finished [their half](../board-operator/onboard-a-steward).

Forgot your password later: `{{instanceUrl}}/forgot-password` emails a reset link.

## The three steps

1. [Connect your terminal](./connect-your-terminal) — one command, generated for you on **My Agent**. Ten minutes, and the code inside it expires in ten minutes, so do it at your terminal.
2. [Your inbox](./your-inbox) — open `~/agentdash-inbox` in Claude Code; what is waiting on you appears as the session starts, and you can decide it there, as yourself.
3. Decide one real approval. A machine that is connected but has never decided anything has not been tested where it counts.

Something not matching? [Troubleshooting](./troubleshooting-connect) lists what you might see, what it means, and what to do.
