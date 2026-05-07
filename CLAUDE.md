# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**AgentDash v2** — a CoS-led, multi-human AI workspace built on [Paperclip](https://github.com/paperclipai/paperclip).

v2 is a clean rebuild on latest upstream/master with five named sub-projects layered on top:

1. **UI redesign** with Claude design system
2. **Assess + agent research** (ported from v1)
3. **Onboarding (rescoped)** — sign-up → CoS chat → first agent hire → invite teammates
4. **Subscription + billing** — Free + Pro per-seat, 14-day no-card Stripe trial
5. **Multi-human + CoS chat substrate** — typed cards, @-mention summons, WS bus

v2 explicitly drops v1's CRM, HubSpot stub, AutoResearch stub, Action Proposals + Policy Engine, Pipeline Orchestrator, Budget+Capacity, Skills Registry workflow, and Smart Model Routing. See [doc/UPSTREAM-POLICY.md](doc/UPSTREAM-POLICY.md) for the upstream relationship and [docs/superpowers/specs/](docs/superpowers/specs/) for each sub-project's design spec.

## Commands

```sh
pnpm install              # Install dependencies (use pnpm, NOT npm/yarn)
pnpm dev                  # Start server + UI with watch mode (localhost:3100)
pnpm dev:once             # Start without file watching
pnpm -r typecheck         # Type-check ALL packages
pnpm test:run             # Run all tests once
pnpm build                # Build all packages
pnpm db:generate          # Generate migration after schema changes
pnpm db:migrate           # Apply pending migrations
```

### Verification (run before claiming done)
```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

### End-to-end Playwright specs
```sh
pnpm exec playwright test --config tests/e2e/playwright-multiuser.config.ts
pnpm exec playwright test --config tests/e2e/playwright-multiuser-authenticated.config.ts
```

### Mandatory regression testing before handing off

**NEVER ask the user to test something until you have already run the regression suite yourself.** Before any "please try this", "can you verify", or "ready for your review" handoff, you MUST have run and reported results for:

1. `pnpm -r typecheck` — all packages pass
2. `pnpm test:run` — report pass count and explicitly flag any failures (even pre-existing flakes must be named)
3. `pnpm build` — all packages build
4. For any UI-touching change: relevant `tests/e2e/*.spec.ts` Playwright specs

If a step fails, fix it (or explicitly document it as a pre-existing failure unrelated to your change) before the handoff. "Works for me" or "should work" is not acceptable. Ship the test evidence with the request.

## Multi-Agent Workflow

MAW slash commands are installed under `.claude/commands/` (`pm.md`, `builder.md`, `tester.md`, `tpm.md`, `admin.md`, `workon.md`, `upstream-digest.md`).

- Base branch for MAW PRs: `main` (during v2 build; flips back to `agentdash-main` after the cutover described in [docs/superpowers/specs/2026-05-02-v2-base-migration-design.md](docs/superpowers/specs/2026-05-02-v2-base-migration-design.md))
- Default issue prefix in examples: `AGE` (Linear) and `GH #` (GitHub)
- Primary entry point: `/workon AGE-123`
- Shipping command: `/tpm sync`
- **Upstream policy:** read [doc/UPSTREAM-POLICY.md](doc/UPSTREAM-POLICY.md). We don't bulk-merge upstream; we cherry-pick when there's a specific reason. Run `bash scripts/upstream-digest.sh` weekly to see what's new — it's read-only.

Staging and production steps still contain explicit `TODO_SET_*` placeholders for environment URLs and test credentials. Fill those before using the deploy/admin flows.

## Local development bootstrap (first run)

For your very first run as the founding user, AgentDash works in `local_trusted` deployment mode without a sign-up flow. The orchestrator detects the synthetic `local-board` actor and provisions a workspace + CoS agent for you:

```sh
# Optional: name your workspace properly (defaults to "Local Workspace")
export AGENTDASH_BOOTSTRAP_EMAIL=you@yourdomain.com

pnpm dev
# Open http://localhost:3100/cos
# CoS chat is ready — start the interview.
```

To test billing-gated flows (invites, agent hires) without wiring Stripe:

```sh
# Caps bypassed when STRIPE_SECRET_KEY is unset, OR explicitly:
export AGENTDASH_BILLING_DISABLED=true
pnpm dev
```

When `STRIPE_SECRET_KEY` is set in production, caps are enforced as designed (Free: 1 human + 1 agent; Pro: unlimited). The bypass is dev-only.

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

- `/workon AGE-123` — full intake -> locally-tested workflow for one Linear issue
- `/pm <description>` — elaborate requirements and create/update issue scope
- `/builder AGE-123` — implement a specific issue
- `/tester AGE-123` — run the tester workflow for a specific issue
- `/tpm sync` — ship `Human-Verified` issues

### Agent Roles

| Agent | Invoked By | Role |
|-------|------------|------|
| **PM** | `/workon`, `/pm` | Elaborate requirements, size issues |
| **Builder** | `/workon`, `/builder` | Implement feature, add tests, create PR |
| **Tester** | `/workon`, `/tester` | E2E tests, code review, Chrome CUJ |
| **TPM** | `/tpm sync` | Sole merge authority to `main` |
| **Admin** | `/admin` | Ops health, deploy, environment checks |

Deployment: XS/S auto-ship after local test. M+ requires human verification. XL may use `staging` branch. The detailed handoff/sizing rules live inline in each agent's `.claude/commands/*.md` file.

## Agent-facing feature convention

Project conventions for adding agent-facing features (new endpoints, state transitions, gates, failure modes — DoD/verdict-style additions) live in repo-root [`AGENTS.md`](AGENTS.md), the harness-agnostic file read by Codex, Cursor, Aider, Continue, and other tools. When extending Paperclip's worker prompts, follow the rule there: update all four prompt surfaces (`server/src/onboarding-assets/{default,ceo,chief_of_staff}/AGENTS.md` plus `server/src/services/agent-creator-from-proposal.ts`). CI enforces this via `.github/workflows/agents-md-drift-check.yml`.

## Upstream Policy

**Reference, don't merge.** Paperclip tracked as `upstream` remote for read-only reference only. We do NOT run continuous or scheduled upstream syncs — as of 2026-04-17 we were 339 commits behind with 37% of migrations AgentDash-owned, and every conflict-prone core file has AgentDash modifications. Continuous merging is not worth the cost.

Cherry-pick an upstream commit only when all four apply: target is in the "still inherited" list (heartbeat, adapters, auth, plugin SDK, etc.), fix is specific and bounded, we have a concrete reason to care, and the commit doesn't touch AgentDash-modified files in a way that requires redesign.

See `doc/UPSTREAM-POLICY.md` for the full rubric, what we still inherit vs what is 100% AgentDash, and the cherry-pick log. Archived sync script at `scripts/archive/upstream-sync.sh`.

## Key Docs

| Doc | Purpose |
|-----|---------|
| `doc/LAUNCH.md` | Step-by-step from clean clone to first paying customer (env vars, Stripe, deploy) |
| `doc/UPSTREAM-POLICY.md` | Cherry-pick rubric for paperclip upstream commits |
| `doc/SPEC-implementation.md` | Inherited V1 build contract |
| `doc/DEVELOPING.md` | Detailed dev guide |
| `doc/PRODUCT.md` | Paperclip product overview (vendor doc) |
| `.claude/commands/*.md` | MAW slash commands — PM, Builder, Tester, TPM, Admin |

V1-era PRD/BUSINESS-PLAN/CUJ-STATUS/ONBOARDING-FLOW/adapter-strategy docs live on `origin/archive/agentdash-v1` and have not been forward-ported. Treat them as historical reference, not v2 source of truth.

## Document Lifecycle

Rules for any new doc: keep individual files under 40KB (split if larger), date-prefix plans (`YYYY-MM-DD-name.md`), archive superseded plans under a clearly-named archive folder, one canonical location per topic, keep CLAUDE.md under 200 lines.
