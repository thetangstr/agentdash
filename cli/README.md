# AgentDash (AgentDash)

**AI agent orchestration for the real world.**

AgentDash is an enterprise-grade AI agent orchestration platform. Deploy it on your own infrastructure, plug it into your existing workflows, and let AI agent teams drive measurable business outcomes — with human oversight at every level.

Forked from [Paperclip](https://github.com/paperclipai/paperclip) and extended with Agent Factory, AutoResearch, human-agent collaboration, and security-first design.

## What Makes AgentDash Different

| Capability | Description |
|-----------|-------------|
| **Contextual Onboarding** | AgentDash learns your company — domain, goals, workflows, terminology — before deploying a single agent |
| **Agent Factory** | Dynamically spawn, configure, and retire agents. Agent leaders scale teams up to meet deadlines |
| **AutoResearch** | Hypothesis-driven experiment loops tied to measurable goals. Build, measure, learn — automatically |
| **Human-Agent Collaboration** | Agents work inside your existing tools — Slack, GitHub, Jira, not just a separate dashboard |
| **Security & Boundaries** | Policy engine, runtime sandboxing, permission boundaries, kill switches, audit trails |
| **Smart Budgets** | Hierarchical budgets with forecasting, ROI tracking, and multi-resource accounting |
| **Skills Registry** | Versioned, reviewable, composable skills with human approval workflows |
| **BYOT** | Bring Your Own Tokens — your API keys, your infrastructure, your data stays yours |

## Quickstart

```bash
git clone <your-agentdash-repo-url>
cd agentdash
pnpm install
pnpm dev
```

This starts the API + UI at `http://localhost:3100` with an embedded PostgreSQL database. No external setup required.

> **Requirements:** Node.js 20+, pnpm 9.15+

## Deployment

### Self-Hosted (Recommended)
Run on your own hardware or cloud. Your data never leaves your network.

```bash
docker compose up -d
```

### Configuration
See [doc/DEVELOPING.md](doc/DEVELOPING.md) for the full development guide.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical architecture, including:
- Deployment models (single-tenant vs multi-tenant)
- Agent Factory design
- AutoResearch engine
- Security & policy engine
- Upstream sync strategy

## Development

```bash
pnpm dev              # Full dev (API + UI, watch mode)
pnpm build            # Build all
pnpm typecheck        # Type checking
pnpm test:run         # Run tests
pnpm db:generate      # Generate DB migration
pnpm db:migrate       # Apply migrations
```

## Upstream

AgentDash tracks [paperclipai/paperclip](https://github.com/paperclipai/paperclip) as an upstream remote. Community improvements flow in; our extensions are built as additive layers to minimize merge conflicts.

## License

MIT
