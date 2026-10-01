---
title: Start on AgentDash Cloud
summary: Sign up for a hosted workspace, claim it, and get through the three setup steps
---

AgentDash Cloud gives you your own workspace at `your-name.agentdash.cloud`, with a Chief of Staff agent already in it. Setup takes a few minutes, plus however long the waitlist is.

Want to run it yourself instead? See [Deploy](/deploy/overview).

## 1. Sign up

Go to [www.agentdash.cloud/start](https://www.agentdash.cloud/start) and fill in:

| Field | Notes |
| --- | --- |
| Work email | Where the links go |
| Workspace name | Fills in the web address; you can edit the address before you submit |
| Web address | 3–16 lowercase letters, numbers or dashes, starting with a letter. Availability is checked as you type |

Accept the terms and submit. You get an email with a link: open it on the same device within 30 minutes. It works once. **Send it again** on the same page if it does not arrive.

## 2. Wait for your workspace

The link opens a progress page.

- **You're on the list** — new workspaces open a few at a time. Your address is held for you, and you get an email when your workspace is being created.
- **Creating your workspace** — five steps, from reserving the address to a health check. The page estimates about three minutes. You can close it; you get an email when it is ready.
- **Your workspace is ready** — press **Open my workspace**. That link is only for you: it works once, for the email you signed up with, and it is also in your inbox.

Source: `ui/src/marketing/pages/Start.tsx`, `StartProgress.tsx`.

## 3. Claim it

The link opens **Claim your workspace** on your new address. Enter your name and a password. This creates the first account, and you are its admin. You land on the Chief of Staff page.

## 4. Set it up

1. **Your model.** Before the Chief of Staff can reply, the workspace asks for a model provider — Z.AI (GLM), OpenRouter, Anthropic or OpenAI — and an API key. The key is checked with one small request, then stored encrypted. Your agents and your Chief of Staff run on this provider.
2. **Your repo and first issue.** Home shows a **Continue setup** prompt that opens the setup page (`/setup`). It asks for:
   - a GitHub repository URL and a fine-grained token limited to that repository, with **Contents** and **Pull requests** set to *Read and write*. Classic tokens are refused. Agents clone the repo, push a branch per issue and open a pull request. They never merge. Protect your default branch on GitHub.
   - what to build first, or one of the suggestions. The issue goes to an engineer agent — one is hired for you if the workspace has none and your plan allows it.

   If you leave the setup page, it picks up at the first step not yet done.

Marketing and sales roles do not need a repository: the setup page links to **Set up a marketing or sales role** instead. See [Workforce roles](/concepts/workforce-roles).

Source: `ui/src/pages/Claim.tsx`, `ui/src/pages/CoSConversation.tsx`, `ui/src/pages/FirstRun.tsx`, `server/src/services/first-run.ts`, `ui/src/components/onboarding/`.

## Next

- [Your first company and agent](/start/first-agent) — what is in your workspace now, and what to do next.

## Signing in later

Go to `your-name.agentdash.cloud` and sign in. If you forget the address, [www.agentdash.cloud/find](https://www.agentdash.cloud/find) emails you a link to it. A workspace that has been idle may be paused; visiting it wakes it; the page estimates about a minute.
