# Full-Flow Demo — Slice 1: Mandate primitive + Clockchain wiring

**Date:** 2026-07-15
**Repo:** agentdash (paperclip) · build against local `pnpm dev` (`localhost:3100`), port to the mini later
**Linear:** CLO-147 (full-flow demo — human mandate → agent execution), Agentic use cases
**Source of truth:** 2026-07-13 Clockchain Agent Handshake Workshop — https://docs.google.com/document/d/13fMdVdhtywF00UxVHL4Jp-yoEjB9__g99Ust7r1YptM/edit

## Context

CLO-147 is the fully-live full-flow demo: a **human grants an agent a scoped, time-boxed mandate + spend cap**, and the agent then **autonomously executes tasks against it** (check mandate → KYA the counterparty → attest → receipt), calling the real Clockchain testnet. Per the workshop (decision B), the mandate originates on the **customer's own agent platform** — AgentDash — with Clockchain supplying the primitive (`delegate_authority` anchors it; `verify_delegation_at` checks it). We extend the **existing Meridian company**; **Atlas** (CoS) grants the mandate — he already owns `delegate_authority` in the Meridian demo map.

This is a ~3–4 week effort spanning DB + server + a first Clockchain MCP client + the agent run-loop + UI, so it is decomposed into slices:

1. **Mandate primitive + Clockchain wiring** ← *this spec*
2. Agent-side enforcement (`verify_delegation_at` + KYA gate each action; out-of-scope/over-cap → `approvals` bounce-back)
3. Attest + receipt ("Attested via Clockchain" in `Activity`/`DashboardLive`)
4. Human grant UI + activity/loop view

**Slice 1 scope:** the `Mandate` entity, the first real Clockchain MCP client in AgentDash, the grant path (anchor via `delegate_authority`), and the read/verify path (`verify_delegation_at`). No agent-loop wiring and no UI in this slice — those are Slices 2–4.

## Non-goals (Slice 1)

- No agent run-loop integration (Slice 2).
- No UI (Slice 4). Slice 1 is exercised via a server service method + a CLI/route + tests.
- No x402 payment/settlement (separate, honestly labeled "simulated"; CLO-138/149).
- No new Clockchain gateway capability — compose existing live tools only.

## Design

### A. `Mandate` data model

New table `mandates` (Drizzle schema `packages/db/src/schema/mandates.ts`, exported from `schema/index.ts`), company-scoped like every other table. It **composes** the existing primitives rather than reinventing them, adding only the time-box and the Clockchain anchor:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `companyId` | uuid → companies | company-scoped (hard rule) |
| `grantorAgentId` | uuid → agents | who granted (Atlas / human proxy) |
| `granteeAgentId` | uuid → agents | the empowered agent (e.g. Vega) |
| `scope` | jsonb | what it may do — same shape as `principal_permission_grants.scope` |
| `permissionKey` | text | reuse the permission-key vocabulary (`constants.ts`) |
| `spendCapCents` | integer | budget for the agent's Clockchain usage (credits), not deal value |
| `budgetPolicyId` | uuid → budget_policies | reuse existing hard-stop enforcement |
| `expiresAt` | timestamptz | **the time-box** (NEW — grants/budgets have no expiry) |
| `status` | text `active\|expired\|revoked` | |
| `ccLedgerId` | text nullable | Clockchain anchor (set on successful `delegate_authority`) |
| `ccBlockHeight` | integer nullable | |
| `ccScheme` | text nullable | e.g. `salted-v1` |
| `ccAnchoredAt` | timestamptz nullable | |
| `createdAt`/`updatedAt` | timestamptz | defaultNow |

Composition rationale:
- **Scope** mirrors `principal_permission_grants` (`packages/db/src/schema/principal_permission_grants.ts`) — a human→principal grant with an arbitrary JSON scope. We do not extend that table (it has no expiry and is keyed on a uniqueness constraint we don't want to overload); the mandate references the same scope shape.
- **Spend cap** is enforced through the existing `budget_policies` machinery (`schema/budget_policies.ts` + `server/src/services/budgets.ts`, `hardStopEnabled`), via `budgetPolicyId`. The mandate does not re-implement budgets; it points at a policy scoped to the grantee agent.
- **Bounce-back** (Slice 2) uses the existing `approvals` table (`schema/approvals.ts`) — no new gate needed.

The genuinely new schema is `expiresAt`, the `status` lifecycle, and the four `cc*` anchor fields.

### B. First Clockchain MCP client in AgentDash

Today AgentDash has **no** committed Clockchain client — agents hand-build raw callbacks mid-run, and `packages/mcp-server/` is AgentDash's *own* MCP server (exposing AgentDash to clients), not a Clockchain client. Slice 1 adds the first real one:

- **Location:** `server/src/services/clockchain.ts` (a thin server-side client). Modeled on `clockchain-research/src/lib/mcp-client.ts`: StreamableHTTP JSON-RPC to `MCP_SERVER_URL` (default `https://mcp.clockchain.network/mcp`), SSE `data:` frame parsing, `x-api-key` auth from env.
- **Env:** `AGENTDASH_ATTESTATION_ENABLED` (the flag already spec'd in the loop PRD §8), `CLOCKCHAIN_MCP_URL`, `CLOCKCHAIN_MCP_KEY`. Added to `.env.example`.
- **Surface (Slice 1 only):** `delegateAuthority({ parentDid, childDid, scope, until })` and `verifyDelegationAt({ parentDid, childDid, scope, until, at, ledgerId?, blockHeight? })`, each a thin wrapper over `tools/call` for the corresponding `mcp__clockchain__*` tool.
- **Invariant (loop PRD §8):** attestation is **feature-flagged and never on an agent run's critical path** — a Clockchain outage or a disabled flag must degrade gracefully (mandate still records locally; `cc*` fields stay null; verify returns `unavailable`, not an error that stalls anything).

### B2. Agent access model (three layers)

"How an agent gets access" separates into three distinct layers — only one is a secret:

1. **Transport (authentication to Clockchain).** Agents hold **no** Clockchain key. Every Clockchain call goes through the AgentDash server (`server/src/services/clockchain.ts`), which holds one company-level `CLOCKCHAIN_MCP_KEY` (`x-api-key`) — matching the server-only pattern of `clockchain-research/src/lib/mcp-client.ts`. The agent is already authenticated to the AgentDash server by its per-agent key (`x-agent-key`), so the chain is: `agent ──(x-agent-key)──► AgentDash server ──(x-api-key)──► Clockchain MCP`. The Clockchain key never reaches an agent runtime.
2. **Identity (who the agent is on-chain).** Each agent has a Clockchain **DID** (`mint_identity` / `resolve_agent`) — the `granteeDid` in the mandate and the actor in `attest_action`. Public, not a secret; distinct from the transport key.
3. **Authorization (what the agent may do).** The mandate `delegate_authority {parent: grantorDid, child: agentDid, scope, until}` **is** the access grant. Every consequential action (Slice 2) is checked via `verify_delegation_at` for the agent's DID (in-scope / under-cap / unexpired), fail-closed. So the **mandate is the real access control**, enforced server-side — possession of the shared transport key does not let an agent exceed its grant.

**Production caveat (trust boundary — honesty NFR).** Authorization is enforced by the **AgentDash server, not by Clockchain.** All agents share one `CLOCKCHAIN_MCP_KEY`; Clockchain will honor any in-key call — it does not gate calls against the mandate it anchored (non-custodial / attestation-only). The security therefore rests on: (a) the AgentDash server being the trust boundary and reliably running `verify_delegation_at` + the budget hard-stop **before** each Clockchain call, and (b) the key being server-only, rotated, least-privilege. On-chain attribution stays per-agent because the **DID** (not the key) is stamped into each `attest_action`. We must **not** claim "Clockchain-enforced authorization" — it is AgentDash-enforced. The defense-in-depth model — per-agent / per-mandate **scoped tokens issued by Clockchain**, so the gateway itself rejects out-of-scope calls — is **not available today** (Clockchain scopes are coarse/per-surface; `/token` mints a shared key, not a per-mandate token). Tracked as a Clockchain-side production-hardening follow-up (see below).

### C. Grant + verify flow

- **Grant** (`server/src/services/mandates.ts` → `createMandate`): insert the `mandate` row (status `active`, `cc*` null) → if the flag is on, call `delegateAuthority` anchoring `{parent: grantorDid, child: granteeDid, scope, until: expiresAt}` → on success, write back `ccLedgerId`/`ccBlockHeight`/`ccScheme`/`ccAnchoredAt`. The anchor is a **real testnet write** — the honest artifact. Grantor/grantee DIDs resolve from the agents' Clockchain identities (Meridian agents already mint identities; if absent, mint via `mint_identity` — out of Slice-1 scope, assume present or stub the DID mapping with a TODO tracked for Slice 2).
- **Verify** (`verifyMandate(mandateId, at)`): call `verifyDelegationAt` with the mandate's stored fields; return `{ authorized, reason, grantedAt, expiresAt, revokedAt, evidence: { ledgerId } }`. Re-derives the verdict from the immutable on-chain record (keyless). Slice 2 calls this from the agent loop; Slice 1 exposes it via a CLI command / dev route and tests it.

### D. Testing & honesty

- **Unit:** window/scope/cap logic — before-grant → unauthorized; active/in-scope/under-cap → authorized; past `expiresAt` → unauthorized `expired`; revoked → unauthorized `revoked`. Deterministic, Clockchain call mocked.
- **Integration (flag/key-gated, skipped otherwise):** one real `delegateAuthority` → `verifyDelegationAt` round-trip against testnet; assert the anchored hash re-verifies and the verdict flips across `expiresAt`.
- **Honesty:** flag-gated; off critical path; `cc*` null until the anchor truly lands (mirror Clockchain's truthful-anchoring rule — never present a pending/degraded mandate as confirmed).

### Migrations

Add `schema/mandates.ts`, export from `schema/index.ts`, then `pnpm --filter @paperclipai/db generate` (drizzle-kit) → `pnpm --filter @paperclipai/db migrate` (`src/migrate.ts`). Follow `check:migrations`.

## Acceptance criteria (Slice 1)

- [ ] `mandates` table exists via a generated Drizzle migration; company-scoped; composes `budget_policies` and mirrors the `principal_permission_grants` scope shape; adds `expiresAt`, `status`, and `cc*` anchor fields.
- [ ] `server/src/services/clockchain.ts` exists, flag-gated by `AGENTDASH_ATTESTATION_ENABLED`, exposing `delegateAuthority` + `verifyDelegationAt`; env documented in `.env.example`.
- [ ] `createMandate` anchors a **real** `delegate_authority` record on testnet (when enabled) and stores `ccLedgerId`/`ccBlockHeight`; degrades gracefully (row still created, `cc*` null) when the flag/key is absent — never stalls.
- [ ] `verifyMandate(id, at)` returns correct valid-at-T verdicts (before-grant / active / expired / revoked), re-derived from the chain.
- [ ] Unit tests deterministic; one flag-gated integration test does the real round-trip; `pnpm test` green.
- [ ] No agent-loop or UI changes (deferred to Slices 2–4).

## Open questions / follow-ups

- Grantee/grantor **DID resolution** for Meridian agents — confirm the existing agent→Clockchain-identity mapping or add `mint_identity` in Slice 2.
- `spendCapCents` denomination — credits vs cents — align with CLO-149 (x402 credits) when Slice 3 lands.
- Whether `verifyMandate` should also short-circuit on the local `status`/`expiresAt` before the chain call (cheap pre-check) — decide in the plan.
- **Production hardening (Clockchain-side):** per-agent / per-mandate scoped transport tokens issued by Clockchain, so the gateway itself rejects out-of-scope calls (defense-in-depth beyond the AgentDash-enforced trust boundary in §B2). Not available today; Clockchain gateway roadmap item — file when we move this integration toward production.
