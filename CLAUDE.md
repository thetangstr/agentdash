# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AgentDash — AI agent orchestration platform. Fork of [Paperclip](https://github.com/paperclipai/paperclip) with 86 schema tables, 83 services, 39 route modules, 62 UI pages, and 200+ API endpoints spanning: Agent Factory, Pipeline Orchestrator, Action Proposals, Task Dependencies, Security/Policy Engine, Budget/Capacity, Skills Registry, AutoResearch, CRM, Feed, Execution Workspaces, Onboarding, and HubSpot integration.

## Commands

```sh
pnpm install              # Install dependencies (use pnpm, NOT npm/yarn)
pnpm dev                  # Start server + UI with watch mode (localhost:3100)
pnpm dev:once             # Start without file watching
pnpm -r typecheck         # Type-check ALL packages
pnpm test:run             # Run all tests once (775 tests)
pnpm build                # Build all packages
pnpm db:generate          # Generate migration after schema changes
pnpm db:migrate           # Apply pending migrations
```

### Verification (run before claiming done)
```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

### CUJ integration tests
```sh
bash scripts/test-cujs.sh    # 60 end-to-end tests against live API
bash scripts/seed-test-scenarios.sh  # Seed 2 demo companies
```

## Multi-Agent Workflow

MAW commands are installed under `.claude/commands/` with supporting docs in `doc/multi-agent-workflow/`.

- Base branch for MAW PRs: `agentdash-main`
- Default issue prefix in examples: `PAP`
- Primary entry point: `/workon PAP-123`
- Shipping command: `/tpm sync`

Staging and production steps still contain explicit `TODO_SET_*` placeholders for environment URLs and test credentials. Fill those before using the deploy/admin flows.

## Architecture

**Monorepo** (pnpm workspaces): `server/`, `ui/`, `cli/`, `packages/*`

| Layer | Tech | Entry Point |
|-------|------|-------------|
| API Server | Express 5, WebSocket | `server/src/index.ts` |
| Dashboard UI | React 19, Vite, Tailwind 4 | `ui/src/main.tsx` |
| CLI | Commander, esbuild | `cli/src/index.ts` |
| Database | PostgreSQL, Drizzle ORM | `packages/db/src/schema/` |
| Shared Types | Zod validators, constants | `packages/shared/src/` |
| Agent Adapters | Claude, Codex, Cursor, Gemini, Pi, OpenCode, OpenClaw | `packages/adapters/` |
| Plugins | JSON-RPC workers, event bus | `packages/plugins/` |

### Service pattern
```typescript
// server/src/services/*.ts
export function myService(db: Db) {
  return {
    list: async (companyId: string) => { ... },
    create: async (companyId: string, data: ...) => { ... },
  };
}
```

### Route pattern
```typescript
// server/src/routes/*.ts
export function myRoutes(db: Db) {
  const router = Router();
  const svc = myService(db);
  router.get("/companies/:companyId/things", async (req, res) => {
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });
  return router;
}
```

Routes are wired in `server/src/app.ts` and re-exported from `server/src/routes/index.ts`.

### Database schema pattern
```typescript
// packages/db/src/schema/*.ts
export const myTable = pgTable("my_table", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  // ... columns
}, (table) => [
  index("my_table_company_idx").on(table.companyId),
]);
```

New tables MUST be exported from `packages/db/src/schema/index.ts`.

### Constants pattern
```typescript
// packages/shared/src/constants.ts
export const MY_STATUSES = ["active", "paused"] as const;
export type MyStatus = (typeof MY_STATUSES)[number];
```

## Key Rules

1. **Everything is company-scoped** — enforce company boundaries in routes/services
2. **Keep contracts synchronized** — schema change → update db/shared/server/ui layers
3. **Preserve invariants** — single-assignee tasks, atomic checkout, approval gates, budget hard-stops, activity logging
4. **New features as additive layers** — new files > modifying Paperclip core (upstream merge compatibility)
5. **AgentDash extensions** go in clearly marked sections (comments: `// AgentDash:`)

## Database

- **Dev**: Embedded PG (leave `DATABASE_URL` unset) — auto-managed at `~/.paperclip/instances/default/db/`
- **Reset**: `rm -rf ~/.paperclip/instances/default/db && pnpm dev`
- **Schema → Migration**: Edit `packages/db/src/schema/*.ts` → `pnpm db:generate` → `pnpm -r typecheck`
- **14 migrations** (0046-0059) added by AgentDash; 60 total migrations

## Branding

- Product name: **AgentDash**
- CLI command: `agentdash`
- localStorage keys: `agentdash.*`
- Plugin IDs: `agentdash.*`
- Internal package scopes remain `@agentdash/*` (upstream compatibility)
- Primary color: Teal — company-customizable via `themeAccentColor`

## Multi-Agent Workflow (MAW)

**MANDATORY:** Feature and bug development should run through MAW unless this is a production hotfix or pure infrastructure work.

### Quick Start

- `/workon AD-123` — full intake -> locally-tested workflow for one Linear issue
- `/pm <description>` — elaborate requirements and create/update issue scope
- `/builder AD-123` — implement a specific issue
- `/tester AD-123` — run the tester workflow for a specific issue
- `/tpm sync` — ship `Human-Verified` issues

### Agent Roles

| Agent | Invoked By | Role |
|-------|------------|------|
| **PM** | `/workon`, `/pm` | Elaborate requirements, size issues |
| **Builder** | `/workon`, `/builder` | Implement feature, add tests, create PR |
| **Tester** | `/workon`, `/tester` | E2E tests, code review, Chrome CUJ |
| **TPM** | `/tpm sync` | Sole merge authority to `main` |
| **Admin** | `/admin` | Ops health, deploy, environment checks |

Deployment: XS/S auto-ship after local test. M+ requires human verification. XL may use `staging` branch. See `doc/multi-agent-workflow/sop.md` for full details.

## Upstream Sync

Paperclip tracked as `upstream` remote. Use the sync script:

```sh
bash scripts/upstream-sync.sh --dry-run   # Preview: new commits, conflicts, risk areas
bash scripts/upstream-sync.sh             # Interactive merge on sync branch
```

**Conflict-prone files** (AgentDash modifies these Paperclip core files):
- `ui/src/App.tsx` — AgentDash routes
- `ui/src/components/Sidebar.tsx` — AgentDash nav items
- `server/src/index.ts` — AgentDash route wiring
- `packages/shared/src/constants.ts` — AgentDash status enums
- `README.md` — AgentDash branding
- `ui/index.html` — AgentDash title/meta

## Key Docs

| Doc | Purpose |
|-----|---------|
| `ARCHITECTURE.md` | Full system design |
| `doc/PRD.md` | Product requirements, 13 CUJs, deployment modes |
| `doc/BUSINESS-PLAN.md` | Pricing, GTM, client guide |
| `doc/SOP-deployment.md` | 50-person company deployment |
| `doc/SPEC-implementation.md` | Inherited V1 build contract |
| `doc/DEVELOPING.md` | Detailed dev guide |
| `doc/CUJ-STATUS.md` | Feature status and test coverage |
| `doc/ONBOARDING-FLOW.md` | Client onboarding flow diagram |
| `doc/agentdash_adapter_strategy.md` | Adapter design strategy |
| `doc/multi-agent-workflow/sop.md` | MAW standard operating procedure |
| `doc/multi-agent-workflow/protocol.md` | Agent handoff and comment protocol |

## Document Lifecycle

Agents generate docs, plans, and specs that accumulate over time. Run `bash scripts/doc-hygiene.sh` periodically to detect staleness and bloat.

Rules: docs under 40KB (split if larger), date-prefix plans (`YYYY-MM-DD-name.md`), archive superseded plans to `doc/plans/archive/`, one canonical location per topic, CLAUDE.md under 200 lines.

```sh
bash scripts/doc-hygiene.sh              # Scan for staleness, bloat, duplicates
bash scripts/doc-hygiene.sh --archive    # Auto-archive superseded plans
```
