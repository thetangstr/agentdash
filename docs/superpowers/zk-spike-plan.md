# ZK Spike Plan — proof-of-permission / predicate proofs (CLO-136 → CLO-119/137)

**Date:** 2026-07-18
**Decision context (from the D4-repo review):** the network has NO ZK and does NOT need it for confidentiality-from-validators (it uses encryption/HMAC subnet modes). The network's role for ZK is **anchor-only**: `attest_action` anchors `SHA-256(proof)` and never verifies it — verification is off-chain by the relying party. So ZK is worth building ONLY for the one thing encryption can't do: **predicate/permission proofs** — "prove `amount ≤ cap`" or "prove I hold a permission in scope, valid at T, without revealing the credential/number."

**What the network supports TODAY (no network work):** anchor the proof hash via the existing hosted `attest_action`. What it does NOT do: verify the proof, gate on the predicate, or enforce nullifier-uniqueness (that's app-side). ZK gives *privacy*, not *court-grade* — court-grade is the independent multi-validator axis (#7), still gated on the D4 team.

## The one open question this spike answers
**Can the proof be *generated* fast enough?** "Good enough" (CLO-136 acceptance) = end-to-end (`proof_gen p95 + ~1.4s attest`) **≤ 3s on target hardware**, proof verifies + rejects tampered inputs. Server-side is expected GO; **in-browser/mobile is the real risk.**

## Statement to prove (frozen)
> The prover holds a permission credential in scope `S`, issued by authority `A`, valid at time `T` — without revealing the credential.

Model: authority `A` maintains a Merkle set of issued permission commitments. Prove in ZK: (a) knowledge of the secret behind a leaf in `A`'s current root, (b) leaf scope == `S`, (c) `expiry >= T`, (d) emit a nullifier (double-use detectable). **Public:** root, S, T (epoch), nullifier. **Private:** credential secret + Merkle path.

For the predicate variant ("amount ≤ cap"): same membership shape + a range constraint `amount <= cap` with `amount` private, `cap` public.

## Stacks (carry two, per CLO-136)
1. **Semaphore v4** (Groth16, PSE) — native membership+nullifier fit; trusted setup already done (no local ceremony); ~256-byte proofs; sub-second–~2s node. **Primary.**
2. **Noir + Barretenberg UltraHonk** (Aztec) — no trusted setup; <3s M1 / <10s modern Android; larger proofs (irrelevant — we only anchor the hash). **Secondary / no-trusted-setup fallback.**
3. circom+snarkjs Groth16 = fallback ONLY. If benchmarked, use `rapidsnark`, NOT snarkjs (snarkjs is the slow impl; benchmarking it and concluding "Groth16 is slow" is the classic mistake).

## Spike deliverables (throwaway `zk-spike/`, NOT wired into product)
- `zk-spike/semaphore-bench.mjs` — build a group (~10k dummy members), generate N membership proofs with signal `{S, T}`, measure proving p50/p95, proof size, peak memory (node).
- `zk-spike/anchor-integration.mjs` — take one real Semaphore proof, `SHA-256` it, anchor via the live hosted `attest_action` (proving the network-supports-anchoring claim end-to-end), and off-chain-verify the proof.
- `zk-spike/RESULTS.md` — hardware matrix + numbers table.
- `zk-spike/GO-NO-GO.md` — recommended stack, node number, browser verdict (measured or explicitly deferred), residual risks.

## Steps
1. **Node benchmark first (this session):** Semaphore v4 in node — real membership proof, real proving latency p50/p95. This alone answers "server-side GO?" — the high-confidence half.
2. **Anchor integration:** SHA-256 the proof → `attest_action` on the live gateway → confirm anchored + off-chain verify the proof. Proves the network's anchor-only role works for ZK today.
3. **Browser (deferred / stretch):** the real risk tier. If not run this session, GO/NO-GO records an explicit "in-browser UNMEASURED — server-side proving recommended" rather than guessing.
4. **Write GO/NO-GO** naming ONE stack + the honest server-vs-browser split.

## Acceptance (CLO-136)
- [ ] Results table: proving p50/p95, proof size, setup requirement for ≥1 stack (Semaphore), node tier (browser deferred if not run).
- [ ] End-to-end anchor: a real proof's hash anchored via `attest_action`, off-chain verify passes, tampered inputs rejected.
- [ ] Written GO/NO-GO naming ONE recommended stack + server-vs-browser verdict + residual risks.
- [ ] Explicit statement: the network supports the anchor role today; verification/predicate-gate/nullifier-dedup are app-side.

## Non-goals
- No product wiring (that's CLO-137, gated on GO).
- No on-chain verification (the network never verifies; by design).
- No court-grade claim (independent axis, #7/CLO-64).
- Not a general privacy layer — encryption/HMAC subnet modes cover confidentiality-from-validators; ZK is predicate-only.
