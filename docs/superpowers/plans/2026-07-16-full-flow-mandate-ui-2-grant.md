# Full-Flow Demo — UI-2 (grant-mandate screen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Let a human grant a mandate to an agent from the UI — a new "Mandates" tab on the agent's detail page (grant form: grantor [default CoS], scope, spend cap, expiry) backed by new `POST/GET /companies/:id/mandates` routes.

**Design (approved):** Grant form lives as an `AgentDetail` tab; the granted agent is the grantee; the grantor defaults to the company's lead/CoS agent (`role === "ceo"`), pickable. Follows the "Claude design system" (`@/components/ui/*`, coral accent, no hardcoded hex). Backend reuses `mandatesService.createMandate` (Slice 1/2a) + a new `listMandates`.

**Tech Stack:** TypeScript ESM, Express 5, Drizzle, React 19 + Tailwind 4 + react-query + `@/lib/router`, vitest + supertest. No UI test harness (typecheck `tsc -b` is the FE gate).

## Global Constraints

- ESM `.js` specifiers. Route factory like `approvals.ts`/`mandated-actions.ts`; `validate(schema)` + `assertCompanyAccess`. FE forms hand-rolled (useState + `useMutation` + inline `text-destructive` error), money via a local dollars↔cents helper (mirror `BudgetPolicyCard.tsx`), date via native `<input type="date">`.
- Flag-off: `createMandate` still creates the row (anchoring skipped when DIDs unresolved) — the route returns the row.
- Design system only — no hardcoded hex, no ALL CAPS, coral not blue, components from `@/components/ui/*`.
- Stage ONLY each task's files with explicit `git add`. Commit on `feat/agentdash-mcp-package`.
- Test cmd: `pnpm exec vitest run --project @paperclipai/server <file>`; typechecks: `pnpm --filter @paperclipai/server run typecheck`, `pnpm --filter @paperclipai/shared run typecheck`, `pnpm --filter @paperclipai/ui run typecheck` — all exit 0.

---

### Task 1: Backend — `listMandates` + create/list routes + schema

**Files:**
- Create: `packages/shared/src/validators/mandate.ts`; Modify: `packages/shared/src/validators/index.ts`, `packages/shared/src/index.ts`
- Modify: `server/src/services/mandates.ts` (add `listMandates`)
- Create: `server/src/routes/mandates.ts`; Modify: `server/src/app.ts` (mount)
- Test: `server/src/__tests__/mandates-route.test.ts`

**Interfaces:**
- Produces: `POST /api/companies/:companyId/mandates` (create), `GET /api/companies/:companyId/mandates?granteeAgentId=` (list); `mandatesService(...).listMandates(companyId, granteeAgentId?)`.

- [ ] **Step 1: Shared schema.** Create `packages/shared/src/validators/mandate.ts` (mirror `mandated-action.ts`'s idiom):
```ts
import { z } from "zod";
export const createMandateSchema = z.object({
  grantorAgentId: z.string().uuid(),
  granteeAgentId: z.string().uuid(),
  scope: z.record(z.unknown()).default({}),
  permissionKey: z.string().min(1).default("clockchain:attest"),
  spendCapCents: z.number().int().nonnegative().default(0),
  expiresAt: z.string().datetime(),
});
export type CreateMandateRequest = z.infer<typeof createMandateSchema>;
```
Re-export from `packages/shared/src/validators/index.ts` and `packages/shared/src/index.ts` exactly as `mandated-action.ts` is re-exported (follow that precedent through both barrels).

- [ ] **Step 2: `listMandates` service.** In `server/src/services/mandates.ts`, add to the returned object a method:
```ts
async function listMandates(companyId: string, granteeAgentId?: string): Promise<MandateRow[]> {
  const where = granteeAgentId
    ? and(eq(mandates.companyId, companyId), eq(mandates.granteeAgentId, granteeAgentId))
    : eq(mandates.companyId, companyId);
  return db.select().from(mandates).where(where).orderBy(desc(mandates.createdAt));
}
```
Add `listMandates` to the `return { ... }`. Add `and`, `desc` to the `drizzle-orm` import if not present.

- [ ] **Step 3: Route.** Create `server/src/routes/mandates.ts`:
```ts
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createMandateSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { mandatesService } from "../services/mandates.js";
import { assertCompanyAccess } from "./authz.js";

export function mandateRoutes(db: Db) {
  const router = Router();
  const svc = mandatesService(db);

  router.get("/companies/:companyId/mandates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const granteeAgentId = typeof req.query.granteeAgentId === "string" ? req.query.granteeAgentId : undefined;
    res.json(await svc.listMandates(companyId, granteeAgentId));
  });

  router.post("/companies/:companyId/mandates", validate(createMandateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const b = req.body as import("@paperclipai/shared").CreateMandateRequest;
    const mandate = await svc.createMandate({
      companyId,
      grantorAgentId: b.grantorAgentId,
      granteeAgentId: b.granteeAgentId,
      scope: b.scope,
      permissionKey: b.permissionKey,
      spendCapCents: b.spendCapCents,
      expiresAt: new Date(b.expiresAt),
    });
    res.status(201).json(mandate);
  });

  return router;
}
```
> `mandatesService` import: use `../services/mandates.js` directly (not the barrel) to avoid the known mandated-action cycle class of issue; confirm `mandatesService` is exported there.

- [ ] **Step 4: Mount.** In `server/src/app.ts`, import `mandateRoutes` from `./routes/mandates.js` and add `api.use(mandateRoutes(db));` next to `api.use(mandatedActionRoutes(db));`.

- [ ] **Step 5: Supertest test.** Create `server/src/__tests__/mandates-route.test.ts` (embedded PG + injected agent/board actor + errorHandler, mirror `mandated-actions-route.test.ts`). Seed a company + two agents (grantor, grantee). Cases:
  - POST a valid body (grantor/grantee ids, `scope:{description:"x"}`, `permissionKey:"clockchain:attest"`, `spendCapCents:5000`, `expiresAt`: a future ISO string) → **201**, body has `id`, `granteeAgentId`, `status:"active"`, `ccLedgerId:null` (flag-off, no anchor).
  - GET `/companies/:id/mandates?granteeAgentId=<grantee>` → **200**, an array containing the created mandate.
  - POST missing `expiresAt` → **400**.

- [ ] **Step 6: Run + typecheck.** Vitest the route test (green); `pnpm --filter @paperclipai/server run typecheck` + `pnpm --filter @paperclipai/shared run typecheck` exit 0.

- [ ] **Step 7: Commit.**
```bash
git add packages/shared/src/validators/mandate.ts packages/shared/src/validators/index.ts packages/shared/src/index.ts server/src/services/mandates.ts server/src/routes/mandates.ts server/src/app.ts server/src/__tests__/mandates-route.test.ts
git commit -m "feat(server): mandates create/list routes + listMandates service"
```

---

### Task 2: Frontend — mandates API client + grant form (AgentDetail "Mandates" tab)

**Files:**
- Create: `ui/src/api/mandates.ts`; Modify: `ui/src/api/index.ts` (export), `ui/src/lib/queryKeys.ts` (add mandate keys — check the file's pattern)
- Create: `ui/src/components/agent/MandatesTab.tsx`
- Modify: `ui/src/pages/AgentDetail.tsx` (add the tab)

**Interfaces:**
- Consumes: Task 1 routes.

- [ ] **Step 1: API client.** Create `ui/src/api/mandates.ts` (mirror `ui/src/api/approvals.ts`):
```ts
import { api } from "./client";

export type Mandate = {
  id: string; companyId: string; grantorAgentId: string; granteeAgentId: string;
  scope: Record<string, unknown>; permissionKey: string; spendCapCents: number;
  expiresAt: string; status: string;
  ccLedgerId: string | null; ccBlockHeight: number | null; ccScheme: string | null; ccAnchoredAt: string | null;
  createdAt: string; updatedAt: string;
};
export type CreateMandateBody = {
  grantorAgentId: string; granteeAgentId: string; scope: Record<string, unknown>;
  permissionKey: string; spendCapCents: number; expiresAt: string;
};
export const mandatesApi = {
  list: (companyId: string, granteeAgentId?: string) =>
    api.get<Mandate[]>(`/companies/${companyId}/mandates${granteeAgentId ? `?granteeAgentId=${granteeAgentId}` : ""}`),
  create: (companyId: string, body: CreateMandateBody) =>
    api.post<Mandate>(`/companies/${companyId}/mandates`, body),
};
```
Export `mandatesApi` from `ui/src/api/index.ts` (match how `approvalsApi` is exported). Add `mandates` query keys to `ui/src/lib/queryKeys.ts` following the `approvals` key pattern (e.g. `mandates: { list: (companyId, granteeAgentId) => [...] }`).

- [ ] **Step 2: MandatesTab component.** Create `ui/src/components/agent/MandatesTab.tsx`. Props `{ companyId: string; agentId: string; agents: { id: string; name: string; role?: string }[] }` (the agent list is already loaded in AgentDetail — pass it in). Behavior:
  - `useQuery(queryKeys.mandates.list(companyId, agentId), () => mandatesApi.list(companyId, agentId))` — the list of mandates where this agent is grantee.
  - A grant form (hand-rolled useState): grantor `<select>` (default to the agent with `role === "ceo"`, else the first agent; exclude the grantee agent), scope description `<Input>` (stored as `{ description }`), spend-cap dollars `<Input inputMode="decimal">` (convert to cents via a local `parseDollarsToCents` helper mirroring `BudgetPolicyCard.tsx`), expiry `<input type="date">` (convert to ISO end-of-day). `permissionKey` fixed to `"clockchain:attest"` (not shown, or shown read-only).
  - Submit `useMutation(() => mandatesApi.create(companyId, { grantorAgentId, granteeAgentId: agentId, scope: { description }, permissionKey: "clockchain:attest", spendCapCents, expiresAt }))`, `onSuccess` → `queryClient.invalidateQueries(queryKeys.mandates.list(companyId, agentId))` + reset form; `onError` → inline `<p className="text-destructive text-sm">`.
  - The list: render each mandate as a Card row — grantor→grantee (names from `agents`), scope description, cap (`formatCents` from `@/lib/utils`), expiry (formatted), a Badge for `status`, and an "anchored" indicator (if `ccLedgerId` present show a small "Anchored" Badge, else "not anchored" — honest). Use only `@/components/ui/*` (Card, Badge, Button, Input, Label, Select) + design tokens.
  - Empty state: "No mandates granted to this agent yet."

- [ ] **Step 3: Wire the tab into AgentDetail.** In `ui/src/pages/AgentDetail.tsx`:
  - Add `"mandates"` to the `AgentDetailView` union (line ~248) and a `if (value === "mandates") return "mandates";` in `parseAgentDetailView`.
  - Add a `{ value: "mandates", label: "Mandates" }` (match the existing item shape) to the `PageTabBar` items array (near the `budget` tab).
  - Add a render block: `{view === "mandates" && <MandatesTab companyId={companyId} agentId={agent.id} agents={agents} />}` (use the already-loaded `companyId`, `agent`, and the agents list — confirm their in-scope names; the file already loads the company agents for other tabs).
  - Import `MandatesTab` at the top.

- [ ] **Step 4: Typecheck.** `pnpm --filter @paperclipai/ui run typecheck` (tsc -b) exit 0. (No UI unit-test harness — typecheck + design-system adherence is the gate.)

- [ ] **Step 5: Commit.**
```bash
git add ui/src/api/mandates.ts ui/src/api/index.ts ui/src/lib/queryKeys.ts ui/src/components/agent/MandatesTab.tsx ui/src/pages/AgentDetail.tsx
git commit -m "feat(ui): grant-mandate form + mandates list as an AgentDetail tab"
```

---

## Self-Review

- Backend (Task 1): schema + listMandates + routes + mount + test → all acceptance covered; reuses `createMandate` (no new gate logic).
- Frontend (Task 2): api client + grant form + list + tab wiring; design-system components only; honest anchored/not-anchored indicator.
- Placeholder scan: FE has no test harness — typecheck is the stated gate (not a hidden gap); the `queryKeys`/agents-in-scope names are flagged for the implementer to confirm against the real files.
- Type consistency: `createMandateSchema` shared by route; `Mandate`/`CreateMandateBody` FE types mirror the row/route; `listMandates(companyId, granteeAgentId?)` used by route + FE.
- No over-build: no revoke UI, no scope-builder (simple description), no receipts view (separate slice).
