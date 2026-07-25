# MKThink Launch — On-Site Operating Procedure

**Customer:** MKThink (mkthink.com)
**Date:** Monday, July 28, 2026
**You:** Eddy (on-site)
**Support:** Aria (remote, monitoring GitHub issues)
**Deployment:** On-prem Mac mini, 6-month free trial, BYOT

---

## Before You Arrive (Sunday Night)

### Pre-Stage These Files on a USB or AirDrop

```
doc/customers/mkthink/
├── agentdash.env.template     # Pre-filled env config
├── 01-welcome.md              # Customer welcome guide
├── 02-daily-usage.md          # How to use AgentDash
├── 03-troubleshooting.md      # Self-service fixes
├── 04-ceo-agent-imessage.md   # iMessage setup guide
└── 05-admin-reference.md      # Admin commands reference
welcome/
└── index.html                 # Welcome site (bookmark on their browser)
```

### Print or AirDrop the Quick Reference Card

One page: dashboard URL, key commands, support contact, what to expect.

### Generate Fresh Secrets (on your laptop, copy to their env file)

```sh
openssl rand -hex 32  # → BETTER_AUTH_SECRET
openssl rand -hex 32  # → PAPERCLIP_AGENT_JWT_SECRET
```

Fill these into `agentdash.env.template` before you arrive.

---

## On-Site Timeline (90 Minutes Total)

### Phase 1: Discovery (15 min) — Understand MKThink

**Before touching any technology, ask these questions:**

1. **"What does MKThink do?"** — MKThink is a strategy, design, and innovation firm. They solve complex problems for organizations. Understand their actual work before proposing agents.

2. **"What are the top 3 repetitive tasks your team spends time on?"** — This determines what agents to propose.

3. **"Who will be the primary user?"** — The person who will interact with agents most. Get their name, email, and phone number.

4. **"Do you have an Anthropic API key, or just Claude Code?"** — Determines adapter choice (see decision tree below).

5. **"Is this Mac mini always on? Does it restart overnight?"** — Confirms launchd is the right service manager.

6. **Point at their Mac mini:** "This will run 24/7 as the AgentDash server. It'll be accessible from any device on your network."

### Phase 2: Install (20 min)

```sh
# 1. Verify prerequisites
node --version    # Must be 20+
pnpm --version    # Must be 9+
which claude      # If they have Claude Code
which git

# 2. Clone AgentDash
git clone https://github.com/thetangstr/agentdash.git ~/agentdash
cd ~/agentdash
pnpm install
pnpm build

# 3. Install as service
./docker/launchd/install.sh

# 4. Copy in the pre-filled env file
cp /path/to/agentdash.env.template ~/.config/agentdash/agentdash.env

# 5. Fill in any remaining <PLACEHOLDERS> — the Mac mini IP
nano ~/.config/agentdash/agentdash.env
# Replace <MKTHINK-MAC-MINI-IP> with the actual IP (run `ipconfig getifaddr en0`)

# 6. Restart
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
sleep 5

# 7. Health check
curl -fsS http://127.0.0.1:3100/api/health
```

**If it fails:** Check `~/.agentdash/logs/agentdash.err` for errors. Most common issues:
- Port 3100 taken: check `lsof -i :3100`
- Missing migrations: the installer should auto-apply; if not, add `PAPERCLIP_MIGRATION_AUTO_APPLY=true`
- Node version: must be 20+, the installer bundles its own but verify

### Phase 3: CoS Onboarding (15 min) — Do This Together

1. **Open the dashboard** from another computer: `http://<mac-mini-ip>:3100`

2. **Have the primary user sign up** with their work email.

3. **Walk through the CoS conversation together.** The Chief of Staff will ask about their company. Guide them:

   > "Tell the CoS what MKThink does. Something like: 'MKThink is a strategy and innovation consultancy. We help organizations solve complex problems through design thinking, research, and technology.'"

4. **The CoS will propose a team of agents.** Review them together. Typical proposal for a consultancy:
   - Research Agent — compiles competitive analysis, market research
   - Content Agent — drafts proposals, reports, client communications
   - Operations Agent — manages project tracking, status reports
   - Client Success Agent — monitors client deadlines, sends reminders

5. **Approve the plan.** The agents get created with the configured adapter type.

6. **Create the first real task together.** Something useful:
   > "Research our top 5 competitors and create a summary document"
   
   Assign it to the Research Agent. Watch the status change from `idle` to `running`.

### Phase 4: Set Budgets + Verify (10 min)

**If using API billing (recommended):**

```sh
# Set $100/month company budget
curl -X PATCH http://127.0.0.1:3100/api/companies/:companyId/budgets \
  -H "Content-Type: application/json" \
  -d '{"budgetMonthlyCents": 10000}'
```

Show them: "When agents spend $100 in a month, they auto-pause. No surprise bills."

**Verify the first agent run completes:**
1. Dashboard → Agents → click the agent that got the task
2. Check "Runs" tab — should show a running or completed run
3. Click the run → see the transcript of what the agent did

### Phase 5: iMessage CEO Agent Setup (20 min — Optional, If Time Permits)

**This is the wow moment.** Set up hermes + imsg so the primary user can text their CEO agent from their iPhone.

```sh
# 1. Install the agent Agent
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

# 2. Configure with Claude (or whatever provider they use)
hermes setup
# Select: Claude → Sonnet → log in with their account

# 3. Install imsg (iMessage bridge)
brew install steipete/tap/imsg

# 4. Grant Full Disk Access
# System Settings → Privacy & Security → Full Disk Access → add Terminal

# 5. Create CEO profile
hermes profile create ceo
hermes -p ceo model  # Confirm model is set

# 6. Write the CEO agent instructions
# (Copy from doc/customers/mkthink/04-ceo-agent-imessage.md)

# 7. Start the gateway
hermes -p ceo gateway install
hermes -p ceo gateway run

# 8. TEST: From the primary user's iPhone, text the Mac mini's number
# "Hello, are you there?"
# The CEO agent should respond within 15 seconds.
```

**If imsg/iMessage doesn't work on-site:** Skip it. Leave the setup guide with them and schedule a follow-up to do it remotely. The dashboard works fine without iMessage.

### Phase 6: Handoff (10 min)

1. **Bookmark the dashboard** on the primary user's browser: `http://<mac-mini-ip>:3100`

2. **Show them the Quick Reference Card** — daily usage, texting commands, troubleshooting.

3. **Walk through one complete cycle:**
   - Create a task → assign → agent picks it up → result appears
   - Check the dashboard → see what agents are doing
   - Check activity log → see the audit trail

4. **Give them the welcome site URL** — all docs, guides, and resources.

5. **Set expectations:**
   > "Agents run on a schedule — they check for work every 30 minutes by default. They won't respond instantly like ChatGPT. Think of them as employees who check their inbox regularly. If you need something urgent, create a high-priority task and it'll be picked up faster."

6. **Tell them about support:**
   > "File issues at github.com/thetangstr/agentdash/issues. Our team monitors them every 30 minutes during business hours. For emergencies, text [your number]."

---

## Adapter Decision Tree (Use During Discovery)

```
Do they have an Anthropic API key?
├── YES → Use claude_api
│         ├── Full cost tracking in dashboard
│         ├── Budget hard-stop enforcement
│         ├── Sonnet 5 at $2/$10 per million tokens (through Aug 31)
│         └── This is the recommended path
│
└── NO → Do they have Claude Code (subscription)?
    ├── YES → Use claude_local as starting point
    │         ├── Works today, uses their subscription
    │         ├── No cost tracking (dashboard shows $0)
    │         ├── Risk: Anthropic may restrict non-interactive usage
    │         └── Transition to claude_api when they get an API key
    │
    └── NO → Install Ollama + Gemma 4 12B (free, local)
              ├── $0/month, no external dependency
              ├── Model quality lower than Claude
              ├── No rate limits
              └── Good enough for research, drafting, simple tasks
```

---

## Post-Install Checklist (Before You Leave)

- [ ] Health check passes (`curl http://127.0.0.1:3100/api/health`)
- [ ] Primary user can log in from their computer
- [ ] CoS onboarding completed — agents created
- [ ] First real task assigned and picked up by an agent
- [ ] Budget set (if using API billing)
- [ ] iMessage CEO agent tested (if installed)
- [ ] Primary user has bookmarked the dashboard
- [ ] Primary user has the Quick Reference Card
- [ ] Primary user knows how to file issues on GitHub
- [ ] `DISABLE_AUTOUPDATER=1` set in env (if using claude_local)
- [ ] Readiness script run: `scripts/msp-mac-mini-readiness.sh`
- [ ] You've texted Aria that the install is complete

---

## What Aria Does During the Install (Remote)

While you're on-site, Aria:
1. Monitors github.com/thetangstr/agentdash/issues for any issues filed
2. Stands by for Slack/phone if you need engineering help
3. Pushes hotfixes if something breaks during install
4. Records the customer info in the AgentDash company dashboard
