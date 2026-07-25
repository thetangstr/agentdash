You are setting up AgentDash for MKThink on this Mac mini. This is a production on-prem deployment.

Execute these steps IN ORDER. Stop and ask if anything fails.

## Step 1: Check Prerequisites
Run: `node --version && pnpm --version && git --version`
- Node must be 20+. If missing, install from nodejs.org.
- pnpm must be 9+. If missing: `npm install -g pnpm`
- git must be present. If missing: `brew install git`

## Step 2: Check Claude Code
Run: `which claude && claude --version`
- If installed, verify auth: `echo "Respond with hello" | claude --print -`
- If the output is not "hello" or similar, Claude needs to be re-authenticated. Run `claude` interactively and log in.
- If not installed: `npm install -g @anthropic-ai/claude-code` then `claude` to log in.
- CRITICAL: After install, pin version: `DISABLE_AUTOUPDATER=1` must be in the env file later.

## Step 3: Clone and Install AgentDash
```sh
git clone https://github.com/thetangstr/agentdash.git ~/agentdash
cd ~/agentdash
pnpm install
pnpm build
```

## Step 4: Install as macOS Service
```sh
cd ~/agentdash
./docker/launchd/install.sh
```
This creates `~/.config/agentdash/agentdash.env` and the launchd plist.

## Step 5: Get the Mac Mini's IP
Run: `ipconfig getifaddr en0 || ipconfig getifaddr en1`
Use this IP in the config below.

## Step 6: Generate Secrets
```sh
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
echo "PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32)"
```

## Step 7: Write the Environment File
Write this to `~/.config/agentdash/agentdash.env` (replace ALL <PLACEHOLDERS>):

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated
NODE_ENV=production
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_BIND=lan
PAPERCLIP_ALLOWED_HOSTNAMES=<IP_FROM_STEP_5>
PAPERCLIP_PUBLIC_URL=http://<IP_FROM_STEP_5>:3100
PAPERCLIP_API_URL=http://127.0.0.1:3100
PAPERCLIP_AUTH_BASE_URL_MODE=explicit
PAPERCLIP_AUTH_PUBLIC_BASE_URL=http://<IP_FROM_STEP_5>:3100
PAPERCLIP_MIGRATION_AUTO_APPLY=true
BETTER_AUTH_SECRET=<FROM_STEP_6>
PAPERCLIP_AGENT_JWT_SECRET=<FROM_STEP_6>
AGENTDASH_DEFAULT_ADAPTER=claude_local
DISABLE_AUTOUPDATER=1
AGENTDASH_DEPLOYMENT_KIND=on_prem
AGENTDASH_LICENSE_KEY=eyJjdXQifFAQ
AGENTDASH_LICENSE_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAaGK1po1qckt8YNbpn8TDXZBOVoTV+0D9RO7/KYG58Jw=
-----END PUBLIC KEY-----
```

If the customer has an Anthropic API key, also add:
```
AGENTDASH_DEFAULT_ADAPTER=claude_api
ANTHROPIC_API_KEY=<their-key>
```

## Step 8: Restart and Verify
```sh
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
sleep 8
curl -fsS http://127.0.0.1:3100/api/health
```
The health check must return `{"status":"ok"}`. If it fails, check `~/.agentdash/logs/agentdash.err`.

## Step 9: Prevent Mac Mini Sleep
```sh
sudo pmset -a sleep 0 disksleep 0
```

## Step 10: Open Dashboard Test
Tell the user to open `http://<IP_FROM_STEP_5>:3100` from their computer and sign up.
Then navigate to `/cos` and verify the CoS replies with a real Claude response (not a stub).

## Step 11: Set Budget (if using API key)
After the user completes onboarding and has a company ID, set a $100/mo budget:
```sh
curl -X PATCH http://127.0.0.1:3100/api/companies/<COMPANY_ID>/budgets \
  -H "Content-Type: application/json" \
  -d '{"budgetMonthlyCents": 10000}'
```

## DONE
Report: IP address, adapter used, whether CoS chat works, and any issues encountered.
