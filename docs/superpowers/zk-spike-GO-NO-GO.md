# ZK Spike — GO / NO-GO (CLO-136)

**Date:** 2026-07-18
**Verdict: GO for server-side predicate/permission proofs. DEFER browser until measured. Recommended stack: Semaphore v4 (Groth16).**

## The decision in one line

Server-side Semaphore v4 proving is **1.75 s end-to-end vs a 3 s budget** with a real proof anchored on-chain (block 1,373,872) — so the one open question the spike existed to answer ("can the proof be generated fast enough?") is **answered YES on the server tier**, and the network's anchor-only role is proven live. Build the ZK permission proof server-side. Do **not** put proving in the browser until it's benchmarked there.

## Recommended stack: Semaphore v4 (Groth16, PSE)

- **Why:** native membership + nullifier fit (exactly our "prove-permission-in-scope, double-use-detectable" statement); trusted setup already done by PSE (no local ceremony to run or trust); 327 ms p50 proving; tiny proofs (irrelevant — we anchor the hash anyway).
- **Fallback (only if browser numbers force it):** Noir + Barretenberg UltraHonk — no trusted setup, but larger proofs and unmeasured latency. Carry as a documented option, don't build it now.
- **Do NOT use snarkjs as the prover** if we ever move Groth16 in-browser — use `rapidsnark`. Benchmarking snarkjs and concluding "Groth16 is slow" is the classic mistake.

## Server vs browser — the honest split

| tier | status | number |
|---|---|---|
| **Server-side (node)** | **GO** ✅ | 352 ms p95 proof + 1.4 s attest = **1.75 s** (budget 3 s) |
| **In-browser / mobile** | **UNMEASURED — DEFER** ⚠️ | the real risk; not run this session |

For the demo and the near-term product, **prove server-side** (the agent/backend generates the proof; the human's browser never proves). This sidesteps the entire browser-latency risk. Only if a future requirement demands client-side proving (the credential secret must never leave the user's device) do we need the browser benchmark — and that is the one thing that could still turn NO-GO.

## What the network does and does NOT do (unchanged, now proven end-to-end)

- **Supports today, no network work:** anchor `SHA-256(proof)` via the existing hosted `attest_action`. Verified live: ledger `716ccbac…`, block 1,373,872, status `anchored`.
- **Does NOT:** verify the proof, gate on the predicate, or enforce nullifier-uniqueness. All three are **app-side** (the relying party verifies off-chain; our app dedups nullifiers).
- **ZK gives privacy, not court-grade.** Court-grade is the independent multi-validator axis (#7 / CLO-64), still gated on the D4 team's Phase 7 (real quorum-signature verification) + P0-5 (proven multi-node). Different build, different owner.

## Scope reminder — ZK is predicate-only

Per the D4-repo review: the network already plans confidentiality-from-validators via `ENCRYPTED_BATCH` / `HMAC_COMMITMENT` subnet modes (no ZK, no latency risk) — once wired. So reserve ZK strictly for the **one thing encryption can't do: predicate proofs** — "prove `amount ≤ cap`" / "prove I hold a permission in scope, valid at T, without revealing the credential." Everything else privacy-wise = encryption/HMAC, not zkSNARKs.

## Residual risks

1. **Browser/mobile proving latency — the live NO-GO risk.** Mitigated for now by proving server-side. Must benchmark before any client-side-proving feature.
2. **Nullifier dedup is app-side.** We must persist seen nullifiers and reject reuse; the network won't do it for us.
3. **Verification is app-side.** The relying party (counterparty agent/company) must run `verifyProof`; the anchor only proves *when* the proof existed, not that it's valid.
4. **Trusted setup trust.** Semaphore relies on PSE's Groth16 ceremony. Acceptable for our use (widely used), but note it; Noir/UltraHonk removes this if it ever becomes a concern.
5. **Predicate/range variant unmeasured.** Adds a few constraints; expected within the server envelope but confirm with a timing run before shipping the `amount ≤ cap` flow (CLO-137).

## Next (CLO-137, gated on this GO)

Wire a minimal server-side permission-proof: authority maintains the commitment set → agent proves membership+scope+epoch → `SHA-256(proof)` anchored via `attest_action` → counterparty verifies off-chain + checks the anchor timestamp + dedups the nullifier. Keep it behind a flag; this spike code stays throwaway.
