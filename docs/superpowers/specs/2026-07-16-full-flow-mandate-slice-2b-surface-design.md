# Full-Flow Demo — Slice 2b-surface: the agent-facing gate surface (route + MCP tool)

**Date:** 2026-07-16
**Repo:** agentdash (paperclip), branch `feat/agentdash-mcp-package`.
**Linear:** CLO-147 / CLO-157. **Predecessor:** 2b-core (`performMandatedAction` gate logic, head `36f1bdc24`).

## Context

2b-core built the gate *logic* (`mandatedActionService.performMandatedAction`). 2b-surface exposes it so an agent can actually call it: a REST route on the AgentDash server + an AgentDash MCP tool that wraps the route. AgentDash's MCP server is a **separate stdio process that calls the server over REST** (`client.requestJson`, `PAPERCLIP_API_URL`), so both pieces are required for the agent → tool → route → gate → Clockchain path.

## Non-goals
- No approvals bounce-back (2c) — a denied action returns `{authorized:false, reason}` to the caller as-is.
- No UI. No new gate logic (2b-core owns it).

## Design

### A. Shared request schema
`packages/shared/src/validators/mandated-action.ts` (exported from `packages/shared/src/index.ts`), following `validators/approval.ts`:
```ts
export const performMandatedActionSchema = z.object({
  granteeAgentId: z.string().uuid().optional(), // defaults to the acting agent
  mandateId: z.string().uuid(),
  counterpartyDid: z.string().min(1),
  action: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
});
```

### B. REST route
`server/src/routes/mandated-actions.ts` — `mandatedActionRoutes(db) => Router`, following `approvals.ts`:
- `router.post("/companies/:companyId/mandated-actions", validate(performMandatedActionSchema), handler)`.
- Handler: `const companyId = req.params.companyId; assertCompanyAccess(req, companyId); const actor = getActorInfo(req); const svc = mandatedActionService(db); const result = await svc.performMandatedAction({ granteeAgentId: req.body.granteeAgentId ?? actor.agentId, mandateId, counterpartyDid, action, payload }); res.json(result);`
- If `granteeAgentId` is omitted AND there's no acting agent (`actor.agentId` null) → 400 (the caller must be an agent or name a grantee).
- Mount in `server/src/app.ts` alongside the other `api.use(xRoutes(db))` mounts: `api.use(mandatedActionRoutes(db));`
- Export `mandatedActionService` from `server/src/services/index.ts`.

### C. AgentDash MCP tool
`packages/mcp-server/src/tools.ts` — add via `makeTool`:
```ts
makeTool(
  "paperclipMandatedAttest",
  "Perform a mandated action: verify the agent's mandate, KYA the counterparty (valid-at-T), and attest the action — returns { authorized, reason?, receipt? }. Denied if out-of-scope/over-cap/expired or the counterparty can't be verified.",
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
(No mcp-server tool-count/coverage test exists, so no matrix to update.)

### D. Testing (flag-off — no testnet needed)
- **Route supertest test** (`server/src/__tests__/mandated-actions-route.test.ts`), embedded PG + injected `req.actor`, mirroring `billing-trial-lifecycle.test.ts`'s actor-injection middleware:
  - Seed a company + an agent (the grantee). Inject an `agent` actor `{ type:"agent", agentId, companyId }`.
  - POST a valid body with a random (nonexistent) `mandateId` → **200** + `{ authorized:false, reason:"not_found" }` (proves route → service → db lookup → response wiring; under flag-off nothing hits testnet).
  - POST an invalid body (missing `mandateId`) → **400** (validate middleware).
  - POST to a company the agent actor doesn't belong to → **403** (assertCompanyAccess).
- Typecheck `pnpm --filter @paperclipai/server run typecheck` exit 0; and `pnpm --filter @paperclipai/mcp-server run build` (or typecheck) to confirm the new tool compiles.

## Acceptance criteria
- [ ] `performMandatedActionSchema` exists in shared + exported.
- [ ] `mandatedActionRoutes` mounted in `app.ts`; POST returns the gate result as JSON; `granteeAgentId` defaults to the acting agent; missing grantee+non-agent → 400; cross-company → 403.
- [ ] `paperclipMandatedAttest` MCP tool registered, wrapping the route via `client.requestJson`.
- [ ] Route supertest test (valid→200 denial, invalid→400, cross-company→403) green; server typecheck exit 0; mcp-server compiles.
- [ ] No approvals/bounce-back/UI (2c deferred).

## Open questions / follow-ups
- Whether to persist an attestation/action record + surface it in Activity — deferred to 2c/UI.
- Idempotency / rate-limiting of the route — not needed for the demo; note for hardening.
