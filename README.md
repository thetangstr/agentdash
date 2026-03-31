# AgentDash

**Your AI workforce, at a glance.**

AgentDash is an AI agent orchestration platform that lets companies deploy, manage, and scale AI agent workforces with human oversight. Deploy on your own infrastructure, plug into your existing CRM and workflows, and manage everything from a single dashboard.

Built on [Paperclip](https://github.com/paperclipai/paperclip). Extended with Agent Factory, CRM integration, security policies, budget management, and more.

---

## Quickstart

```bash
# Option 1: npx (recommended for new installs)
npx agentdash onboard

# Option 2: From source
git clone https://github.com/thetangstr/agentdash.git
cd agentdash
pnpm install
pnpm dev
```

Open `http://localhost:3100`. Embedded PostgreSQL starts automatically — no external setup needed.

> **Requirements:** Node.js 20+, pnpm 9.15+

---

## What You Can Do Today

| Capability | Status |
|-----------|--------|
| Deploy agents from templates (Agent Factory) | Operational |
| Morning dashboard with attention items | Operational |
| CRM pipeline (accounts, contacts, deals, leads, partners) | Operational |
| HubSpot bidirectional sync | Operational |
| Security policies & kill switch | Operational |
| Task dependencies with auto-unblocking | Operational |
| Agent OKRs and key results | Operational |
| Pipeline orchestrator (multi-stage agent workflows) | Operational |
| Action proposals with policy engine evaluation | Operational |
| Personalized operator feed | Operational |
| Research cycles (hypotheses, experiments, evaluations) | Operational |
| Budget tracking and capacity planning | Operational |
| Versioned skills with review workflow | Operational |
| Execution workspaces with runtime service management | Operational |
| Guided onboarding with LLM-powered context extraction | Operational |
| Multi-Agent Workflow (MAW) slash commands | Operational |

See [doc/CUJ-STATUS.md](doc/CUJ-STATUS.md) for detailed status of all 10 Critical User Journeys.

---

## Deploy on Another Machine

### Option A: npx (fastest)

On any machine with Node.js 20+:

```bash
npx agentdash onboard    # Interactive setup wizard
npx agentdash run         # Start the server
```

This handles everything: downloads the CLI, sets up embedded PostgreSQL, configures auth, and starts serving on `http://localhost:3100`.

### Option B: Docker Compose

```bash
# Generate a secret for session signing
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)

# Start PostgreSQL + AgentDash
docker compose up -d

# Bootstrap the first admin account
docker compose exec server pnpm agentdash auth bootstrap-ceo
```

AgentDash is now running at `http://localhost:3100`.

### Option C: Production (Cloud VM)

For production, add an nginx reverse proxy with SSL:

```bash
# 1. Start AgentDash via Docker or npx
npx agentdash onboard --yes
npx agentdash run

# 2. Copy and configure the nginx template
sudo cp docker/nginx.conf /etc/nginx/sites-available/agentdash
# Edit: replace YOUR_DOMAIN, set cert paths
sudo ln -s /etc/nginx/sites-available/agentdash /etc/nginx/sites-enabled/
sudo certbot --nginx -d your.domain
sudo nginx -t && sudo systemctl reload nginx

# 3. Bootstrap admin account
npx agentdash auth bootstrap-ceo
```

See [doc/SOP-deployment.md](doc/SOP-deployment.md) for the full deployment playbook.

---

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | No | Leave unset for embedded PG |
| `BETTER_AUTH_SECRET` | Yes (prod) | Session signing secret |
| `PAPERCLIP_DEPLOYMENT_MODE` | No | `local_trusted` (dev) or `authenticated` (prod) |
| `ANTHROPIC_API_KEY` | No | Enables LLM-powered onboarding features |

See `.env.example` for the full list with descriptions.

---

## Development

```bash
pnpm dev              # API + UI with hot reload
pnpm -r typecheck     # Type-check all packages
pnpm test:run         # Run 775 Vitest tests
pnpm build            # Build all packages
pnpm db:generate      # Generate migration after schema changes
pnpm db:migrate       # Apply pending migrations
```

### CUJ Integration Tests

```bash
# Start the server first, then in another terminal:
bash scripts/test-cujs.sh          # 60 end-to-end API tests
bash scripts/seed-test-scenarios.sh # Seed 2 demo companies
```

### Verification (run before PRs)

```bash
pnpm -r typecheck && pnpm test:run && pnpm build
```

---

## Architecture

```
Board Operator (Human)
        │
        ▼
AgentDash Control Plane
  ├── Agent Factory (templates, spawning, OKRs)
  ├── Security & Policy (policies, kill switch, sandboxes)
  ├── Pipeline Orchestrator (multi-stage agent workflows)
  ├── Action Proposals (policy evaluation, auto-approve/escalate/deny)
  ├── CRM Pipeline (accounts, deals, leads + HubSpot sync)
  ├── Feed Service (personalized operator activity feed)
  ├── Budget & Capacity (departments, forecasts, resource tracking)
  ├── Skills Registry (versioned, reviewed, composable)
  ├── AutoResearch (hypothesis → experiment → evaluate loops)
  ├── Execution Workspaces (runtime service management)
  ├── Onboarding Engine (LLM-powered context extraction)
  └── Paperclip Core (agents, issues, approvals, heartbeat, plugins)
        │
        ▼
Agent Runtimes (Claude, OpenCode, Cursor, Codex, Gemini, Pi, OpenClaw, Hermes)
```

**86 schema tables, 83 services, 200+ API endpoints, 62 UI pages.**

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical deep-dive.

---

## Key Documentation

| Doc | Purpose |
|-----|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Full system design, tech stack, schema |
| [doc/CUJ-STATUS.md](doc/CUJ-STATUS.md) | Feature status and test coverage |
| [doc/PRD.md](doc/PRD.md) | Product requirements, 10 CUJs |
| [doc/PRD-crm.md](doc/PRD-crm.md) | CRM product requirements |
| [doc/SOP-deployment.md](doc/SOP-deployment.md) | Deployment playbook for a 50-person company |
| [doc/BUSINESS-PLAN.md](doc/BUSINESS-PLAN.md) | Pricing, GTM, client engagement guide |
| [doc/DEVELOPING.md](doc/DEVELOPING.md) | Detailed development guide |
| [doc/maw/sop.md](doc/maw/sop.md) | Multi-Agent Workflow operating procedure |
| [doc/agentdash_adapter_strategy.md](doc/agentdash_adapter_strategy.md) | Adapter design strategy |
| [CLAUDE.md](CLAUDE.md) | AI coding assistant instructions |

---

## BYOT — Bring Your Own Tokens

AgentDash charges for orchestration, not AI usage. You bring your own LLM API keys (Anthropic, OpenAI, etc.) and your agents use your token budget. Your data stays on your infrastructure.

---

## Acknowledgements

AgentDash is built on [Paperclip](https://github.com/paperclipai/paperclip), the open-source AI agent control plane. We actively track upstream releases and contribute back where possible. Thank you to the Paperclip team for building the foundation that makes AgentDash possible.

- **Core engine**: Agent lifecycle, heartbeat, issue tracking, approvals, plugins, and execution workspaces are all Paperclip
- **What AgentDash adds**: Agent Factory, Pipeline Orchestrator, Action Proposals, CRM pipeline, HubSpot sync, Feed Service, security policies, budget/capacity management, skills registry, research cycles, execution workspaces, guided onboarding, and Multi-Agent Workflow (MAW) slash commands
- **Upstream sync**: We maintain a repeatable merge process (`scripts/upstream-sync.sh`) to stay current with Paperclip releases

---

## License

MIT — see [LICENSE](LICENSE) for details. Original copyright Paperclip AI.
