# Full-Flow Demo — Slice 2b-surface (route + MCP tool) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Expose `mandatedActionService.performMandatedAction` (2b-core) to agents: a REST route `POST /companies/:companyId/mandated-actions` and an AgentDash MCP tool `paperclipMandatedAttest` that wraps it.

**Architecture:** Shared zod schema → Express route (factory `mandatedActionRoutes(db)`, mounted in `app.ts`, gated by `assertCompanyAccess`) → the 2b-core service. Separate stdio MCP server adds a `makeTool` that POSTs to the route via `client.requestJson`.

**Tech Stack:** TypeScript ESM, Express 5, zod (`@paperclipai/shared`), vitest + supertest, embedded Postgres, pnpm workspaces.

## Global Constraints

- Follow existing conventions: route factory like `server/src/routes/approvals.ts`; `validate(schema)` middleware; `assertCompanyAccess(req, companyId)` + `getActorInfo(req)` from `./authz.js`; service from `../services/index.js`.
- ESM `.js` import specifiers.
- The route is thin: validate → authz → `performMandatedAction` → `res.json`. No new gate logic.
- Flag-off: the gate denies at the mandate step, so route tests assert denial wiring (no testnet).
- Test command: `pnpm exec vitest run --project @paperclipai/server <file>`; typecheck `pnpm --filter @paperclipai/server run typecheck` (exit 0). mcp-server: `pnpm --filter @paperclipai/mcp-server run typecheck` (or `build`) exit 0.
- Stage ONLY each task's files with explicit `git add`. Commit on `feat/agentdash-mcp-package`.
- Spec: `docs/superpowers/specs/2026-07-16-full-flow-mandate-slice-2b-surface-design.md`.

---

### Task 1: Shared schema + REST route + wiring + supertest test

**Files:**
- Create: `packages/shared/src/validators/mandated-action.ts`
- Modify: `packages/shared/src/index.ts` (export the schema)
- Create: `server/src/routes/mandated-actions.ts`
- Modify: `server/src/services/index.ts` (export `mandatedActionService`)
- Modify: `server/src/app.ts` (mount the route)
- Test: `server/src/__tests__/mandated-actions-route.test.ts`

**Interfaces:**
- Consumes: `mandatedActionService` (2b-core), `validate`, `assertCompanyAccess`, `getActorInfo`.
- Produces: `POST /api/companies/:companyId/mandated-actions` → `MandatedActionResult` JSON; `performMandatedActionSchema`.

- [ ] **Step 1: Shared schema.** Read `packages/shared/src/validators/approval.ts` for the import/export idiom. Create `packages/shared/src/validators/mandated-action.ts`:
```ts
import { z } from "zod";

export const performMandatedActionSchema = z.object({
  granteeAgentId: z.string().uuid().optional(),
  mandateId: z.string().uuid(),
  counterpartyDid: z.string().min(1),
  action: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
});
export type PerformMandatedActionRequest = z.infer<typeof performMandatedActionSchema>;
```
Export it from `packages/shared/src/index.ts` (add a line next to the other validator exports, matching how `approval.ts` is re-exported — check whether it's `export * from "./validators/approval.js"` or a named re-export, and mirror exactly).

- [ ] **Step 2: Service barrel export.** In `server/src/services/index.ts`, add: `export { mandatedActionService } from "./mandated-action.js";`

- [ ] **Step 3: Route.** Create `server/src/routes/mandated-actions.ts`:
```ts
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { performMandatedActionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { mandatedActionService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function mandatedActionRoutes(db: Db) {
  const router = Router();
  const svc = mandatedActionService(db);

  router.post("/companies/:companyId/mandated-actions", validate(performMandatedActionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const granteeAgentId = (req.body.granteeAgentId as string | undefined) ?? actor.agentId ?? undefined;
    if (!granteeAgentId) {
      res.status(400).json({ error: "granteeAgentId is required when the caller is not an agent" });
      return;
    }
    const result = await svc.performMandatedAction({
      granteeAgentId,
      mandateId: req.body.mandateId,
      counterpartyDid: req.body.counterpartyDid,
      action: req.body.action,
      payload: req.body.payload,
    });
    res.json(result);
  });

  return router;
}
```
> Confirm the exact `validate` import path and `getActorInfo` return shape against `approvals.ts` (it imports `validate` from `../middleware/validate.js` and `getActorInfo`/`assertCompanyAccess` from `./authz.js`; `getActorInfo(req).agentId` is `string | null`).

- [ ] **Step 4: Mount in app.ts.** In `server/src/app.ts`, next to the other `api.use(...Routes(db))` lines (e.g. after `api.use(agentRoutes(db, ...))`), add: `api.use(mandatedActionRoutes(db));` and import `mandatedActionRoutes` from `./routes/mandated-actions.js` at the top with the other route imports.

- [ ] **Step 5: Failing supertest test.** Create `server/src/__tests__/mandated-actions-route.test.ts`, mirroring the embedded-PG + actor-injection pattern in `billing-trial-lifecycle.test.ts` (an express app with a middleware that sets `(req as any).actor` before mounting the router). Read that file's setup first. Structure:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { startEmbeddedPostgresTestDatabase, createDb, companies, agents } from "@paperclipai/db";
import { mandatedActionRoutes } from "../routes/mandated-actions.ts";
// ... build embedded PG, createDb, insert a company + agent, capture ids

// app with an injected agent actor:
function appFor(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use(mandatedActionRoutes(db));
  return app;
}
```
Cases (flag-off):
- valid body, nonexistent `mandateId` (random uuid), agent actor `{ type:"agent", agentId, companyId }` → `POST /companies/:companyId/mandated-actions` → **200**, body `{ authorized:false, reason:"not_found" }`.
- missing `mandateId` → **400** (validate).
- agent actor whose `companyId` differs from the URL company → **403** (assertCompanyAccess throws; confirm the app's error handler maps it to 403 — if the router needs an error middleware to translate the thrown authz error, add the same one `app.ts` uses, or assert the thrown status per the repo's convention).

> Note: `assertCompanyAccess` THROWS an http-error; check how `approvals.ts` route errors become HTTP status (there is a shared error-handling middleware). The test app must include that error middleware (import it the same way `app.ts` wires it) so 400/403 surface correctly. If wiring the global error handler is heavy, at minimum assert the 200-denial happy path and the 400 validation path (validate() responds directly), and cover the 403 via the authz unit behavior.

- [ ] **Step 6: Run — RED then GREEN.** `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/mandated-actions-route.test.ts`.

- [ ] **Step 7: Typecheck.** `pnpm --filter @paperclipai/server run typecheck` → exit 0.

- [ ] **Step 8: Commit.**
```bash
git add packages/shared/src/validators/mandated-action.ts packages/shared/src/index.ts server/src/routes/mandated-actions.ts server/src/services/index.ts server/src/app.ts server/src/__tests__/mandated-actions-route.test.ts
git commit -m "feat(server): mandated-actions route (POST /companies/:id/mandated-actions) wrapping the gate"
```

---

### Task 2: AgentDash MCP tool `paperclipMandatedAttest`

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`

**Interfaces:**
- Consumes: the route from Task 1 via `client.requestJson`.

- [ ] **Step 1: Add the tool.** In `packages/mcp-server/src/tools.ts`, add a `makeTool(...)` entry in the tools array (near the approvals tools, e.g. after `paperclipCreateApproval`):
```ts
makeTool(
  "paperclipMandatedAttest",
  "Perform a mandated action: verify the agent's mandate (in-scope, under-cap, unexpired), KYA the counterparty (valid-at-T), then attest the action. Returns { authorized, reason?, receipt? }. Denied when out-of-scope/over-cap/expired or the counterparty can't be verified.",
  z.object({
    companyId: companyIdOptional,
    granteeAgentId: z.string().uuid().optional(),
    mandateId: z.string().uuid(),
    counterpartyDid: z.string().min(1),
    action: z.string().min(1),
    payload: z.record(z.unknown()).optional(),
  }),
  async ({ companyId, ...body }) =>
    client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/mandated-actions`, { body }),
),
```
> `companyIdOptional` and `makeTool`/`z` are already defined/imported at the top of the file — reuse them. No new imports needed.

- [ ] **Step 2: Compile check.** Run `pnpm --filter @paperclipai/mcp-server run typecheck` (or `run build` if no typecheck script) → exit 0. If neither script exists, run `pnpm --filter @paperclipai/mcp-server exec tsc --noEmit`.

- [ ] **Step 3: Commit.**
```bash
git add packages/mcp-server/src/tools.ts
git commit -m "feat(mcp): add paperclipMandatedAttest tool wrapping the mandated-actions route"
```

---

## Self-Review

- Spec §A (schema) → Task 1 Step 1. §B (route + mount + barrel) → Task 1 Steps 2–4. §C (MCP tool) → Task 2. §D (tests) → Task 1 Step 5 + typechecks. All acceptance criteria mapped.
- Placeholder scan: the test's 403 path has an explicit fallback instruction (wire the global error middleware or assert authz behavior) rather than a vague "handle errors" — concrete, with a defined minimum (200 + 400 paths).
- Type consistency: `performMandatedActionSchema` shared between route (`validate`) and tool; the route's `performMandatedAction({...})` arg matches `MandatedActionInput` from 2b-core (granteeAgentId, mandateId, counterpartyDid, action, payload).
- No over-build: no approvals/persistence/UI; the tool is a thin REST wrapper.
