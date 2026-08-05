# Getting started — one prompt, one machine

**Audience:** a new customer (e.g. Titus at MKThink) with a Mac mini and Claude Code
(or Codex) already installed and logged in.
**Promise:** they paste one prompt into their agent and the install drives itself.

This is the source of record for the public getting-started page. The prompt in §3 is
the product; everything else exists so the prompt cannot get stuck.

---

## 1. What we send them first

The prompt cannot invent secrets, and it must never try. Before a customer starts, we
send one welcome email containing exactly four things:

| We send | Why they can't self-serve it | Example |
|---|---|---|
| **Invite code** | Gates the signup funnel. Validated against `agentdash.cloud`; an unreachable validator **fails closed**, so a missing code is a hard stop, not a warning. | `AGD-MKTHINK-7F3K` |
| **Workspace code** | Authorizes the `agentdash_mk` product profile at company creation. Without it the company is created on the DEFAULT profile and **every workforce surface 404s** — My Agent, ceilings, the bridge, reconciliation. | `MK-WORKFORCE-92QD` |
| **License key** | On-prem license enforcement (`AGENTDASH_ENFORCE_LICENSE`). | `eyJ…` |
| **License public key** | Verifies the license key. | `-----BEGIN PUBLIC KEY-----…` |

> The invite code and the workspace code are **different gates** and both are required.
> Conflating them is the single most likely way a install stalls.

## 2. What the customer supplies, in conversation

The agent asks for these and must never guess them:

1. **Their own email** — becomes the founding admin user.
2. **Their teammates' emails** — each colleague who will steward an agent (at MKThink:
   the Product, Engineering and Marketing leads).
3. **Which model runs the agents:**
   - **Nothing to supply** if they use the Mac's own Claude Code subscription
     (`claude_local`, bring-your-own-tokens). This is the recommended default: no API
     key, no per-token markup.
   - An **Anthropic/OpenAI/Gemini API key** only if they'd rather run `claude_api`.
4. *(Optional)* **Telegram bot token + username** if they want to approve from their phone.
5. *(Optional)* **Resend API key** — only if they want invite emails actually delivered.
   Left unset, invites still work: the server mints `/invite/<token>` links and the
   agent hands them over directly. **No email provider is required to get started.**

## 3. What the machine generates itself

Nothing here should ever appear in a doc, a repo, or an email:

- `BETTER_AUTH_SECRET`, `PAPERCLIP_AGENT_JWT_SECRET` — `openssl rand -hex 32`
- The machine's LAN IP — detected, not asked for
- **The database** — an embedded Postgres ships with the server. There is no database to
  install, no `DATABASE_URL` to set, no Docker.

---

## 4. The prompt

Everything above is why this works. The customer opens Claude Code (or Codex) and pastes
this once.

```text
You are installing AgentDash on this Mac mini for my company. Work through this
end to end, and STOP and ask me whenever you need something only I can give you.
Never invent an email address, an API key, an invite code, or a license key.

WHAT I WILL GIVE YOU WHEN YOU ASK
- my email address
- my teammates' email addresses
- an invite code and a workspace code (two different codes, both required)
- a license key and a license public key
- optionally an API key, if I don't want to use this Mac's Claude subscription

STEP 1 — PREREQUISITES
Check node (20+), pnpm (9+), git, and the claude CLI. Install anything missing
(nodejs.org, `npm i -g pnpm`, `xcode-select --install`,
`npm i -g @anthropic-ai/claude-code`). Confirm Claude is authenticated with
`echo "Respond with hello" | claude --print -`; if that fails, tell me to run
`claude` and log in.

STEP 2 — INSTALL
git clone https://github.com/thetangstr/agentdash.git ~/agentdash
cd ~/agentdash && pnpm install --frozen-lockfile && pnpm build

STEP 3 — CONFIGURE
Detect the LAN IP (`ipconfig getifaddr en0 || ipconfig getifaddr en1`).
Generate two secrets with `openssl rand -hex 32`.
Ask me for the license key, license public key, and the workspace code.
Write ~/.config/agentdash/agentdash.env containing:

  PAPERCLIP_DEPLOYMENT_MODE=authenticated
  NODE_ENV=production
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private
  PAPERCLIP_BIND=lan
  PAPERCLIP_ALLOWED_HOSTNAMES=<LAN_IP>
  PAPERCLIP_PUBLIC_URL=http://<LAN_IP>:3100
  PAPERCLIP_API_URL=http://127.0.0.1:3100
  PAPERCLIP_AUTH_BASE_URL_MODE=explicit
  PAPERCLIP_AUTH_PUBLIC_BASE_URL=http://<LAN_IP>:3100
  PAPERCLIP_MIGRATION_AUTO_APPLY=true
  BETTER_AUTH_SECRET=<generated>
  PAPERCLIP_AGENT_JWT_SECRET=<generated>
  AGENTDASH_DEPLOYMENT_KIND=on_prem
  AGENTDASH_ENFORCE_LICENSE=true
  AGENTDASH_LICENSE_KEY=<from me>
  AGENTDASH_LICENSE_PUBLIC_KEY=<from me>
  AGENTDASH_DEFAULT_ADAPTER=claude_local
  AGENTDASH_MK_INVITE_CODES=<workspace code from me>
  AGENTDASH_SELF_SERVE_BOOTSTRAP=true
  DISABLE_AUTOUPDATER=1   # this one is the Claude Code CLI's own flag, not AgentDash's:
                          # it pins the CLI so an auto-update can't change agent behaviour
                          # on a machine nobody is watching

Use claude_local unless I gave you an API key; if I did, set
AGENTDASH_DEFAULT_ADAPTER=claude_api and ANTHROPIC_API_KEY instead.

STEP 4 — RUN AS A SERVICE
Run ~/agentdash/docker/launchd/install.sh, then
`launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent`.
Stop the machine sleeping: `sudo pmset -a sleep 0 disksleep 0`.
Wait for `curl -fsS http://127.0.0.1:3100/api/health` to return ok. If it does
not, read ~/.agentdash/logs/agentdash.err and tell me what it says.

STEP 5 — CLAIM THE INSTALL
Ask me for my email and the invite code, then create the founding admin user.
Give me back the one-time password-setup link so I can open the dashboard in a
browser. (This works with no email provider configured.)

STEP 6 — CREATE THE WORKSPACE
Create the company with productProfile "agentdash_mk" AND the workspace code as
inviteCode, in the same request. Both are required together. Then confirm
GET /api/companies/<id>/connector-send-executions?status=outcome_unknown
returns 200 rather than 404 — a 404 means the company landed on the wrong
profile and must be recreated.

STEP 7 — ADD MY TEAM
Ask me for my teammates' emails. Invite them with auto-approve enabled, so
accepting grants membership immediately. Membership is REQUIRED before the next
step: assigning a steward to a non-member is refused.
Give me each invite link so I can pass them on.

STEP 8 — PAIR EACH HUMAN WITH AN AGENT
Create one agent per teammate plus one for me. Assign exactly one steward to
each agent — one human, one agent; the model forbids a second. Confirm each
person's My Agent page resolves their agent.

STEP 9 — SET THE GUARDRAILS
Show me the list of destructive action classes that require my approval, and
ask if I want to add any. Set the owner ceiling for each agent accordingly.

STEP 10 — PROVE IT WORKS
Have my agent ask one teammate's agent for a fact, confirm it reaches that
person, have them answer, and show me the answer coming back attributed.
Then report: the dashboard URL, which model you used, who stewards which
agent, and anything you could not finish.
```

## 5. Verification the customer can run themselves

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/health   # 200
open http://<LAN_IP>:3100                                                  # dashboard
```

Then in the UI: **My Agent** shows their agent, **Company Settings** shows the ceiling
editor with all six dimensions, and **Approvals** is where gated work waits.

## 6. Two things that will stall an install, and why

Both were found by running the flow end to end, not by reading the code:

1. **Stewardship refuses a non-member.** Assigning a steward to someone who has not
   accepted an invite returns `409 Steward user must be an active company member`. There
   is no API to add a member directly — production goes through the invite flow. If the
   team is invited but hasn't accepted, step 8 fails with a message that doesn't obviously
   point at the cause. Hence auto-approve in step 7.
2. **The wrong profile is silent.** A company created without the workspace code succeeds
   — it just isn't a workforce workspace, and every feature 404s afterwards. Step 6's
   check exists to catch that immediately, while recreating the company is still cheap.

## 7. See also

- [`doc/MCP-LAUNCH.md`](MCP-LAUNCH.md) — the MCP-native variant, where the agent drives
  via MCP tools (`agentdash_setup_status` → `nextAction`) instead of shell steps
- [`doc/plans/2026-08-03-mac-mini-test-runbook.md`](plans/2026-08-03-mac-mini-test-runbook.md) — what we run on-site for the first real cycle
- [`doc/customers/mkthink/`](customers/mkthink/) — MKThink's own operating procedure
