# Customer Launch Package — Complete Guide

**For:** Monday customer visit — Mac mini on-prem deployment
**Prepared by:** Aria (CEO, AgentDash)
**Date:** 2026-07-23

---

## Part 1: Installation Guide (What You Do On-Site)

### Prerequisites Check

Before you start, verify on the customer's Mac mini:

```sh
# Node.js 20+
node --version

# pnpm 9+
pnpm --version

# Git
git --version

# Claude Code CLI (they said they have it)
which claude
claude --version
```

**If Claude Code is missing or old:**
```sh
npm install -g @anthropic-ai/claude-code
claude  # First run: prompts for login. They sign in with their Claude account.
```

**Verify Claude works:**
```sh
echo "Respond with hello" | claude --print -
# Should output "hello" within 5 seconds
```

### Step 1: Clone AgentDash

```sh
git clone https://github.com/thetangstr/agentdash.git ~/agentdash
cd ~/agentdash
pnpm install
pnpm build
```

### Step 2: Install as a macOS Service

```sh
./docker/launchd/install.sh
```

This creates:
- `~/.config/agentdash/agentdash.env` — the configuration file
- `~/Library/LaunchAgents/ai.agentdash.agent.plist` — the background service

### Step 3: Configure the Environment

```sh
nano ~/.config/agentdash/agentdash.env
```

Set these values (replace `<VALUES>` with the actual settings):

```sh
# === Deployment ===
PAPERCLIP_DEPLOYMENT_MODE=authenticated
NODE_ENV=production
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_BIND=lan
PAPERCLIP_ALLOWED_HOSTNAMES=<mac-mini-lan-ip>
PAPERCLIP_PUBLIC_URL=http://<mac-mini-lan-ip>:3100
PAPERCLIP_API_URL=http://127.0.0.1:3100
PAPERCLIP_AUTH_BASE_URL_MODE=explicit
PAPERCLIP_AUTH_PUBLIC_BASE_URL=http://<mac-mini-lan-ip>:3100
PAPERCLIP_MIGRATION_AUTO_APPLY=true

# === Security (generate fresh) ===
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32)

# === LLM Adapter ===
# Use claude_local — it uses their Claude Code login, no API key needed
AGENTDASH_DEFAULT_ADAPTER=claude_local

# Pin Claude Code version to avoid auto-update regressions
DISABLE_AUTOUPDATER=1

# === License ===
AGENTDASH_DEPLOYMENT_KIND=on_prem
AGENTDASH_LICENSE_KEY=<paste-license-token>
AGENTDASH_LICENSE_PUBLIC_KEY=<paste-public-key>

# === Optional: Anthropic API Key for cost tracking ===
# If they have an API key (separate from Claude Code subscription),
# set it here. This enables budget enforcement and cost tracking.
# Without it, cost_events shows $0 and budgets can't hard-stop.
# ANTHROPIC_API_KEY=sk-ant-...
```

### Step 4: Restart and Verify

```sh
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
sleep 5

# Health check
curl -fsS http://127.0.0.1:3100/api/health
# Expected: {"status":"ok", ...}
```

### Step 5: Open the Dashboard

From another computer on the same network:
```
http://<mac-mini-lan-ip>:3100
```

---

## Part 2: First-Run Guide (What You Do Together)

### Step 1: Sign Up

1. Open `http://<mac-mini-lan-ip>:3100` in a browser
2. Click "Sign up"
3. Enter the founding operator's email and a password
4. This auto-creates a workspace + Chief of Staff agent

### Step 2: The CoS Conversation (`/cos`)

The Chief of Staff (CoS) will greet you. This is the onboarding flow:

**What the CoS does:**
- Asks about the company: "What's your company name? What are you trying to accomplish?"
- Proposes a team of AI agents based on the company's goals
- Creates the agents when you approve the plan
- Suggests initial tasks for each agent

**What to tell the customer during onboarding:**
> "The Chief of Staff is your AI operations manager. Tell it what your company does and what you want to achieve. It'll suggest a team of AI agents — you can approve or revise. Once set up, the agents will check for work on a schedule and report back."

### Step 3: Review the Agent Team

The CoS will propose 2-5 agents with roles like:
- Engineering Lead
- Marketing/Sales Agent
- Operations Agent
- Customer Support Agent

Each agent uses `claude_local` adapter — they run via Claude Code.

**What to verify:**
1. Click "Agents" in the sidebar
2. Each agent should show status: "idle" (ready for work)
3. Click on an agent → "Test Environment" — should show ✓ Claude binary found
4. Set a monthly budget per agent if using API billing (see Part 4)

### Step 4: Create Tasks

1. Click "New Issue" in the sidebar
2. Assign it to an agent
3. The agent picks it up on the next heartbeat (default: 30 seconds)

**Demo task for the customer:**
> Create a task: "Research our top 3 competitors and write a one-page summary." Assign to the first agent. Watch the agent status change from idle → running. Check back in 5 minutes for results.

### Step 5: Explore the Dashboard

Show the customer:
- **Dashboard** (`/dashboard`) — company overview, agent fleet status, pending approvals
- **Issues** (`/issues`) — task board with assignees
- **Agents** (`/agents/all`) — agent fleet, each with status and last activity
- **Activity** (`/activity`) — audit log of everything that's happened
- **Costs** (`/costs`) — token spend tracking (only works with API key billing)

---

## Part 3: Hermes CEO Agent with iMessage (The Killer Feature)

### Why This Matters

The customer's main user can text-message their CEO agent from their iPhone. The agent reads the message, takes action in AgentDash (creates tasks, assigns work, checks status), and replies via iMessage. **No app to open — just Messages.app on their phone.**

### How It Works

```
Customer texts: "What's the status on the competitor research?"
       ↓
iPhone → Messages.app → Mac mini (imsg watches for new messages)
       ↓
Hermes CEO agent (running as gateway service)
  - Reads the message
  - Calls AgentDash API to check issue status
  - Composes a reply
  - Sends it back via iMessage
       ↓
Customer receives: "The research is 60% done. Marco found 3 competitors.
Draft summary is attached to YAR-1. Estimated completion: 2 hours."
```

### Setup (Do This On-Site)

**Step 1: Install the agent Agent on the Mac mini**

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup  # Pick model + provider (recommend: Claude Sonnet via their Anthropic key)
```

**Step 2: Install imsg (iMessage bridge)**

```sh
brew install steipete/tap/imsg
```

**Step 3: Grant permissions**

On the Mac mini:
1. System Settings → Privacy & Security → Full Disk Access
2. Add the terminal app (Terminal.app or iTerm)
3. Open Messages.app and make sure it's signed in to the same Apple ID as the customer's iPhone

**Step 4: Create a the agent profile for the CEO agent**

```sh
hermes profile create ceo
hermes -p ceo model  # Select Claude Sonnet 5 (or their preferred model)
```

**Step 5: Configure the CEO agent's AGENTS.md**

```sh
cat > ~/.hermes/profiles/ceo/AGENTS.md << 'EOF'
# CEO Agent

You are the CEO's Chief of Staff for <Customer Company Name>.

Your job:
- Receive instructions via iMessage from the CEO
- Interact with AgentDash (running at http://127.0.0.1:3100) using curl
- Create tasks, assign work, check status, and report back
- Keep messages concise — this is texting, not email

AgentDash API:
- Base URL: http://127.0.0.1:3100/api
- Auth: Use the PAPERCLIP_API_KEY from environment
- Create task: POST /companies/:companyId/issues
- List tasks: GET /companies/:companyId/issues
- Check agent status: GET /companies/:companyId/agents

When the CEO texts you:
1. Determine what they want
2. Take action via the API
3. Reply with a brief summary
EOF
```

**Step 6: Start the gateway (iMessage listener)**

```sh
hermes -p ceo gateway install  # Install as launchd service
hermes -p ceo gateway run      # Start in foreground for testing
```

**Step 7: Test**

From the customer's iPhone, text the Mac mini's phone number/Apple ID:
> "Hello, are you there?"

The CEO agent should respond within 10-15 seconds.

### What the Customer Gets

| Feature | How |
|---------|-----|
| Text the CEO to create tasks | "Add a task: follow up with Acme Corp" |
| Text to check status | "What's Marco working on?" |
| Text to assign work | "Have Sasha draft the Q3 marketing plan" |
| Text to pause/resume agents | "Pause all agents until Monday" |
| Receive proactive alerts | "Budget warning: 80% of monthly spend used" |
| Apple ecosystem integration | Notes, Reminders, Calendar (via hermes skills) |

---

## Part 4: Token Costs and Budget Controls

### If Using Claude Code Subscription (`claude_local`)

- **Cost:** Included in their Claude subscription ($20-200/mo per person)
- **Limits:** Plan-dependent usage caps (Pro: limited hours/week, Max: more, Teams: shared pool)
- **Tracking:** AgentDash shows $0 (Claude Code doesn't report per-call costs)
- **Budget control:** None from AgentDash — Claude's own limits are the only guardrail
- **Best for:** Getting started, light use, proving the concept

### If Using Anthropic API Key (`claude_api` with `ANTHROPIC_API_KEY`)

- **Sonnet 5 pricing (through Aug 31):** $2/M input, $10/M output
- **Sonnet 5 pricing (from Sep 1):** $3/M input, $15/M output
- **Haiku 4.5 (cheaper):** $1/M input, $5/M output
- **Tracking:** AgentDash records every call with exact token counts and costs
- **Budget control:** Full hard-stop enforcement

**Set a monthly budget cap:**
```sh
# $100/month company budget
curl -X PATCH http://127.0.0.1:3100/api/companies/:companyId/budgets \
  -H "Content-Type: application/json" \
  -d '{"budgetMonthlyCents": 10000}'
```

When spend hits the cap, AgentDash pauses all agents. No surprise bills.

**Set per-agent budgets:**
```sh
# $30/month for Marco
curl -X PATCH http://127.0.0.1:3100/api/agents/:agentId/budgets \
  -H "Content-Type: application/json" \
  -d '{"budgetMonthlyCents": 3000}'
```

### Estimated Monthly Cost (5 agents, moderate use)

| Setup | Monthly cost | Budget control |
|-------|-------------|----------------|
| Claude Code subscription (Pro) | $20/seat | Claude plan limits only |
| Claude API (Sonnet 5, 30-min heartbeat) | ~$50-150/mo | AgentDash hard-stop |
| Claude API (Haiku 4.5, 30-min heartbeat) | ~$15-50/mo | AgentDash hard-stop |
| Gemini CLI (free tier) | $0 | 1,000 requests/day cap |
| Local model (Gemma 4 12B via Ollama) | $0 | Hardware-limited |

---

## Part 5: Customer Quick Reference Card

### Daily Usage

| I want to... | Do this |
|-------------|---------|
| See what my agents are doing | Open `http://<ip>:3100/dashboard` |
| Create a task | Dashboard → "New Issue" → assign to agent |
| Talk to my CoS | Dashboard → `/cos` chat |
| Check task status | Dashboard → "Issues" |
| See what happened | Dashboard → "Activity" |
| Check spend | Dashboard → "Costs" |
| Pause an agent | Agents → click agent → "Pause" |

### Texting the CEO Agent (if iMessage is set up)

| Text this... | What happens |
|-------------|-------------|
| "Status" | Agent reports what all agents are working on |
| "Create task: <description>" | New task created and assigned |
| "What's <AgentName> doing?" | Status of specific agent |
| "Pause everything" | All agents paused |
| "Resume" | All agents resumed |

### If Something Breaks

| Problem | Fix |
|---------|-----|
| Dashboard won't load | `curl http://127.0.0.1:3100/api/health` — if down, `launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent` |
| Agents not working | Check Agent → "Test Environment" |
| CoS chat shows stub reply | Verify Claude Code is logged in: `claude --version` |
| iMessage agent not responding | `hermes -p ceo gateway status` then `hermes -p ceo gateway restart` |
| Costs too high | Set a budget cap (see Part 4) or increase heartbeat interval |

### Who to Contact

- **Bugs/issues:** File at github.com/thetangstr/agentdash/issues
- **AgentDash dashboard:** `http://<mac-mini-lan-ip>:3100`
- **Your team at AgentDash:** We monitor GitHub issues and respond within 30 minutes

---

## Part 6: Post-Install Checklist (For You, Before You Leave)

- [ ] AgentDash health check passes
- [ ] Customer can sign up and log in
- [ ] CoS onboarding completed (agents created)
- [ ] At least one agent tested (wakeup run succeeded)
- [ ] Budget set (if using API billing)
- [ ] iMessage CEO agent tested (if installing hermes)
- [ ] Customer knows how to create tasks
- [ ] Customer knows how to file issues on GitHub
- [ ] Customer has the Quick Reference Card
- [ ] `DISABLE_AUTOUPDATER=1` set in env
- [ ] Readiness script run: `scripts/msp-mac-mini-readiness.sh`
- [ ] Backup verified: `~/.agentdash/instances/default/data/backups/`
