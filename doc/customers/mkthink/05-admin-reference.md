# MKThink AgentDash — Admin Reference

Technical commands for managing the AgentDash server on the Mac mini.

---

## Server Management

```sh
# Health check
curl -fsS http://127.0.0.1:3100/api/health

# Restart server
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent

# Stop server
launchctl unload ~/Library/LaunchAgents/ai.agentdash.agent.plist

# Start server
launchctl load ~/Library/LaunchAgents/ai.agentdash.agent.plist

# Check if running
launchctl list | grep agentdash
```

---

## Logs

```sh
# Recent server logs (last 50 lines)
tail -50 ~/.agentdash/logs/agentdash.log

# Error logs
tail -50 ~/.agentdash/logs/agentdash.err

# Follow logs in real-time
tail -f ~/.agentdash/logs/agentdash.log
```

---

## Environment Configuration

```sh
# Edit the configuration file
nano ~/.config/agentdash/agentdash.env

# After any change, restart:
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
```

### Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `AGENTDASH_DEFAULT_ADAPTER` | LLM adapter: `claude_api`, `claude_local`, `openai_compat` |
| `ANTHROPIC_API_KEY` | Anthropic API key (for `claude_api`) |
| `PAPERCLIP_PUBLIC_URL` | The URL users access the dashboard from |
| `BETTER_AUTH_SECRET` | Session encryption key (never change after setup) |
| `AGENTDASH_DEPLOYMENT_KIND` | `on_prem` for this installation |
| `AGENTDASH_LICENSE_KEY` | Your license token |

---

## Database

### Backup
```sh
cd ~/agentdash
pnpm db:backup
```

Or use the readiness script with backup:
```sh
scripts/msp-mac-mini-readiness.sh --run-backup
```

### Reset (DESTRUCTIVE — loses all data)
```sh
rm -rf ~/.agentdash/instances/default/db
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
```

---

## Updating AgentDash

```sh
cd ~/agentdash
git fetch origin
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
sleep 5
curl -fsS http://127.0.0.1:3100/api/health
```

Record the new version:
```sh
git rev-parse HEAD
```

---

## Budget Management via API

```sh
# Set company monthly budget ($100 = 10000 cents)
curl -X PATCH http://127.0.0.1:3100/api/companies/:companyId/budgets \
  -H "Content-Type: application/json" \
  -d '{"budgetMonthlyCents": 10000}'

# Set per-agent budget ($30 = 3000 cents)
curl -X PATCH http://127.0.0.1:3100/api/agents/:agentId/budgets \
  -H "Content-Type: application/json" \
  -d '{"budgetMonthlyCents": 3000}'

# Check dashboard summary (spend, budget, utilization)
curl -s http://127.0.0.1:3100/api/companies/:companyId/dashboard
```

---

## Prevent Mac Mini Sleep

```sh
# Prevent sleep permanently
sudo pmset -a sleep 0 disksleep 0

# Or via System Settings:
# System Settings → Energy → "Prevent automatic sleeping" = ON
```

---

## Network Configuration

The server binds to the LAN by default. Accessible at `http://<mac-mini-ip>:3100`.

**Find the Mac mini's IP:**
```sh
ipconfig getifaddr en0    # WiFi
ipconfig getifaddr en1    # Ethernet
```

**Change allowed hostnames:**
```sh
# In agentdash.env
PAPERCLIP_ALLOWED_HOSTNAMES=192.168.1.100,my-mac-mini.local
```

**Tailscale access (recommended for remote access):**
```sh
# Install Tailscale
brew install tailscale
sudo tailscale up

# Then use the Tailscale IP in PAPERCLIP_PUBLIC_URL
```

---

## Readiness Check

Run this periodically to verify everything is healthy:

```sh
cd ~/agentdash
scripts/msp-mac-mini-readiness.sh \
  --base-url http://<mac-mini-ip>:3100 \
  --expected-company "MKThink" \
  | tee ~/mkthink-health-$(date +%Y%m%d).txt
```

The script checks:
- launchd service status
- Health endpoint
- Auth/deployment configuration
- Claude Code / adapter wiring
- Recent logs for errors
- Backup status
- Billing posture
