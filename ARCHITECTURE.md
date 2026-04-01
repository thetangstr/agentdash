# AgentDash Architecture

**AgentDash is an AI agent orchestration platform built for real companies.**

Forked from [Paperclip](https://github.com/paperclipai/paperclip), AgentDash extends the control plane with enterprise features: dynamic agent scaling, human-agent collaboration, security boundaries, CRM integration, and budget management.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Board Operator (Human)                       │
│                    Daily dashboard, approvals, oversight             │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     AgentDash Control Plane                         │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ Agent    │ │ Security │ │   CRM    │ │  Budget  │ │  Skills  │ │
│  │ Factory  │ │ & Policy │ │ Pipeline │ │ & Costs  │ │ Registry │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ Pipeline │ │  Action  │ │Execution │ │ Operator │ │  Auto    │ │
│  │Orchestr. │ │Proposals │ │Workspaces│ │   Feed   │ │ Research │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                           │
│  │Onboarding│ │  Task    │ │ Capacity │                           │
│  │  Engine  │ │   DAG    │ │ Planning │                           │
│  └──────────┘ └──────────┘ └──────────┘                           │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              Paperclip Core (inherited)                      │   │
│  │  Agents · Issues · Approvals · Heartbeat · Routines · Costs │   │
│  │  Activity Log · Org Chart · Plugin System · WebSocket       │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
         ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
         │ Claude │ │OpenCode│ │ Cursor │ │ Codex  │ │Gemini  │
         └────────┘ └────────┘ └────────┘ └────────┘ └────────┘
         ┌────────┐ ┌────────┐ ┌────────┐
         │   Pi   │ │OpenClaw│ │ Hermes │
         └────────┘ └────────┘ └────────┘
                        Agent Runtimes
```

---

## Tech Stack

| Layer | Technology | Entry Point |
|-------|-----------|-------------|
| API Server | Express 5, WebSocket | `server/src/index.ts` |
| Dashboard UI | React 19, Vite, Tailwind 4 | `ui/src/main.tsx` |
| CLI | Commander, esbuild | `cli/src/index.ts` |
| Database | PostgreSQL, Drizzle ORM | `packages/db/src/schema/` |
| Shared Types | Zod validators, constants | `packages/shared/src/` |
| Agent Adapters | Claude, Codex, OpenCode, Cursor, Gemini, Pi, OpenClaw, Hermes | `packages/adapters/` |
| Plugin System | JSON-RPC workers, event bus | `packages/plugins/` |
| Testing | Vitest (775 tests), bash CUJ suite (60 tests) | `vitest.config.ts`, `scripts/test-cujs.sh` |
| Deployment | Docker Compose, nginx | `docker-compose.yml`, `docker/nginx.conf` |

---

## Monorepo Structure

```
agentdash/
├── server/                    # Express API server
│   └── src/
│       ├── routes/            # HTTP route handlers (39 route files)
│       ├── services/          # Business logic (83 service files)
│       ├── middleware/        # Auth, logging, error handling
│       ├── auth/              # BetterAuth integration
│       ├── realtime/          # WebSocket handling
│       └── __tests__/         # Vitest tests (148 files)
├── ui/                        # React dashboard
│   └── src/
│       ├── pages/             # Route-level page components (62 pages)
│       ├── components/        # Shared UI components (94 components)
│       ├── adapters/          # UI adapter implementations (12)
│       ├── api/               # API client functions
│       ├── context/           # React context providers
│       └── hooks/             # Custom React hooks
├── cli/                       # CLI tool (`agentdash`)
├── packages/
│   ├── db/                    # Drizzle schema + migrations (60 migrations, 86 schema files)
│   ├── shared/                # Constants, types, validators
│   ├── adapters/              # Agent runtime adapters (7 packages)
│   │   ├── claude-local/
│   │   ├── codex-local/
│   │   ├── opencode-local/
│   │   ├── cursor-local/
│   │   ├── gemini-local/
│   │   ├── pi-local/
│   │   └── openclaw-gateway/
│   └── plugins/               # Plugin SDK + runtime + integrations
├── doc/                       # Documentation
│   └── maw/                   # Multi-Agent Workflow docs
├── scripts/                   # Dev scripts, CUJ tests, seeding (17 scripts)
├── .claude/commands/          # MAW slash commands (7 commands)
├── docker/                    # Nginx config, smoke tests
└── website/                   # Marketing site
```

---

## Database Schema

**60 migrations (0000-0059), 86 schema files** across these domains:

### Core (Paperclip inherited)
- `companies`, `agents`, `issues`, `projects`, `goals`
- `approvals`, `cost_events`, `activity_log`
- `routines`, `plugins`, `secrets`
- `board_users`, `board_api_keys`

### Agent Factory
- `agent_templates` — Role-based blueprints for spawning agents
- `spawn_requests` — Requests to create agents (linked to approvals)
- `agent_okrs` — Objectives per agent
- `agent_key_results` — Key results tracking

### Security & Policy
- `security_policies` — Declarative rules (action_limit, resource_access, etc.)
- `policy_evaluations` — Audit log of policy checks
- `kill_switch_events` — Halt/resume events
- `agent_sandboxes` — Per-agent isolation configuration

### CRM
- `crm_accounts` — Customer accounts
- `crm_contacts` — People at accounts
- `crm_deals` — Pipeline deals with stages
- `crm_leads` — Inbound leads with conversion flow
- `crm_partners` — Partner relationships
- `crm_activities` — Notes, calls, emails tied to accounts/deals

### AutoResearch
- `research_cycles` — Goal-linked research iterations
- `hypotheses` — Testable hypotheses
- `experiments` — Experiments with budget caps and time limits
- `metric_definitions` — What to measure
- `measurements` — Recorded data points
- `evaluations` — Verdict on hypotheses (validated/invalidated/inconclusive)

### Budget & Capacity
- `departments` — Organizational units with hierarchy
- `budget_allocations` — Scoped budget assignments
- `budget_forecasts` — Projected spend and exhaustion dates
- `resource_usage_events` — Non-LLM resource tracking

### Skills
- `skill_versions` — Versioned skill content with review workflow
- `skill_dependencies` — Skill composition graph
- `skill_usage_events` — Usage analytics

### Pipelines & Execution
- `agent_pipelines` — Multi-stage agent pipeline definitions
- `execution_workspaces` — Runtime execution environments
- `workspace_runtime_services` — Per-workspace runtime services
- `workspace_operations` — Operation audit log
- `workspace_operation_log_store` — Structured log storage
- `heartbeat_runs` — Heartbeat execution records
- `heartbeat_run_events` — Per-run event timeline

### Onboarding
- `onboarding_sessions` — Guided setup sessions
- `onboarding_sources` — Ingested company documents
- `company_context` — Extracted structured company knowledge

### Plugins
- `plugins` — Plugin registry
- `plugin_config` — Plugin configuration
- `plugin_company_settings` — Per-company plugin settings
- `plugin_entities` — Plugin entities
- `plugin_state` — Plugin state storage
- `plugin_webhooks` — Webhook subscriptions
- `plugin_jobs` — Job queue
- `plugin_logs` — Plugin logging

---

## Service Architecture

Each domain has a service factory that takes a `Db` instance and returns an object of async methods:

```typescript
// server/src/services/crm.ts
export function crmService(db: Db) {
  return {
    createAccount: async (companyId, data) => { ... },
    listAccounts: async (companyId, opts) => { ... },
    getPipelineSummary: async (companyId) => { ... },
    // ...
  };
}
```

### Services (83 service files)

**AgentDash Domain Services:**

| Service | Description |
|---------|-------------|
| `agent-factory` | Templates, spawn requests, OKRs |
| `policy-engine` | Security policies, kill switch, sandboxes |
| `crm` | Accounts, contacts, deals, leads, partners, activities |
| `crm-lifecycle` | CRM lifecycle stage management, fire-and-forget hooks |
| `hubspot` | Bidirectional HubSpot sync, webhook, config |
| `hubspot-sync-scheduler` | Hourly auto-sync scheduler |
| `autoresearch` | Research cycles, hypotheses, experiments, evaluations |
| `budgets` / `budget-forecasts` | Departments, allocations, forecasts, resource usage |
| `capacity-planning` | Workforce snapshot, pipeline, availability |
| `skills-registry` / `company-skills` | Versions, dependencies, review workflow |
| `skill-analytics` | Usage tracking and aggregation |
| `onboarding` | Sessions, sources, context extraction, team suggestion |
| `task-dependencies` | DAG, cycle detection, auto-unblock |
| `pipeline-orchestrator` | Multi-stage agent pipelines with auto-advance |
| `action-proposals` | Action proposal generation with policy evaluation |
| `feed` | Personalized priority-ranked operator feed |
| `prompt-builder` | Context assembly for agent heartbeats |
| `dashboard` | Morning briefing aggregation |
| `finance` | Financial metrics and summaries |
| `goals` | Goal hierarchy management |
| `execution-workspaces` | Workspace lifecycle, runtime config |
| `workspace-runtime` | Runtime service supervision |

**Paperclip Core Services:** agents, issues, projects, approvals, activity, costs, secrets, assets, documents, routines, heartbeat, cron, access, board-auth, company-portability

**Plugin System Services (15 files):** loader, registry, lifecycle, manifest/capability/config validators, event bus, stream bus, job store/scheduler/coordinator, tool dispatcher/registry, worker manager, host services, state store

---

## Route Architecture

Routes are Express routers mounted under `/api` in `server/src/app.ts`. Every route enforces company-scoped access:

```typescript
// server/src/routes/crm.ts
export function crmRoutes(db: Db) {
  const router = Router();
  const svc = crmService(db);

  router.post("/companies/:companyId/crm/accounts", async (req, res) => {
    assertCompanyAccess(req, companyId);
    const result = await svc.createAccount(companyId, req.body);
    res.status(201).json(result);
  });

  return router;
}
```

**200+ API endpoints** across 39 route files.

---

## Authentication & Authorization

| Mode | Behavior |
|------|----------|
| `local_trusted` | No auth required (development) |
| `authenticated` | BetterAuth sessions for humans, SHA-256 API keys for agents, JWT for local processes |

Authorization checks:
- `assertBoard(req)` — Requires human board operator
- `assertCompanyAccess(req, companyId)` — Verifies actor belongs to company
- `assertInstanceAdmin(req)` — Instance-level admin check

---

## Agent Runtime

Agents connect via adapters that bridge the control plane to LLM runtimes:

```
Heartbeat Scheduler (30s interval)
  → Check for assigned tasks
  → Build prompt (skills + context + task)
  → Call adapter (Claude Code, OpenCode, Cursor, etc.)
  → Capture output + cost
  → Log activity
  → Process task completion (auto-unblock dependents)
```

Supported adapters: `claude_local`, `codex_local`, `opencode_local`, `cursor_local`, `gemini_local`, `pi_local`, `openclaw_gateway`, `hermes_local`, `http`, `process`

---

## Integration Architecture

### HubSpot (Fully Operational)
```
AgentDash ←→ HubSpot API
  - Contacts sync (bidirectional)
  - Companies sync (bidirectional)
  - Deals sync (bidirectional)
  - Activities sync (AgentDash → HubSpot)
  - Webhook receiver (HMAC-SHA256 verified)
  - Hourly auto-sync scheduler
```

### Plugin System (Inherited from Paperclip)
- JSON-RPC worker protocol (15 plugin service files)
- Event bus for lifecycle hooks
- Plugin UI routes (iframe sandboxed)
- Scoped secrets management
- Built-in integrations: GitHub, HubSpot, Linear, Slack
- 4 example plugins included

---

## Multi-Agent Workflow (MAW)

AgentDash includes a Multi-Agent Workflow system with specialized slash commands for development:

| Agent | Command | Role |
|-------|---------|------|
| PM | `/pm` | Elaborate requirements, size issues, define test plans |
| Builder | `/builder` | Implement features, add tests, create PRs |
| Tester | `/tester` | E2E tests, code review, Chrome CUJ verification |
| TPM | `/tpm` | Project planning, sole merge authority to `main` |
| Admin | `/admin` | Ops-only health, deploy, environment checks |

Full workflow: `/workon AD-123` routes through PM → Builder → Tester pipeline.

See `doc/maw/sop.md` for the standard operating procedure and `doc/maw/protocol.md` for agent handoff protocol.

---

## Deployment

### Development
```bash
pnpm dev  # Embedded PG, hot reload, localhost:3100
```

### Docker
```bash
docker compose up -d  # PostgreSQL + server, port 3100
```

### Production (Cloud VM)
```bash
# 1. Docker Compose or bare metal install
# 2. nginx reverse proxy (docker/nginx.conf template provided)
# 3. SSL via Let's Encrypt
# 4. Firewall: only port 443 inbound
# 5. Bootstrap admin: pnpm agentdash auth bootstrap-ceo
```

### Environment Variables
See `.env.example` for all configuration options including:
- `BETTER_AUTH_SECRET` (required for authenticated mode)
- `ANTHROPIC_API_KEY` (optional, enables LLM-powered onboarding)
- `PAPERCLIP_DEPLOYMENT_MODE` (local_trusted / authenticated)
- `PAPERCLIP_DEPLOYMENT_EXPOSURE` (private / public)

---

## Upstream Sync

Paperclip tracked as `upstream` remote. AgentDash extensions are built as additive layers (new files, new tables, clearly marked sections in shared files) to minimize merge conflicts:

```bash
git checkout agentdash-upstream-sync
git fetch upstream && git merge upstream/master
# test, resolve conflicts
git checkout agentdash-main && git merge agentdash-upstream-sync
```
