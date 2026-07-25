# Monday Customer Deployment Runbook

**Scenario:** On-site visit Monday. Customer gets AgentDash on their Mac mini, on-prem, free for 6 months, BYOT. They have business ChatGPT and Claude Code.

**Goal:** Leave with a working AgentDash installation using `claude_local` (no hermes dependency).

---

## Pre-Visit Checklist (Do This Sunday)

### 1. Generate License Keypair

```sh
cd ~/agentdash
node scripts/mint-license.mjs keygen --out /tmp/customer-license-private.pem
# Save the printed public key — customer needs it in their env
```

### 2. Mint 6-Month Free License

```sh
node scripts/mint-license.mjs mint \
  --key /tmp/customer-license-private.pem \
  --customer "<Customer Name>" \
  --plan on_prem \
  --days 180
# Save the printed token
```

### 3. Prepare a USB/stick with
- This runbook
- The license token + public key
- The AgentDash git repo URL: `github.com/thetangstr/agentdash`

---

## On-Site: Installation (30 min)

### Step 1: Check Prerequisites on Customer's Mac Mini

```sh
# Node 20+
node --version

# pnpm 9+
pnpm --version

# Claude Code CLI — THIS IS CRITICAL
which claude
claude --version

# Git
which git
```

**If Claude Code CLI is missing:** The customer said they have Claude Code, so `claude` should be on PATH. If it's installed via npm globally, it'll be there. If not, install it:
```sh
npm install -g @anthropic-ai/claude-code
claude  # first run will prompt for login — use their Claude account
```

**Verify Claude Code works:**
```sh
echo "Respond with hello" | claude --print -
# Should output "hello" — confirms auth is working
```

### Step 2: Clone and Install AgentDash

```sh
git clone https://github.com/thetangstr/agentdash.git ~/agentdash
cd ~/agentdash
pnpm install
pnpm build
```

### Step 3: Install as launchd Service

```sh
./docker/launchd/install.sh
```

This creates:
- `~/.config/agentdash/agentdash.env` — the env file
- `~/Library/LaunchAgents/ai.agentdash.agent.plist` — the service

### Step 4: Configure the Env File

```sh
nano ~/.config/agentdash/agentdash.env
```

Set these values:

```sh
# Deployment — private network only
PAPERCLIP_DEPLOYMENT_MODE=authenticated
NODE_ENV=production
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_BIND=lan
PAPERCLIP_ALLOWED_HOSTNAMES=<tailscale-ip>,<lan-ip>
PAPERCLIP_PUBLIC_URL=http://<tailscale-ip>:3100
PAPERCLIP_API_URL=http://127.0.0.1:3100
PAPERCLIP_AUTH_BASE_URL_MODE=explicit
PAPERCLIP_AUTH_PUBLIC_BASE_URL=http://<tailscale-ip>:3100
PAPERCLIP_MIGRATION_AUTO_APPLY=true

# Secrets — generate fresh
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32)

# THIS IS THE KEY DECISION: Use claude_local, NOT hermes_local
AGENTDASH_DEFAULT_ADAPTER=claude_local

# CRITICAL: Pin Claude Code version and prevent auto-update
# The native installer auto-updates; a regression in 2.1.218+ breaks
# claude_local agent runs (Paperclip upstream issue #10102)
DISABLE_AUTOUPDATER=1
# Install pinned version on the Mac mini:
#   npm install -g @anthropic-ai/claude-code@2.1.210

# License (on-prem, free trial)
AGENTDASH_DEPLOYMENT_KIND=on_prem
AGENTDASH_LICENSE_KEY=<paste-token-from-step-2>
AGENTDASH_LICENSE_PUBLIC_KEY=<paste-public-key>
```

**Why `claude_local` not `hermes_local`:**

| | claude_local | hermes_local |
|---|---|---|
| What it spawns | `claude --print -` | `hermes chat -q` |
| Auth | Claude Code CLI login (OAuth, user already has it) | hermes setup (separate install + config) |
| Customer complexity | Zero — they already have Claude Code | High — need to install hermes, configure providers |
| CoS chat dispatch | ✅ Spawns `claude --print -` | ✅ Spawns `hermes chat -q` |
| Agent execution | ✅ Full adapter with sessions, skills | ✅ Full adapter |
| Herpes in the picture? | **No** | Yes |

Claude Code's login uses OAuth with Anthropic. The customer's existing Claude subscription authenticates the CLI. AgentDash just spawns the `claude` binary — no API keys to manage, no hermes to install.

### Step 5: Restart and Verify

```sh
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
sleep 5
curl -fsS http://127.0.0.1:3100/api/health
```

Expected: `{"status":"ok", ...}`

### Step 6: Run Readiness Check

```sh
cd ~/agentdash
scripts/msp-mac-mini-readiness.sh \
  --base-url http://<tailscale-or-lan-host>:3100 \
  --expected-company "<Customer Name>" \
  | tee ~/agentdash-readiness-$(date +%Y%m%d-%H%M%S).txt
```

---

## On-Site: First Run (15 min)

### Step 7: Sign Up

1. Open `http://<tailscale-ip>:3100` from another machine on the network
2. Sign up with the founding operator's email
3. This auto-creates a workspace + CoS agent

### Step 8: Verify CoS Chat Works

1. Navigate to `/cos`
2. Send a message: "Hi, I'm setting up my company on AgentDash"
3. **Expected:** Real Claude-powered reply within ~5 seconds
4. **If stub reply:** ("Got it. (stub reply — set ANTHROPIC_API_KEY...)"):
   - Check `AGENTDASH_DEFAULT_ADAPTER=claude_local` is set in env
   - Check `claude` is on PATH: `which claude`
   - Check Claude auth: `echo "hello" | claude --print -`
   - Restart: `launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent`

### Step 9: Complete Onboarding Flow

1. Answer the CoS interview questions about the customer's company
2. Review the proposed agent team
3. Approve the plan — agents get created with `claude_local` adapter
4. Create a test task and assign it
5. Trigger an agent wakeup run
6. **Verify:** Agent run appears in dashboard with transcript

### Step 10: Set Up Budget Limits

In the dashboard:
1. Go to company settings
2. Set a monthly token/cost budget (prevents runaway spend)
3. The hard-stop enforcement will pause agents if they exceed it

---

## Token Consumption Reality for This Customer

### What they have and what it means for AgentDash

**Claude Code (CLI):**

Claude Code authenticates via **OAuth login with a Claude subscription** (Pro, Max, Teams, or Enterprise) — NOT via API keys. When AgentDash spawns `claude --print -`, the CLI uses the logged-in session. This does work for basic CoS chat and agent execution.

**However — critical caveats from upstream:**

1. **Usage limits apply.** Claude Code on a Pro/Max subscription has plan-level usage limits (like "X hours of Opus per week"). Heavy multi-agent workloads will hit these limits fast. Anthropic's enterprise data shows ~$13/developer/day average, ~$150-250/dev/month. A fleet of 5 agents running heartbeats will burn through Pro limits quickly.

2. **Claude Code 2.1.218+ has a known regression** (reported as Paperclip upstream issue [#10102](https://github.com/paperclipai/paperclip/issues/10102)): OAuth-backed MCP servers get silently stripped from `claude_local` agent runs in non-interactive `--print` mode. Agents degrade without erroring. **Workaround:** pin Claude Code at 2.1.210 and set `DISABLE_AUTOUPDATER=1` so the CLI doesn't auto-upgrade mid-run.

3. **No token cost visibility.** Claude Code subscription doesn't report per-call token costs the way API billing does. AgentDash's `cost_events` table will show $0 for subscription-backed runs because the CLI doesn't return usage data in `--print` mode. The customer's spend tracking comes from their Anthropic usage dashboard, not AgentDash.

4. **Claude Code auto-updates.** The native installer auto-updates in the background. A version upgrade can silently change agent behavior. Set `DISABLE_AUTOUPDATER=1` in the launchd environment.

**Business ChatGPT:**

ChatGPT Plus/Team/Enterprise subscriptions are **consumer products** — they do NOT provide API access. To use OpenAI models with AgentDash, the customer needs a separate **OpenAI API key** from platform.openai.com (different billing, per-token). Their ChatGPT login cannot authenticate API calls.

**Does OpenAI OAuth work?** No, not for this use case. OpenAI doesn't offer OAuth for API access the way Claude Code does. The OpenAI API requires a server-side API key (`OPENAI_COMPAT_API_KEY`). There is no "log into ChatGPT and your API calls are authenticated" path. The customer would need to create and fund a separate OpenAI Platform account.

**What actually works for this customer (Monday):**

| Path | Auth method | Works? | Limitation |
|------|-------------|--------|------------|
| `claude_local` (Claude Code CLI) | OAuth login via Claude subscription | ✅ Works | Subject to plan usage limits; pin version to avoid regression |
| `claude_api` (Anthropic API) | `ANTHROPIC_API_KEY` env var | ✅ Works if they have API key | Separate billing from subscription (~$3/M input, $15/M output Sonnet) |
| `openai_compat` (OpenAI/ChatGPT) | `OPENAI_COMPAT_API_KEY` env var | ✅ Works if they have API key | ChatGPT subscription doesn't give API access; need separate OpenAI Platform account |
| ChatGPT login/OAuth | N/A | ❌ Not available | OpenAI doesn't offer OAuth API access |

**My recommendation for Monday:**

Start with `claude_local` (they have Claude Code, it works out of the box). But:
1. Pin the version: install Claude Code 2.1.210, set `DISABLE_AUTOUPDATER=1`
2. Set a low heartbeat interval (5-10 min) to avoid hitting plan limits
3. Tell them: "Your Claude subscription covers the AI. If you hit usage limits, you can either upgrade your Claude plan or add an Anthropic API key as a fallback."

**The honest customer conversation about token consumption:**

> "Your Claude Code subscription powers the agents — no separate API key needed to start. But Claude subscriptions have usage limits. If your agents do heavy work (hours of coding), you may hit those limits. You can upgrade your Claude plan, or switch to API-based billing where you pay per-token directly to Anthropic. AgentDash tracks all agent activity so you can see what's happening. For OpenAI models, you'd need a separate OpenAI API key — your ChatGPT subscription doesn't cover API access."

---

## What to Change in the Codebase Before Monday

The `claude_local` adapter works today for both CoS chat and agent execution. No code changes needed. The only thing to verify is that the default agent plan proposes `claude_local` instead of `hermes_local` when that's the configured adapter.

Currently `cos-replier.ts` line 20: `DEFAULT_AGENT_PLAN_ADAPTER_TYPE = "hermes_local"`. This should respect `AGENTDASH_DEFAULT_ADAPTER`. I'll fix this so the customer's onboarding proposes claude_local agents automatically.

---

## Post-Install: What to Tell the Customer

> "AgentDash is running on your Mac mini. It uses your Claude Code login for AI — no extra API keys. Your agents will wake up on schedule, pick up tasks, and report back. You can see everything on the dashboard. If agents spend too much, the budget limit pauses them automatically. We'll check in weekly for the first month."
