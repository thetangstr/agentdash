# AgentDash (AgentDash) Architecture

**AgentDash is an AI agent orchestration platform built for real companies.**

Forked from [Paperclip](https://github.com/paperclipai/paperclip), AgentDash extends the control plane concept with enterprise-grade features: dynamic agent scaling, human-agent collaboration, security boundaries, and integration with existing company infrastructure.

## How AgentDash Differs from Paperclip

| Area | Paperclip | AgentDash |
|------|-----------|--------|
| **Onboarding** | Server setup wizard | Contextual company discovery — learns your domain, goals, workflows |
| **Agent creation** | Manual, one-at-a-time | Agent Factory — dynamic spawning by humans or agent leaders |
| **Scaling** | Static workforce | Elastic — scale agents up/down based on deadlines and workload |
| **Human interaction** | Dashboard only | Integrated into Slack, GitHub, project management, existing workflows |
| **Research** | None | AutoResearch — hypothesis-driven experiment loops tied to goals |
| **Security** | API keys + sessions | Policy engine, runtime sandboxing, blast radius limits, kill switches |
| **Budget** | Monthly caps per agent | Hierarchical budgets, forecasting, ROI tracking, multi-resource |
| **Skills** | Injected markdown files | Versioned registry with human review, composition, analytics |
| **Deployment** | Local-first | Baremetal, cloud, Docker, Kubernetes — BYOT (bring your own tokens) |
| **Tenancy** | Single operator | Single-tenant self-hosted or multi-tenant SaaS |

## Deployment Models

### Single-Tenant (Primary)
A company runs AgentDash on their own infrastructure. Their data never leaves their network. They bring their own LLM API keys, database, and compute.

```
[Company Network]
  ├── AgentDash Control Plane (Docker / bare metal)
  ├── PostgreSQL (company-managed)
  ├── Agent Runtimes (containers)
  └── Integrations (Slack, GitHub, Jira, etc.)
```

### Multi-Tenant SaaS (Future)
We host it. Companies get isolated workspaces with the same BYOT model for API keys.

## Core Architecture

### Layer 1: Control Plane (inherited from Paperclip)
- Express REST API + WebSocket realtime
- React dashboard UI
- PostgreSQL via Drizzle ORM
- Agent registry, org charts, task management
- Cost tracking, approval gates, activity logging

### Layer 2: AgentDash Extensions

#### 2a. Contextual Onboarding Engine
Guided flow that produces a structured company profile:
1. **Discovery** — Ingest existing docs, learn domain/terminology/processes
2. **Scope** — Define operating mode (company / department / team / project)
3. **Goals** — Translate business objectives into measurable goal hierarchies
4. **Access** — Set up human overseers, approval chains, governance rules
5. **Agent Factory Bootstrap** — Suggest initial agent team based on scope and goals

#### 2b. Agent Factory
Dynamic agent workforce management:
- **Templates** — Role-based templates (Frontend Engineer, Growth Marketer, QA Lead)
- **Identity** — Each agent gets a persona, OKRs, KPIs, skill loadout, authority level
- **Spawning** — Humans or agent leaders request new agents; policy gates approve
- **Capacity Planning** — Estimate whether current workforce can meet deadlines
- **Lifecycle** — Spawn → Configure → Deploy → Monitor → Evaluate → Retire
- **Task Classification** — Deterministic (code, test) vs. stochastic (growth, sales) with different estimation models

#### 2c. AutoResearch Engine
Karpathy-style hypothesis-driven loops:
```
Define Hypothesis → Design Experiment → Execute → Measure → Evaluate → Iterate
```
- Tied to company goals with measurable success criteria
- Metrics integration layer (analytics, financial data, CI/CD, custom)
- Guardrails per experiment (max budget, max time, rollback triggers)
- Runs until success criteria met or budget exhausted

#### 2d. Integration Layer (Human-Agent Collaboration)
Agents as citizens of existing workflows:
- **Communication** — Slack, Teams, Discord, email
- **Code** — GitHub/GitLab PRs, code review, CI
- **Project Management** — Jira, Linear, Asana (bidirectional sync)
- **Docs** — Notion, Confluence, Google Docs
- **Interaction Patterns** — Async handoffs, sync collaboration, escalation, status reporting

#### 2e. Security & Policy Engine
- **Permission Model** — Resource, action, and data boundaries per agent
- **Runtime Isolation** — Containerized agent execution with network policies
- **Policy Engine** — Declarative policies evaluated before every action
- **Audit Trail** — Tamper-proof logging of all agent actions
- **Kill Switch** — Instant halt of any agent or all agents
- **Secrets Management** — BYOT key vault, scoped access, rotation support

#### 2f. Budget & Cost Management
- **Hierarchical Budgets** — Company → department → project → agent
- **Forecasting** — Burn rate projections and deadline cost estimates
- **ROI Tracking** — Cost-to-outcome correlation
- **Multi-Resource** — LLM tokens, compute hours, SaaS API costs
- **Alerts** — Configurable thresholds (50%, 75%, 90%) before hard stops

#### 2g. Skills Registry
- **Versioned Skills** — Git-like versioning with diff review
- **Human Review Workflow** — Skills go through approval before deployment
- **Composition** — Skills can depend on and combine other skills
- **Analytics** — Usage frequency, outcome correlation
- **Authoring** — Humans and agents can propose new skills

## Upstream Sync Strategy

AgentDash tracks Paperclip's `master` branch via the `upstream` remote:
- `agentdash-main` — Our main development branch
- `upstream-sync` — Dedicated branch for pulling and testing upstream changes
- New AgentDash features live in new packages/modules to minimize merge conflicts
- Core Paperclip files are modified only when necessary

## Tech Stack (inherited + extensions)

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+, TypeScript |
| API | Express 5, WebSocket |
| Database | PostgreSQL, Drizzle ORM |
| Frontend | React 19, Vite, Tailwind CSS 4 |
| Agent Runtimes | Docker containers, process adapters |
| Package Manager | pnpm (monorepo) |
| Testing | Vitest, Playwright |
| Deployment | Docker Compose, Helm (planned) |

## Project Structure

```
agentdash/
  ├── server/              # Express API (inherited + extended)
  ├── ui/                  # React dashboard (inherited + extended)
  ├── cli/                 # CLI tool (rebranded to `agentdash`)
  ├── packages/
  │   ├── shared/          # Shared types/validators (inherited)
  │   ├── db/              # Database schema (inherited + extended)
  │   ├── adapters/        # Agent adapters (inherited)
  │   ├── plugins/         # Plugin system (inherited)
  │   ├── agent-factory/   # [NEW] Dynamic agent spawning and management
  │   ├── autoresearch/    # [NEW] Hypothesis-driven experiment loops
  │   ├── integrations/    # [NEW] Slack, GitHub, Jira, etc.
  │   ├── policy-engine/   # [NEW] Security policies and enforcement
  │   └── skills-registry/ # [NEW] Versioned skill management
  ├── doc/                 # Documentation
  └── ARCHITECTURE.md      # This file
```
