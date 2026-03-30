# AgentDash

**Your AI workforce, at a glance.**

AgentDash is an AI agent orchestration platform that lets companies deploy, manage, and scale AI agent workforces with human oversight. Deploy on your own infrastructure, plug into your existing CRM and workflows, and manage everything from a single dashboard.

Built on [Paperclip](https://github.com/paperclipai/paperclip). Extended with Agent Factory, CRM integration, security policies, budget management, and more.

---

## Quickstart

```bash
git clone <your-agentdash-repo-url>
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
| Research cycles (hypotheses, experiments, evaluations) | Operational |
| Budget tracking and capacity planning | Operational |
| Versioned skills with review workflow | Operational |
| Guided onboarding with LLM-powered context extraction | Operational |

See [doc/CUJ-STATUS.md](doc/CUJ-STATUS.md) for detailed status of all 10 Critical User Journeys.

---

## Deploy with Docker

```bash
# Generate a secret for session signing
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)

# Start PostgreSQL + AgentDash
docker compose up -d

# Bootstrap the first admin account
docker compose exec server pnpm agentdash auth bootstrap-ceo
```

AgentDash is now running at `http://localhost:3100`.

### Production Deployment

For production, add an nginx reverse proxy with SSL. A ready-to-use config template is provided:

```bash
# Copy and configure the nginx template
sudo cp docker/nginx.conf /etc/nginx/sites-available/agentdash
# Edit: replace YOUR_DOMAIN, set cert paths
sudo ln -s /etc/nginx/sites-available/agentdash /etc/nginx/sites-enabled/
sudo certbot --nginx -d your.domain
sudo nginx -t && sudo systemctl reload nginx
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
pnpm test:run         # Run 721 Vitest tests
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
  ├── CRM Pipeline (accounts, deals, leads + HubSpot sync)
  ├── Budget & Capacity (departments, forecasts, resource tracking)
  ├── Skills Registry (versioned, reviewed, composable)
  ├── AutoResearch (hypothesis → experiment → evaluate loops)
  ├── Onboarding Engine (LLM-powered context extraction)
  └── Paperclip Core (agents, issues, approvals, heartbeat, plugins)
        │
        ▼
Agent Runtimes (Claude, OpenCode, Cursor, Codex, Gemini, Pi)
```

**29 new database tables, 15 services, 120+ API endpoints, 10 UI pages.**

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical deep-dive.

---

## Key Documentation

| Doc | Purpose |
|-----|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Full system design, tech stack, schema |
| [doc/CUJ-STATUS.md](doc/CUJ-STATUS.md) | Feature status and test coverage |
| [doc/PRD.md](doc/PRD.md) | Product requirements, 10 CUJs |
| [doc/SOP-deployment.md](doc/SOP-deployment.md) | Deployment playbook for a 50-person company |
| [doc/BUSINESS-PLAN.md](doc/BUSINESS-PLAN.md) | Pricing, GTM, client engagement guide |
| [doc/DEVELOPING.md](doc/DEVELOPING.md) | Detailed development guide |
| [CLAUDE.md](CLAUDE.md) | AI coding assistant instructions |

---

## BYOT — Bring Your Own Tokens

AgentDash charges for orchestration, not AI usage. You bring your own LLM API keys (Anthropic, OpenAI, etc.) and your agents use your token budget. Your data stays on your infrastructure.

---

## License

MIT
