# MKThink — iMessage CEO Agent Setup

This guide sets up a the agent AI agent on the Mac mini that the primary user can text from their iPhone. The agent interacts with AgentDash to create tasks, check status, and manage the team — all through iMessage.

---

## How It Works

```
You text from iPhone → Messages.app → Mac mini (imsg)
  → the agent CEO agent reads it
  → Takes action via AgentDash API (create tasks, check status)
  → Replies via iMessage
  → You see the reply on your phone
```

No app to install on the iPhone. Just use Messages.app like texting a colleague.

---

## Prerequisites

- Mac mini with macOS (already running AgentDash)
- Messages.app signed in to an Apple ID on the Mac mini
- The primary user's iPhone must be able to iMessage the Mac mini's Apple ID / phone number
- Internet access for the LLM provider

---

## Installation (30 minutes)

### Step 1: Install the agent Agent

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Verify:
```sh
hermes --version
```

### Step 2: Configure the LLM Provider

```sh
hermes setup
```

Follow the wizard:
- Select model provider (recommend: Anthropic Claude Sonnet 5)
- Enter API key or log in with subscription
- Verify: `hermes chat -q "Say hello" -Q`

### Step 3: Install imsg (iMessage Bridge)

```sh
brew install steipete/tap/imsg
```

Verify:
```sh
imsg chats --limit 3 --json
```
Should show recent Messages.app conversations.

### Step 4: Grant Permissions

**Full Disk Access** (required for imsg to read Messages.app database):
1. System Settings → Privacy & Security → Full Disk Access
2. Click "+", add your terminal app (Terminal.app or iTerm)
3. Restart the terminal

**Automation Permission:**
- The first time imsg runs, macOS will prompt to allow automation of Messages.app
- Click "OK"

### Step 5: Create a the agent Profile for the CEO Agent

```sh
hermes profile create ceo
```

Configure its model:
```sh
hermes -p ceo model
# Select: Anthropic → Claude Sonnet 5 (or your preferred model)
```

### Step 6: Write the CEO Agent Instructions

Create the agent's instruction file:

```sh
cat > ~/.hermes/profiles/ceo/AGENTS.md << 'INSTRUCTIONS'
# MKThink CEO Agent

You are the Chief of Staff for MKThink, a strategy, design, and innovation consultancy.
You communicate with the MKThink team via iMessage text messages.

## Your Role
- Receive instructions via text message from the MKThink team
- Interact with AgentDash (running at http://127.0.0.1:3100) to manage work
- Create tasks, assign them to agents, check status, and report back
- Keep all responses concise — this is texting, not email

## AgentDash API
- Base URL: http://127.0.0.1:3100/api
- Company ID: <FILL_IN_AFTER_ONBOARDING>
- Authentication: Use PAPERCLIP_API_KEY from environment variables
- Create task: curl -s -X POST http://127.0.0.1:3100/api/companies/COMPANY_ID/issues -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" -d '{"title":"...", "description":"...", "priority":"medium"}'
- List tasks: curl -s http://127.0.0.1:3100/api/companies/COMPANY_ID/issues -H "Authorization: Bearer $PAPERCLIP_API_KEY"
- List agents: curl -s http://127.0.0.1:3100/api/companies/COMPANY_ID/agents -H "Authorization: Bearer $PAPERCLIP_API_KEY"

## When You Receive a Text
1. Understand what the person wants
2. Take the appropriate action (create task, query status, etc.)
3. Reply with a brief, helpful summary
4. If unclear, ask a clarifying question

## Tone
- Professional but conversational
- Concise — 1-3 sentences per reply
- Action-oriented — always do something, don't just acknowledge

## Example Interactions
User: "Status"
You: "3 agents idle, 1 running. Research Agent is 60% done on competitor analysis (started 2h ago). 2 tasks completed overnight. Budget: $12.50 / $100 this month."

User: "Create task: draft a proposal for the City of Oakland project"
You: "Created task MKT-12: 'Draft proposal for City of Oakland project' — assigned to Content Agent. It'll start within 30 min."

User: "How much have we spent?"
You: "$12.50 out of $100 budget this month. Research Agent: $8, Content Agent: $3, Operations: $1.50. You're at 12.5% — well within budget."
INSTRUCTIONS
```

### Step 7: Start the Gateway

Install as a persistent service:
```sh
hermes -p ceo gateway install
hermes -p ceo gateway start
```

Verify it's running:
```sh
hermes -p ceo gateway status
```

### Step 8: Test

From the primary user's iPhone:
1. Open Messages.app
2. Start a new conversation with the Mac mini's Apple ID or phone number
3. Send: "Hello, are you there?"

The CEO agent should respond within 10-15 seconds.

**If no response:**
- Check gateway is running: `hermes -p ceo gateway status`
- Check imsg can see messages: `imsg chats --json`
- Check Full Disk Access is granted
- Check Messages.app is signed in on the Mac mini
- Check logs: `~/.hermes/logs/gateway.log`

---

## What the Primary User Can Text

| Text | What happens |
|------|-------------|
| "Status" | Full team status report |
| "Create task: [description]" | New task created and assigned |
| "What's [Agent Name] doing?" | Specific agent status |
| "Pause all agents" | All agents paused |
| "Resume all agents" | All agents resumed |
| "How much have we spent?" | Budget and spend report |
| "Show me completed tasks" | List of done tasks from today |
| "Remind me to [action] on [date]" | Creates a scheduled reminder |

---

## Maintenance

**Restart the gateway if it stops:**
```sh
hermes -p ceo gateway restart
```

**Update the agent:**
```sh
hermes update
hermes -p ceo gateway restart
```

**Check logs:**
```sh
tail -30 ~/.hermes/logs/gateway.log
```

**Change the model:**
```sh
hermes -p ceo model
hermes -p ceo gateway restart
```
