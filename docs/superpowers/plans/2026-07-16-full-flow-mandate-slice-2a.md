# Full-Flow Demo — Slice 2a (Agent→Clockchain DID provisioning) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Provision and persist a Clockchain DID per AgentDash agent, and rewire `mandatesService` to resolve grantor/grantee DIDs itself — closing the Slice-1 `(row as any).grantorDid` seam.

**Architecture:** New nullable `agents.clockchainDid` column (hand-written migration). `clockchainService` gains flag-gated `mintIdentity`/`resolveAgent` wrappers. New `agentIdentityService.resolveAgentDid(agentId)` returns the stored DID or lazy-mints+persists (off critical path). `mandatesService` drops caller-passed DIDs and resolves them via the identity service.

**Tech Stack:** TypeScript ESM (`.js` specifiers), Drizzle + Postgres (embedded PGlite in test), vitest, pnpm workspaces.

## Global Constraints

- Company-scoped conventions unchanged; `clockchainDid` is per-agent.
- ESM `.js` import specifiers.
- Migrations are HAND-WRITTEN `.sql` + `_journal.json` entry (idx increments; no snapshot). `drizzle-kit generate` is unusable (snapshot chain stale at 0079). Follow `0080_…`–`0087_mandates.sql`.
- Test command: `pnpm exec vitest run --project @paperclipai/server <file>` from repo root. `pnpm --filter @paperclipai/server test` is a NO-OP.
- Flag-gated by `AGENTDASH_ATTESTATION_ENABLED`; identity provisioning is OFF the critical path — `resolveAgentDid`/`mintIdentity` NEVER throw; return `undefined`/`{minted:false}` on disabled/error.
- Truthful: `clockchainDid` persisted only when a real `mint_identity` returns a DID.
- Stage ONLY each task's files with explicit `git add` (working tree has unrelated pre-existing dirty files). Commit on `feat/agentdash-mcp-package`.
- Spec: `docs/superpowers/specs/2026-07-16-full-flow-mandate-slice-2a-design.md`.

---

### Task 1: `agents.clockchainDid` column + migration

**Files:**
- Modify: `packages/db/src/schema/agents.ts` (add one column)
- Create: `packages/db/src/migrations/0088_agent_clockchain_did.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json` (append idx 88)
- Test: `server/src/__tests__/agent-clockchain-did-schema.test.ts`

**Interfaces:**
- Produces: `agents.clockchainDid` (nullable text) on `typeof agents.$inferSelect`.

- [ ] **Step 1: Add the column.** In `packages/db/src/schema/agents.ts`, add inside the `agents` pgTable columns (near `metadata`): `clockchainDid: text("clockchain_did"),`. Confirm `text` is already imported (it is — other text columns exist).

- [ ] **Step 2: Hand-write the migration.** Read `packages/db/src/migrations/0087_mandates.sql` for format. Create `packages/db/src/migrations/0088_agent_clockchain_did.sql`:
```sql
ALTER TABLE "agents" ADD COLUMN "clockchain_did" text;
```

- [ ] **Step 3: Journal entry.** Append to `packages/db/src/migrations/meta/_journal.json` `entries` (mirror the last entry):
```json
{ "idx": 88, "version": "7", "when": 1779580800000, "tag": "0088_agent_clockchain_did", "breakpoints": true }
```
(No snapshot file.)

- [ ] **Step 4: Failing round-trip test.** Create `server/src/__tests__/agent-clockchain-did-schema.test.ts` (model on `mandate-schema.test.ts`'s embedded-postgres harness — import `startEmbeddedPostgresTestDatabase` + `createDb` the way that file does): insert a company + an agent with `clockchainDid: "did:test:x"`, select it back, assert `clockchainDid === "did:test:x"`; insert another agent without it, assert `clockchainDid === null`.

- [ ] **Step 5: Run — RED then GREEN.** `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/agent-clockchain-did-schema.test.ts`. RED before the migration applies (column missing), GREEN after. Capture both.

- [ ] **Step 6: Bootstrap sanity + integrity.** Run `pnpm --filter @paperclipai/db run check:migrations` (exit 0) and one existing embedded-postgres test (`pnpm exec vitest run --project @paperclipai/server server/src/__tests__/costs-service.test.ts`) to confirm 0088 didn't break bootstrap.

- [ ] **Step 7: Commit.**
```bash
git add packages/db/src/schema/agents.ts packages/db/src/migrations/0088_agent_clockchain_did.sql packages/db/src/migrations/meta/_journal.json server/src/__tests__/agent-clockchain-did-schema.test.ts
git commit -m "feat(db): add agents.clockchain_did for agent identity provisioning"
```

---

### Task 2: `mintIdentity` + `resolveAgent` wrappers in `clockchainService`

**Files:**
- Modify: `server/src/services/clockchain.ts`
- Test: `server/src/__tests__/clockchain-service.test.ts` (extend)

**Interfaces:**
- Consumes: existing `callTool`, `clockchainEnabled` (Slice 1).
- Produces on the `clockchainService()` object:
  - `mintIdentity(input: { agentId: string; name?: string; metadata?: Record<string, unknown> }): Promise<{ minted: boolean; did?: string; ledgerId?: string }>`
  - `resolveAgent(did: string): Promise<{ found: boolean; did?: string }>`

- [ ] **Step 1: Failing tests.** In `clockchain-service.test.ts` add a `describe("identity wrappers")`:
  - flag off → `mintIdentity({agentId:"a"})` resolves `{ minted: false }`; `resolveAgent("did:x")` resolves `{ found: false }`.
  - flag on + mocked fetch returning `{ content:[{type:"text",text: JSON.stringify({ did:"did:cc:vega", ledgerId:"led_1" })}] }` → `mintIdentity` resolves `{ minted:true, did:"did:cc:vega", ledgerId:"led_1" }`.
  - flag on + fetch rejects → `mintIdentity` resolves `{ minted:false }` (no throw).

- [ ] **Step 2: Run — RED.** `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/clockchain-service.test.ts` → new cases fail (methods undefined).

- [ ] **Step 3: Implement.** In `server/src/services/clockchain.ts`, add to the object returned by `clockchainService()`:
```ts
async function mintIdentity(input: { agentId: string; name?: string; metadata?: Record<string, unknown> }): Promise<{ minted: boolean; did?: string; ledgerId?: string }> {
  if (!clockchainEnabled()) return { minted: false };
  try {
    const r = await callTool("mint_identity", { agentId: input.agentId, name: input.name, metadata: input.metadata });
    const did = r.did ?? r.identity?.did ?? r.agentDid;
    if (!did) return { minted: false };
    return { minted: true, did, ledgerId: r.ledgerId ?? r.anchor?.ledgerId };
  } catch { return { minted: false }; }
}
async function resolveAgent(did: string): Promise<{ found: boolean; did?: string }> {
  if (!clockchainEnabled()) return { found: false };
  try {
    const r = await callTool("resolve_agent", { did });
    const resolved = r.did ?? r.identity?.did;
    return resolved ? { found: true, did: resolved } : { found: false };
  } catch { return { found: false }; }
}
```
Add `mintIdentity, resolveAgent` to the `return { ... }`.

- [ ] **Step 4: Run — GREEN.** Same command; all cases pass.

- [ ] **Step 5: Commit.**
```bash
git add server/src/services/clockchain.ts server/src/__tests__/clockchain-service.test.ts
git commit -m "feat(server): add mint_identity + resolve_agent wrappers to clockchainService"
```

---

### Task 3: `agentIdentityService.resolveAgentDid`

**Files:**
- Create: `server/src/services/agent-identity.ts`
- Test: `server/src/__tests__/agent-identity-service.test.ts`

**Interfaces:**
- Consumes: `agents` table (Task 1); `clockchainService`, `mintIdentity` (Task 2).
- Produces: `agentIdentityService(db: Db, clock = clockchainService()) => { resolveAgentDid(agentId: string): Promise<string | undefined> }`.

- [ ] **Step 1: Failing tests.** Create `server/src/__tests__/agent-identity-service.test.ts` with a mocked db (a `fakeDb` returning a chosen agent row from `select().from().where()`, and capturing `update().set().where()`), and a mock `clock`:
  - existing did: agent row `{ id:"a1", name:"Vega", clockchainDid:"did:existing" }` → `resolveAgentDid("a1")` returns `"did:existing"`; `clock.mintIdentity` NOT called; no `db.update`.
  - lazy-mint: agent row `{ id:"a1", name:"Vega", clockchainDid: null }`, `clock.mintIdentity` = `vi.fn(async () => ({ minted:true, did:"did:new" }))` → returns `"did:new"`; `db.update` called (persist).
  - mint fails: same row, `clock.mintIdentity` returns `{ minted:false }` → returns `undefined`; no `db.update`.
  - agent not found: `select` resolves `[]` → returns `undefined`; no mint.

- [ ] **Step 2: Run — RED.** `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/agent-identity-service.test.ts` → module not found.

- [ ] **Step 3: Implement.** Create `server/src/services/agent-identity.ts`:
```ts
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { clockchainService } from "./clockchain.js";

export function agentIdentityService(db: Db, clock = clockchainService()) {
  async function resolveAgentDid(agentId: string): Promise<string | undefined> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return undefined;
    if (agent.clockchainDid) return agent.clockchainDid;
    const minted = await clock.mintIdentity({ agentId, name: agent.name });
    if (!minted.minted || !minted.did) return undefined;
    await db.update(agents).set({ clockchainDid: minted.did, updatedAt: new Date() }).where(eq(agents.id, agentId));
    return minted.did;
  }
  return { resolveAgentDid };
}
```

- [ ] **Step 4: Run — GREEN.** Same command; 4 cases pass.

- [ ] **Step 5: Commit.**
```bash
git add server/src/services/agent-identity.ts server/src/__tests__/agent-identity-service.test.ts
git commit -m "feat(server): agentIdentityService.resolveAgentDid — stored DID or lazy-mint+persist"
```

---

### Task 4: Rewire `mandatesService` to resolve DIDs (close the seam)

**Files:**
- Modify: `server/src/services/mandates.ts`
- Test: `server/src/__tests__/mandates-service.test.ts` (update)

**Interfaces:**
- Consumes: `agentIdentityService` (Task 3), `clockchainService` (Slice 1/2).
- Produces (changed): `mandatesService(db: Db, clock = clockchainService(), identity = agentIdentityService(db, clock))`; `CreateMandateInput` no longer has `grantorDid`/`granteeDid`.

- [ ] **Step 1: Update tests first.** In `mandates-service.test.ts`:
  - Remove `grantorDid`/`granteeDid` from `baseInput`.
  - Add a mock `identity = { resolveAgentDid: vi.fn(async (id) => id === "a1" ? "did:atlas" : "did:vega") }` and pass it: `mandatesService(db, clock, identity)`.
  - Update the anchor-writeback test: assert `clock.delegateAuthority` is called with `parentDid:"did:atlas", childDid:"did:vega"` (now resolved via identity, not passed in).
  - In verify tests, the fake rows use `grantorAgentId:"a1"`, `granteeAgentId:"a2"` (NOT `*Did`); the mock identity resolves them. Keep expired/revoked/not_found asserting no chain call.
  - Add a case: when `identity.resolveAgentDid` returns `undefined` for the grantee, `createMandate` still returns the row and `clock.delegateAuthority` is NOT called.

- [ ] **Step 2: Run — RED.** `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/mandates-service.test.ts` → fails (signature/behavior mismatch).

- [ ] **Step 3: Implement.** In `server/src/services/mandates.ts`:
  - Add import: `import { agentIdentityService } from "./agent-identity.js";`
  - Change factory: `export function mandatesService(db: Db, clock = clockchainService(), identity = agentIdentityService(db, clock)) {`
  - Remove `grantorDid`/`granteeDid` from `CreateMandateInput`.
  - In `createMandate`, after inserting the row, resolve DIDs and only anchor when both resolve:
```ts
const grantorDid = await identity.resolveAgentDid(input.grantorAgentId);
const granteeDid = await identity.resolveAgentDid(input.granteeAgentId);
if (grantorDid && granteeDid) {
  const anchor = await clock
    .delegateAuthority({ parentDid: grantorDid, childDid: granteeDid, scope: input.scope, until: input.expiresAt.toISOString() })
    .catch(() => ({ anchored: false as const }));
  if (anchor.anchored && anchor.ledgerId) {
    const cc = { ccLedgerId: anchor.ledgerId, ccBlockHeight: anchor.blockHeight ?? null, ccScheme: anchor.scheme ?? null, ccAnchoredAt: new Date() };
    await db.update(mandates).set({ ...cc, updatedAt: new Date() }).where(eq(mandates.id, row.id));
    return { ...row, ...cc };
  }
}
return row;
```
  - In `verifyMandate`, replace the `(row as any).grantorDid`/`granteeDid` reads with:
```ts
const parentDid = (await identity.resolveAgentDid(row.grantorAgentId)) ?? "";
const childDid = (await identity.resolveAgentDid(row.granteeAgentId)) ?? "";
```
and pass those to `clock.verifyDelegationAt`. Keep the local pre-checks (not_found/revoked/expired) BEFORE resolving DIDs / calling the chain. Remove the old NOTE comment about the `as any` seam (replace with a one-line comment that DIDs are resolved via the identity service).

- [ ] **Step 4: Run — GREEN.** Same command; all cases pass.

- [ ] **Step 5: Typecheck.** `pnpm --filter @paperclipai/server run typecheck` → exit 0 (catches any leftover `grantorDid` reference).

- [ ] **Step 6: Commit.**
```bash
git add server/src/services/mandates.ts server/src/__tests__/mandates-service.test.ts
git commit -m "refactor(server): resolve mandate DIDs via agentIdentityService (close Slice-1 seam)"
```

---

## Self-Review

- Spec §A (column) → Task 1. §B (mint/resolve wrappers) → Task 2. §C (resolveAgentDid) → Task 3. §D (rewire mandates) → Task 4. §E (tests/honesty) → across all. Migrations → Task 1. All acceptance criteria mapped.
- Placeholder scan: none — `mint_identity` field fallbacks (`r.did ?? r.identity?.did ?? r.agentDid`) are concrete defensive reads, with the live-tool confirmation tracked as the spec's follow-up.
- Type consistency: `mintIdentity` → `{minted, did?, ledgerId?}`, `resolveAgentDid` → `string | undefined`, `mandatesService(db, clock, identity)` used identically in Tasks 3–4.
- No over-build: no gate/attest/bounce-back/UI (2b/2c). `resolveAgent` is added now (cheap, same file) for 2b; acceptable as it's part of the identity wrapper pair.
