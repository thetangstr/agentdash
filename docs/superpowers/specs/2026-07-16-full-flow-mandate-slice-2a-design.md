# Full-Flow Demo — Slice 2a: Agent→Clockchain DID provisioning (closes the Slice-1 seam)

**Date:** 2026-07-16
**Repo:** agentdash (paperclip), branch `feat/agentdash-mcp-package`, local `pnpm dev` (`localhost:3100`)
**Linear:** CLO-147. **Predecessor:** Slice 1 (`docs/superpowers/specs/2026-07-15-full-flow-mandate-slice-1-design.md`, built — head `4168c5b01`).

## Context

Slice 1 left an intentional seam: `mandatesService.verifyMandate` reads `(row as any).grantorDid`/`granteeDid`, which don't exist on a real `mandates` row (only `grantorAgentId`/`granteeAgentId` do), and `createMandate` requires the caller to pass DIDs. Investigation (2026-07-16) confirmed **there is no agent↔Clockchain-DID mapping anywhere** — fully greenfield. Slice 2a adds it and rewires `mandatesService` to resolve DIDs itself, so grant + verify use real, provisioned agent identities.

This is the first sub-slice of Slice 2 (agent-side enforcement). The gate itself (server-side mandated action = composite `verify_delegation_at` + KYA + attest, per CLO-157) and the approvals bounce-back are 2b/2c.

## Non-goals (2a)

- No gate, no attest, no bounce-back (2b/2c).
- No agent-loop or UI wiring.
- No KYA / counterparty verification.

## Design

### A. `agents.clockchainDid` column
Add a nullable `clockchainDid: text("clockchain_did")` to the `agents` table (`packages/db/src/schema/agents.ts`). Stores the agent's provisioned Clockchain DID (null until first provisioned). Migration is **hand-written** `packages/db/src/migrations/0088_agent_clockchain_did.sql` + a `meta/_journal.json` entry (idx 88, tag `0088_agent_clockchain_did`, no snapshot) — per the repo's established 0080–0087 precedent (drizzle-kit generate is unusable; snapshot chain stale at 0079).

### B. Extend `clockchainService` with identity wrappers
Add to `server/src/services/clockchain.ts`, same shape/discipline as the existing `delegateAuthority`/`verifyDelegationAt` (flag-gated, off critical path, all errors caught):
- `mintIdentity(input: { agentId: string; name?: string; metadata?: Record<string, unknown> }): Promise<{ minted: boolean; did?: string; ledgerId?: string }>` — wraps the `mint_identity` MCP tool; returns `{ minted: false }` when the flag is off or on any error; `did` set only when the tool actually returns one.
- `resolveAgent(did: string): Promise<{ found: boolean; did?: string }>` — wraps `resolve_agent`; `{ found: false }` when disabled/error. (Included for completeness / 2b; 2a only strictly needs `mintIdentity`.)

### C. `resolveAgentDid` — the seam replacement
New `server/src/services/agent-identity.ts`:
`agentIdentityService(db: Db, clock = clockchainService()) => { resolveAgentDid(agentId: string): Promise<string | undefined> }`
Logic:
1. Load the agent row; read `clockchainDid`. If present → return it.
2. Else, if `clockchainEnabled()`, lazy-mint: `clock.mintIdentity({ agentId, name: agent.name })`; if `minted && did`, persist `agents.clockchainDid = did` (update) and return `did`.
3. Otherwise (flag off, mint failed, or agent not found) → return `undefined`. **Off critical path** — never throws.

### D. Rewire `mandatesService` (close the seam)
`server/src/services/mandates.ts`:
- Inject the identity service: `mandatesService(db, clock = clockchainService(), identity = agentIdentityService(db, clock))`.
- `CreateMandateInput` **drops** `grantorDid`/`granteeDid`. `createMandate` resolves them: `const grantorDid = await identity.resolveAgentDid(input.grantorAgentId); const granteeDid = await identity.resolveAgentDid(input.granteeAgentId);` If either is `undefined` (flag off / not provisioned), skip anchoring (pass through to `delegateAuthority`, which no-ops under flag-off anyway) — the row is still created (graceful, unchanged Slice-1 behavior). Only call `delegateAuthority` when both DIDs resolve.
- `verifyMandate` replaces `(row as any).grantorDid`/`granteeDid` with `await identity.resolveAgentDid(row.grantorAgentId)` / `(row.granteeAgentId)`. Keep the local pre-checks (revoked/expired/not_found) first; if a DID can't resolve, the chain call gets empty DIDs → fail-closed `unauthorized` (never a bogus authorized), consistent with the Slice-1 whole-branch review.

### E. Testing & honesty
- Unit-test `resolveAgentDid`: (a) existing `clockchainDid` → returned, no mint; (b) absent + flag-on → mints, persists, returns did; (c) flag-off → `undefined`, no mint; (d) mint returns `{minted:false}` → `undefined`, no persist.
- Update `mandates-service.test.ts`: inject a mock `identity` returning fixed DIDs; drop the `*Did` fields from `baseInput`; keep the existing 7 behaviors (anchor-writeback, unavailable-still-creates, throwing-clock, expired/revoked/not_found, active-delegates). Add: createMandate does NOT call `delegateAuthority` when a DID fails to resolve.
- Flag-gated (skipped otherwise): extend the integration test to mint two identities and grant a mandate resolving real DIDs — deferred to when a testnet key is available; keep it `describe.skip` under flag-off.
- Honesty: `clockchainDid` stays null until a real mint returns a DID; lazy-mint is off the critical path.

### Migrations
`ALTER TABLE "agents" ADD COLUMN "clockchain_did" text;` in `0088_...sql`; journal entry idx 88. `check:migrations` must pass; embedded-postgres tests re-bootstrap through 0088.

## Acceptance criteria (2a)
- [ ] `agents.clockchainDid` nullable column exists via hand-written migration `0088` + journal entry; `check:migrations` green; a bootstrap sanity test still passes.
- [ ] `clockchainService` exposes `mintIdentity` + `resolveAgent`, flag-gated, never throw; `did` set only on a real tool response.
- [ ] `agentIdentityService.resolveAgentDid` returns an existing DID, lazy-mints+persists when absent (flag-on), and returns `undefined` gracefully when disabled/failed — never throws.
- [ ] `mandatesService` no longer reads `(row as any).*Did`; `CreateMandateInput` has no `*Did` fields; grant + verify resolve DIDs via the identity service; anchoring is skipped (row still created) when a DID can't resolve.
- [ ] Unit tests cover all `resolveAgentDid` branches + the updated mandates behaviors; `pnpm exec vitest run --project @paperclipai/server` (focused files) green.
- [ ] No gate/attest/bounce-back/UI (2b/2c deferred).

## Open questions / follow-ups
- `mint_identity` exact request/response fields — confirm against the live tool (the wrapper reads `did`/`ledgerId` with fallbacks; the flag-gated integration test locks it when a key is available).
- Concurrency: two mandates for the same unprovisioned agent could double-mint. For the demo, last-write-wins on `clockchainDid` is acceptable; a unique-guard is a later hardening (note, don't build now).
