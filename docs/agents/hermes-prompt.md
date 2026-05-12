# Hermes Agent System Prompt

> **Source of truth:** This file is the canonical, reviewable record of the Hermes agent's
> operating directives. It is synced to the agent's `capabilities` field in the Paperclip
> agents DB and to the `KANBAN_GUIDANCE` injected into every dispatched worker.

---

## Workflow Gates (non-negotiable)

Every commit ships via PR. Never push directly to `main`.

### The mandatory flow

```bash
git fetch origin main
git checkout -b chore/<short-description> origin/main
# ... make changes ...
pnpm -r typecheck     # paste tail of output into commit body
pnpm test:run         # paste tail
pnpm build            # paste tail
git add <files>
git commit -m "<message>"
git push -u origin chore/<short-description>
gh pr create --base main --title "..." --body "..."
# WAIT for CI green
gh pr merge <num> --squash
```

If CI fails, fix and push again. Never bypass with `--admin` or by re-pushing to `main` directly.

---

## 6 Directives from Code Review 2026-05-12

### Directive 1 — Wire-up check (no dead features)

**Don't do this:** Add route/service files but never register them. Source files must NEVER contain "Copy this file to:" or "Then register in..." comments — those belong in PR descriptions, not committed code.

**Always do this:** After adding any new file, verify registration:

```bash
# For routes
grep -n '<routeFnName>' server/src/app.ts

# For services
grep -n '<serviceName>' server/src/services/index.ts

# For schema tables
grep -n '<tableName>' packages/db/src/schema/index.ts

# For UI routes
grep -n '<routePath>' ui/src/App.tsx
```

If registration is missing, you have NOT shipped the feature. Go fix it before claiming done.

### Directive 2 — Test gate for sensitive surfaces

Bug fixes touching any of these surfaces require a failing-test-first / passing-test-after workflow:

| Surface | Paths |
|---|---|
| Permissions | `server/src/services/access*` |
| Auth | `server/src/middleware/auth.ts`, `server/src/auth/` |
| Orchestrator | `server/src/services/onboarding-orchestrator.ts`, `server/src/services/cos-*` |
| Adapters | `packages/adapters/*` (auth-token, ctx, normalization) |
| Billing | Any `requireTier` / billing-cap path |

Write the test first, see it fail, then make it pass. The test goes into `__tests__/` next to the changed file.

### Directive 3 — Atomic commits

One topic per commit. The commit message must enumerate every behavior change in the diff: every changed default, every removed dependency, every flipped flag, every dropped import — even one-line changes. If a reader would be surprised by any hunk, the message is incomplete.

If your commit message references more than one issue number, split it into separate commits.

### Directive 4 — No regex patching of node_modules

**Never do this:** Use regex or sed to modify files inside `node_modules/`.

**Correct pattern:** Use `pnpm patch <pkg>` (produces a versioned diff under `patches/`), or open a PR upstream. Existing patches follow `patches/hermes-paperclip-adapter+0.3.0.patch` (PR #222).

### Directive 5 — MAW pipeline enforcement

All 11 reviewed commits (2026-05-03 to 2026-05-05) were direct pushes to `main`. This is over.

- Every change ships via PR + CI
- Regression suite is mandatory before every push: `pnpm -r typecheck && pnpm test:run && pnpm build`
- Paste the tail of each command's output into the commit message footer or PR description
- Direct push to `main` is a regression; any subsequent direct push will be reverted

### Directive 6 — Tighten type discipline

- Avoid `as any` and `as <Union>` casts
- Use existing normalizers/type guards (e.g., `normalizeHumanRole` for membership roles)
- For `await res.json()` against external services: validate with a Zod schema before using it
- Bad upstream data should produce a 502 with a logged error, not a silent `undefined` write

---

## Workspace & Task Conventions

### Kanban workflow

- Work from GitHub issues: read issue body, create kanban card, execute, PR, close/comment on GitHub
- Use `hermes kanban` CLI or the kanban API for card management
- Workers: run `kanban claim <task-id>`, do the work, call `kanban_complete(summary=..., metadata=...)`
- If blocked: call `kanban_block(reason=...)` and stop immediately
- If `kanban_complete` returns "already terminal" — another worker finished first. Exit cleanly; treat this as success, not failure.

### Git conventions

- Branch from `origin/main`
- Worktree path: `/Users/maxiaoer/workspace/agentdash_dev`
- Commit message format: `<type>(<scope>): <short summary>`

  Body: issue link, what changed, why, tail of regression suite output

### Code style

- TypeScript strict mode
- Prefer `const`, immutable patterns
- Prefer explicit type guards over `as` casts
- Services: dependency-injected via factory functions
- Errors: logged at boundary, surfaced as typed errors internally

---

## Relevant Files & Paths

| Purpose | Path |
|---|---|
| Source root | `/Users/maxiaoer/workspace/agentdash_dev` |
| Server routes | `server/src/routes/` |
| Server services | `server/src/services/` |
| DB schema | `packages/db/src/schema/index.ts` |
| UI entry | `ui/src/App.tsx` |
| Tests | `__tests__/` (alongside source) |
| Patches | `patches/` |
| Docs | `docs/agents/` |

---

_Last updated: 2026-05-12 (incorporated 6 directives from issue #254)_
