# Turnkey two-company Agent Trust Handshake demo — design

**Date:** 2026-07-17
**Goal (from Yang):** a turnkey "Go" demo — flip a switch and the full two-company handshake plays **live** (real gateway calls, real receipts), so the `/handshake` page is no longer a static mock. Driver: **scripted-real** (deterministic orchestrator makes real calls; framed as the agent acting; reliable + repeatable).

## The "Go" flow (scripted-real, pauses for two human approvals)

1. **Discover** — orchestrator confirms the Clockchain MCP is reachable + lists the tools (real `tools/list`). UI: "AgentDash found the Clockchain MCP."
2. **Approve (Meridian human)** — onboarding gate: "Allow this agent to use Clockchain?" → human approves.
3. **Publish mandate** — Meridian (payer) publishes a mandate (scope + cap + expiry) addressed to Trellis; anchored on-chain via `delegate_authority`.
4. **Trellis sees it** — Trellis's view lists Meridian's published mandate (cross-company read).
5. **Approve (Trellis human)** — "Accept this mandate — we can transact?" → human approves.
6. **Transact** — Meridian's agent KYAs Trellis's agent (`verify_identity_at`, valid-at-T) + attests the action (`attest_action`) → real receipt. Both sides verify keylessly (`verify_cross_party`).

## Novel capability: cross-company published mandates

Mandates are intra-company today. Add a **published mandate**: a `mandates` row flagged `published: bool` + `counterpartyCompanyId: uuid` (nullable), with:
- `POST /companies/:id/mandates/:mandateId/publish` (Meridian publishes to Trellis).
- `GET /companies/:id/incoming-mandates` (Trellis lists mandates published TO it).
The mandate terms (scope/cap/expiry) + its on-chain `ccLedgerId` are visible to the counterparty; the actuals (who attested what) flow through the existing gate. This is the one genuinely new mechanism.

## Build order

1. **Cross-company published mandates** — schema flag + counterpartyCompanyId + publish route + incoming-mandates GET + UI on both sides. (Biggest gap; unblocks the rest.)
2. **Discover + approve onboarding** — a "connect to Clockchain" moment (real `tools/list`) + a new approval type (`clockchain_onboarding`) for the human gate.
3. **"Go" orchestrator** — one endpoint + UI button that runs the scripted-real flow, pausing at the two approvals (Meridian onboarding, Trellis accept). Real gateway calls at each step; deterministic; resumable.
4. **Two-company seed + live page** — seed Meridian + Trellis (agents Iris/Billie); wire `/handshake` (or a new `/handshake-demo` route) to the orchestrator so the page reflects live state, not hardcoded literals. Retire the static mock.

## Non-goals (this demo)
- No real x402 money movement (Clockchain attests; settlement stays simulated per the existing `/handshake` framing).
- No real LLM autonomy (scripted-real by decision).
- No multi-validator (testnet single-validator; honest disclaimer stays).

## Honesty
- The "agent acts" is scripted-real, not autonomous — the page should say the agent acts on the mandate, not that it "decides to."
- Testnet single-validator / degraded — real anchors, no court-grade claim.
