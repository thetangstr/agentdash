# ZK Spike — RESULTS (CLO-136)

**Date:** 2026-07-18
**Stack measured:** Semaphore v4.14.3 (Groth16, PSE trusted setup — no local ceremony).
**Statement proved:** membership in a 10k-member authority set + nullifier + a signal binding `{scope S, epoch T}`. Public: root, nullifier, message(=signal), scope. Private: identity secret + Merkle path. This is exactly the anchor-only shape — we `SHA-256` the proof and anchor the 32-byte digest; the network never opens the proof.

## Proving latency (node v22.23.1, Apple Silicon, 10,000-member group)

| metric | value |
|---|---|
| proving **p50** | **327 ms** |
| proving **p95** | **352 ms** |
| proving mean | 327 ms |
| proving min / max | 312 / 352 ms |
| first proof (cold, compiles wasm/zkey) | 492 ms (one-time) |
| group build (10k Poseidon hashes) | 131.8 s — **one-time authority setup**, not per-proof |
| proof size (serialized) | ~637 bytes → **anchored as a 32-byte SHA-256** |
| tampered proof rejected | **true** (negative check passes) |
| off-chain verify | **true** |

Steady-state proving is remarkably tight (312–352 ms across 8 runs) — Groth16 proving cost is dominated by the fixed circuit, not the 10k group size (group size only affects the one-time tree build + the Merkle-depth constant baked into the circuit).

## End-to-end (server-side)

```
proof_gen p95 (352 ms) + attest_action (~1.4 s) = 1.75 s
budget ≤ 3 s → PASS ✅
```

## Anchor-integration (live hosted gateway, mcp.clockchain.network)

Real Semaphore proof → `SHA-256(proof)` → `attest_action` on the live gateway → confirm anchored + off-chain verify.

| step | result |
|---|---|
| ZK proof off-chain verify | **true** |
| proof SHA-256 | `bedd6d42…4887619c` |
| anchored ledgerId | `716ccbac-2322-4c61-a387-435237dcb5e9` |
| **blockHeight** | **1,373,872** |
| status | **`anchored`** (real block, not degraded) |
| receipt eventHash | `359f623d2bb0b496…` |

**PASS — the network supports the ZK anchor role TODAY, no network changes.** The gateway anchored the hash and never saw the proof; verification stayed off-chain by design.

## What is NOT measured this run

- **In-browser / mobile proving** — the real risk tier, deliberately deferred (see GO-NO-GO). A fast node number does NOT clear the browser budget; snarkjs-in-wasm and mobile CPUs are the unknown.
- **Noir/UltraHonk secondary stack** — not benchmarked; carried in the plan only as a no-trusted-setup fallback if browser numbers force it.
- **Predicate/range variant** (`amount ≤ cap`) — same membership shape + a range constraint; not separately timed, but adds only a handful of constraints, well within the measured envelope on the server tier.
