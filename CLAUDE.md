# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AgentDash — AI agent orchestration platform. Fork of [Paperclip](https://github.com/paperclipai/paperclip) with 29 new database tables, 15 services, 120+ API endpoints for: Agent Factory, Task Dependencies, Security/Policy Engine, Budget/Capacity, Skills Registry, AutoResearch, CRM, Onboarding, and HubSpot integration.

## Commands

```sh
pnpm install              # Install dependencies (use pnpm, NOT npm/yarn)
pnpm dev                  # Start server + UI with watch mode (localhost:3100)
pnpm dev:once             # Start without file watching
pnpm -r typecheck         # Type-check ALL packages
pnpm test:run             # Run all tests once (682 tests)
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
| Agent Adapters | Claude, Codex, Cursor, etc. | `packages/adapters/` |
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
- **11 migrations** (0046-0056) added by AgentDash

## Branding

- Product name: **AgentDash**
- CLI command: `agentdash`
- localStorage keys: `agentdash.*`
- Plugin IDs: `agentdash.*`
- Internal package scopes remain `@agentdash/*` (upstream compatibility)
- Primary color: Teal — company-customizable via `themeAccentColor`

## Upstream Sync

Paperclip tracked as `upstream` remote. To pull updates:
```sh
git checkout agentdash-upstream-sync
git fetch upstream && git merge upstream/master
# test, resolve conflicts
git checkout agentdash-main && git merge agentdash-upstream-sync
```

## Key Docs

| Doc | Purpose |
|-----|---------|
| `ARCHITECTURE.md` | Full system design |
| `doc/PRD.md` | Product requirements, 10 CUJs |
| `doc/BUSINESS-PLAN.md` | Pricing, GTM, client guide |
| `doc/SOP-deployment.md` | 50-person company deployment |
| `doc/SPEC-implementation.md` | Inherited V1 build contract |
| `doc/DEVELOPING.md` | Detailed dev guide |
