# Assess + agent research port plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port the v1 Assess subsystem (single-flow project-mode assessment with adaptive clarify, MiniMax-powered) onto the v2 base. No redesign — straight carry-forward, `ui` styling left to the Claude design plan. The user said "take as-is, I will improve it later"; this plan honors that.

**Architecture:** Direct file copy from `archive/agentdash-v1` to `main`, with two adaptations: (a) update import paths if the v2 base has reorganized any directory; (b) ensure new schema migrations slot cleanly into the v2 migration sequence.

**Tech Stack:** TypeScript, Node 20, Express, Drizzle ORM, PostgreSQL, React 19. LLM provider: MiniMax (existing v1 integration).

---

## Prerequisites

- [ ] v2 base migration plan complete.
- [ ] Multi-human + CoS chat substrate plan complete (Assess pages may link from the chat thread once we add CoS-suggested-assess).

If chat substrate is not yet merged, this plan can still ship — Assess is reachable via direct nav (`/assess`), independent of CoS.

- [ ] MiniMax env vars present: `MINIMAX_API_KEY` (and any base URL the v1 service requires; check the carried-forward service for the exact list).

---

## What "Assess + agent research" means in this plan

Per the inventory, two things in v1 carry the "research" framing:

1. **Assess proper** — `server/src/services/assess*.ts` does company website fetch → industry detection → context retrieval → LLM prompt → adaptive clarify → output. This is a single-session research flow per assessment. Load-bearing.
2. **AutoResearch** — `server/src/services/autoresearch.ts` + routes/schema for cycles/hypotheses/experiments. Inventory verdict: STUB (rich data layer, no engine). **Not ported.** The user's "agent research" framing is interpreted as the research-as-part-of-Assess flow, not the AutoResearch CRUD.

If at review time the user clarifies they meant AutoResearch should also port, add a Phase 5 to this plan; otherwise it stays out.

---

## File structure

**Ported (direct copy from `archive/agentdash-v1`):**

| File | Type | Notes |
|---|---|---|
| `server/src/services/assess.ts` | Service | Core orchestration (research + clarify + output) |
| `server/src/services/assess-prompts.ts` | Service | LLM prompt templates |
| `server/src/services/assess-retrieval.ts` | Service | Web fetch + industry detection |
| `server/src/services/assess-project.ts` | Service | Project-mode assessment branch |
| `server/src/services/assess-project-docx.ts` | Service | Document export |
| `server/src/services/assess-data.ts` | Service | Static reference data (industries, etc.) |
| `server/src/routes/assess.ts` | Route | REST endpoints |
| `packages/db/src/schema/assess*.ts` | Schema | Per-assessment session tables |
| `packages/db/src/migrations/<assess-related>.sql` | Migration | Re-numbered into v2 sequence |
| `ui/src/pages/AssessPage.tsx` | UI | Main assessment page |
| `ui/src/components/ModeChooser.tsx` | UI | Mode switch (project / company) |
| `ui/src/components/ProjectWizard.tsx` | UI | Project-mode flow |
| `ui/src/api/assess.ts` | UI client | Frontend API |
| `server/src/__tests__/assess-*.test.ts` | Tests | All Assess-related tests |
| `server/src/__tests__/assess-routes.test.ts` | Tests | Same |

**Modified (light wiring):**

| File | Change |
|---|---|
| `server/src/app.ts` | Mount `/api/assess` routes |
| `server/src/services/index.ts` | Re-export `assessService` etc. |
| `packages/db/src/schema/index.ts` | Re-export assess schema |
| `ui/src/App.tsx` | Add `/assess` route + nav link |

---

## Phase 1 — Inventory the v1 Assess code

### Task 1.1 — List exact files to port

**Files:** none changed; this is a survey step.

- [ ] **Step 1: Run the file inventory**

```sh
git ls-tree -r archive/agentdash-v1 --name-only \
  | grep -iE '(assess|industry-data)' \
  | grep -v '__archive__' \
  > /tmp/assess-files-to-port.txt
cat /tmp/assess-files-to-port.txt
```

Expected: a list of ~13–18 files spanning server/services, server/routes, server/__tests__, packages/db/schema, packages/db/migrations, ui/pages, ui/components, ui/api, packages/shared.

- [ ] **Step 2: Read [doc/CUJ-STATUS.md](../../doc/CUJ-STATUS.md) entry for Assess (in v1) if present**

```sh
git show archive/agentdash-v1:doc/CUJ-STATUS.md 2>/dev/null | grep -i "assess" -A 3
```

This gives the human-language description of what Assess does, useful for verification and the PR body.

- [ ] **Step 3: Identify any cross-cutting v1 deps Assess uses**

```sh
git show archive/agentdash-v1:server/src/services/assess.ts | head -50 | grep "^import"
```

Flag any imports that point at v1-only modules (e.g., AutoResearch helpers, CRM helpers). The port either replaces them with v2 equivalents or strips the call site.

---

## Phase 2 — Port server-side Assess

### Task 2.1 — Copy services + routes

**Files:**
- Create: every server-side file from the inventory in Task 1.1

- [ ] **Step 1: Copy each file from the v1 branch**

```sh
for f in $(cat /tmp/assess-files-to-port.txt | grep -E '^(server|packages/shared)/'); do
  mkdir -p "$(dirname "$f")"
  git show "archive/agentdash-v1:$f" > "$f"
done
```

- [ ] **Step 2: Resolve import-path drift**

```sh
pnpm -r typecheck 2>&1 | grep -E "Cannot find module|has no exported member" | head -20
```

For each error, fix the import in the ported file:
- If a v1 service moved or was renamed in v2 base, update the path.
- If a v1 service was dropped (e.g., AutoResearch helpers), either inline the small helper into Assess or strip the dependent call site if it's pure dead code.

- [ ] **Step 3: Wire Assess routes into the app**

In `server/src/app.ts`:

```typescript
import { assessRoutes } from "./routes/assess.js";
app.use("/api/assess", assessRoutes(db));
```

In `server/src/services/index.ts`:

```typescript
export * from "./assess.js";
export * from "./assess-prompts.js";
export * from "./assess-retrieval.js";
export * from "./assess-project.js";
```

- [ ] **Step 4: Run typecheck**

```sh
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add server/src/services/assess*.ts server/src/routes/assess.ts \
  server/src/app.ts server/src/services/index.ts
git commit -m "feat(server): port Assess services + routes from v1"
```

### Task 2.2 — Port schema + migrations

**Files:**
- Create: `packages/db/src/schema/assess*.ts` (or whatever v1 names them)
- Create: `packages/db/src/migrations/<new-numbered>_assess.sql`

- [ ] **Step 1: Copy schema**

```sh
for f in $(cat /tmp/assess-files-to-port.txt | grep -E '^packages/db/src/schema/'); do
  git show "archive/agentdash-v1:$f" > "$f"
done
```

- [ ] **Step 2: Re-export**

```sh
echo 'export * from "./assess.js";' >> packages/db/src/schema/index.ts
# (or whichever filenames the v1 schema split into)
```

- [ ] **Step 3: Generate fresh migration in v2's numbering**

```sh
pnpm db:generate
```

This produces a new SQL file in v2's migration sequence. **Don't copy v1 migration files directly** — their numbers won't match v2's sequence. Let drizzle generate fresh ones from the schema.

- [ ] **Step 4: Apply + typecheck**

```sh
pnpm db:migrate
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/db/src/schema/ packages/db/src/migrations/
git commit -m "feat(db): port Assess schema + generate v2 migration"
```

### Task 2.3 — Port server-side tests

**Files:**
- Create: `server/src/__tests__/assess-*.test.ts`

- [ ] **Step 1: Copy tests**

```sh
for f in $(cat /tmp/assess-files-to-port.txt | grep -E '^server/src/__tests__/' | grep assess); do
  git show "archive/agentdash-v1:$f" > "$f"
done
```

- [ ] **Step 2: Run them**

```sh
pnpm test:run -- assess
```

Expected: PASS, or only failures that touch upstream-changed test infrastructure (e.g., mocked service signatures). Fix those minimally; do not weaken assertions.

- [ ] **Step 3: Commit**

```sh
git add server/src/__tests__/assess*.test.ts
git commit -m "test(server): port Assess tests from v1"
```

---

## Phase 3 — Port UI

### Task 3.1 — Pages + components + api client

**Files:**
- Create: `ui/src/pages/AssessPage.tsx`, `ui/src/components/ModeChooser.tsx`, `ui/src/components/ProjectWizard.tsx`, `ui/src/api/assess.ts`

- [ ] **Step 1: Copy UI files**

```sh
for f in $(cat /tmp/assess-files-to-port.txt | grep -E '^ui/src/'); do
  mkdir -p "$(dirname "$f")"
  git show "archive/agentdash-v1:$f" > "$f"
done
```

- [ ] **Step 2: Wire route + nav**

In `ui/src/App.tsx`:

```tsx
import AssessPage from "./pages/AssessPage";
<Route path="/assess" element={<AssessPage />} />
```

If a sidebar exists (post-chat-substrate plan), add a nav item:

```tsx
<SidebarNavItem to="/assess" label="Assess" icon={<SearchIcon />} />
```

- [ ] **Step 3: Resolve import-path drift in UI**

```sh
cd ui && pnpm typecheck 2>&1 | grep -E "Cannot find" | head -10
```

Fix imports per the same pattern as Phase 2.

- [ ] **Step 4: Smoke test in `pnpm dev`**

Navigate to `/assess`. The page should load, render the mode chooser, and accept input. The visual style will be v1's (not Claude design) until the UI redesign plan applies tokens.

- [ ] **Step 5: Commit**

```sh
git add ui/src/pages/AssessPage.tsx ui/src/components/ModeChooser.tsx \
  ui/src/components/ProjectWizard.tsx ui/src/api/assess.ts ui/src/App.tsx
git commit -m "feat(ui): port AssessPage + ModeChooser + ProjectWizard from v1"
```

---

## Phase 4 — Adapt to v2 patterns (minimal)

### Task 4.1 — Authorization + actor pattern

**Files:**
- Modify: `server/src/routes/assess.ts`

The v2 base migration may have shifted `req.actor` shape slightly (multi-user upstream changes). Verify Assess routes still work with v2's actor middleware.

- [ ] **Step 1: Inspect v1 auth checks in Assess**

```sh
grep -n "assertCompanyAccess\|assertBoard\|requireTier\|requirePro" server/src/routes/assess.ts
```

- [ ] **Step 2: If signatures changed, fix the calls**

For example, if `requirePro` from v1 was renamed in v2 to `requireTierFor("pro")`, update the calls accordingly. Run the tests after each change.

- [ ] **Step 3: Add tier gate if Assess is meant to be Pro-only**

If Assess should be Pro-only in v2 (per billing spec — Assess wasn't named in tier definitions, so default is Free-available), do nothing. If review feedback says Pro-only, add `requireTierFor("pro")` to the relevant route handlers.

- [ ] **Step 4: Commit if any changes**

```sh
git add server/src/routes/assess.ts
git commit -m "fix(server): align Assess routes with v2 actor + tier patterns"
```

### Task 4.2 — Activity events emission (optional, depends on chat substrate)

If chat substrate is merged before this plan, Assess can post a CoS chat message when an assessment completes ("I just finished assessing your business — open the report"). This is a **nice-to-have**, not required.

- [ ] **Step 1 (if implementing): Emit `agent.activity` event on assessment completion**

In `server/src/services/assess.ts`, wherever the final output is generated:

```typescript
import { activityBus } from "../realtime/activity-bus.js";
// ...
activityBus.emit("agent.activity", {
  kind: "task_completed",
  agentId: cosAgentId,
  companyId,
  payload: { title: `Assessment for ${target} ready` },
});
```

The chat substrate's `cos-proactive` will turn this into an `agent_status_v1` card.

- [ ] **Step 2 (if implementing): Add a test**

```typescript
it("emits a task_completed activity when an assessment finishes", async () => {
  const events: any[] = [];
  activityBus.on("agent.activity", (e) => events.push(e));
  await assessService(db).run({ /* ... */ });
  expect(events.some((e) => e.kind === "task_completed")).toBe(true);
});
```

- [ ] **Step 3: Commit**

```sh
git add server/src/services/assess.ts server/src/__tests__/assess-service.test.ts
git commit -m "feat(server): emit agent.activity on assessment completion"
```

---

## Phase 5 — Verification

### Task 5.1 — Regression suite

- [ ] **Step 1: Typecheck + tests + build**

```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

Expected: PASS, modulo any pre-existing flakes in unrelated upstream code.

- [ ] **Step 2: Manual QA**

- Navigate to `/assess`.
- Run a full assessment with a real company URL (e.g., `acme.com`).
- Confirm the adaptive clarify questions fire.
- Confirm the final output renders.
- Confirm the document export works (if v1 had it).

### Task 5.2 — Open the PR

Title: `feat: port Assess + agent research from v1`

```sh
git push -u origin <branch>
gh pr create --base main --head <branch> --title "feat: port Assess from v1" --body "$(cat << 'EOF'
Direct port of the v1 Assess subsystem to v2 main:
- Services: assess, assess-prompts, assess-retrieval, assess-project, assess-project-docx, assess-data
- Routes: /api/assess
- Schema: per-assessment session tables (re-generated migration in v2 sequence)
- UI: AssessPage, ModeChooser, ProjectWizard
- Tests: ported as-is

Visual style is v1; the Claude design system plan layers on top.

Optional Phase 4.2: emits agent.activity on assessment completion so the
chat substrate's cos-proactive surfaces a status card. (Disabled if chat
substrate isn't yet merged.)

Verification: typecheck ✓, tests ✓, build ✓, manual QA ✓ (assessed acme.com end to end).
EOF
)"
```

---

## What this plan does NOT do

- **Redesign Assess UX or scope.** That's deferred per the user's "take as-is, I will improve it later."
- **Port AutoResearch.** Inventory verdict was STUB; not on the keep-list.
- **Apply Claude design styling.** That's the UI redesign plan's job, run after this one.
- **Add new LLM providers.** v1 used MiniMax; v2 keeps using MiniMax for Assess until the user revisits.

## Decisions baked in

| Decision | Choice |
|---|---|
| "Take as-is" | Direct port; no behavioral changes |
| "Agent research" interpretation | Research-as-part-of-Assess (not AutoResearch CRUD) |
| Migration numbering | Drizzle re-generates fresh migrations in v2 sequence |
| Tier gating | Default Free (no `requireTierFor`); revisit if review changes scope |
| Chat integration | Optional Phase 4.2 — emit agent.activity if chat substrate merged first |
