# D4 network repos — ZK feasibility findings (review, not yet an integration point)

**Date:** 2026-07-18
**Repos reviewed (read-only clones):** `InfoObjects/d4` @ `dev` (the real Clockchain validator network backend, Java/Maven), `InfoObjects/d4-ui` (customer-facing React dashboard). These are the NEW architecture — NOT our current integration point (we still hit the hosted MCP `mcp.clockchain.network`). Purpose of this review: what do they tell us about ZK feasibility for the handshake.

## Headline for the ZK question

**The D4 network has NO zero-knowledge cryptography — none, in either repo.** "zk" everywhere in the backend means **ZooKeeper** (Curator/LeaderLatch coordination), not zero-knowledge. So the earlier feasibility read stands, now with hard evidence: **ZK is greenfield — there is nothing in the network to build on, and the network does not need ZK for its privacy model.**

## What the network actually uses for privacy (instead of ZK)

The backend's confidentiality is **commitment + encryption based**, documented in `d4/docs/privacy-modes.md` as four subnet privacy modes:
1. `PUBLIC_HASH` — `SHA-256(nodeId|timestamp|seq)`, validators see everything.
2. `SALTED_COMMITMENT` — `SHA-256(salt|…)`, customer-held salt.
3. `HMAC_COMMITMENT` — `HMAC-SHA256(customerSecret, …)`, per-customer tree isolation (no cross-customer correlation).
4. `ENCRYPTED_BATCH` — payload encrypted to the customer's public key; validators hold **ciphertext only**, hash-of-ciphertext commitment. Highest guarantee.

**Crucial nuance — this is config-wired but enforcement-dormant:** the enum + `SubnetConfig.privacyMode` flow through config/registry/admin API end-to-end, and the mode-aware crypto exists (`IngestionReceiptService.computeLeafHash()`), **but `computeLeafHash` has zero call sites.** The production sealing path hard-codes the plaintext `PUBLIC_HASH` leaf. **So today every subnet is effectively PUBLIC_HASH regardless of its configured mode** — the confidentiality-from-validators story is designed + coded at the leaf but not yet invoked. (Salted/HMAC = what our own P0 confidential-attestation work already ships app-side; ENCRYPTED_BATCH is the network's ambition.)

The whole crypto stack: SHA-256 Merkle trees (`TimeRootBuilder`), Ed25519 signatures (`bouncycastle`), OpenTimestamps → Bitcoin anchoring (`BitcoinAnchorService`), web3j for Polygon settlement. No proving system, no circuits, no trusted setup, no verifier, no pairing library.

## Implication for handshake item #3 (ZK proof of permission)

This **sharpens, not changes**, the earlier verdict:
- **ZK remains net-new / greenfield.** Neither the network nor the app has a proving stack. Building it is still the CLO-136 spike → CLO-137 integration path, and the same open question holds: **server-side proving = likely GO; in-browser ≤3s = unknown until measured.**
- **BUT — the network's design tells us ZK may not be the right tool for OUR privacy need.** The network already achieves "validators can't read the payload" via **`ENCRYPTED_BATCH` (public-key encryption to the customer)** and "no cross-customer correlation" via **`HMAC_COMMITMENT`** — WITHOUT ZK. Those are cheap, fast, no-trusted-setup, no-latency-risk. If our actual requirement is *confidentiality from validators + unlinkability* (the workshop's D1/D5 goals), the network's own answer is **encryption/HMAC, not zkSNARKs.**
- **ZK is only strictly required for the ONE thing encryption can't do: predicate proofs** — "prove amount ≤ cap / prove I hold a permission in scope, WITHOUT revealing the value or credential." That's the genuine ZK-only use case (FR4, and the CLO-119 "proof of permission"). Everything else the handshake wants privacy-wise, the network intends to deliver with commitment/encryption modes.
- **New recommendation:** before greenlighting the ZK spike, decide whether the demand is "hide the payload from validators" (→ use the network's ENCRYPTED_BATCH, no ZK, once it's wired) or "prove a predicate without revealing the number" (→ ZK, spike required). These are different builds; the network already plans the first.

## Implication for handshake item #7 (multi-validator / court-grade)

**This repo IS item #7 — the real network exists, and it's a Tendermint/Cosmos BFT system, further along than "one degraded node" implied.** It has the actual ingredients:
- **Tendermint ABCI** consensus (`d4-abci-app`, `jabci`), + custom Mad-Marzullo time consensus + VRF committee election.
- A **real validator set** (`ValidatorSetManager` emits Tendermint `ValidatorUpdate`s, default committee size 10, Ed25519 pubkeys).
- **2/3 quorum** (`QuorumCertificate`, `verifyQuorumCertificate` computes `ceil(2/3 * committee)`).
- **Staking + slashing** (`d4-staking-service`, typed `SlashEvidence`: equivocation, receipt-omission, retrievability-failure, time-fraud).
- **Reputation + DAO governance + token-triggering** modules.

**But it is prototype-maturity, not battle-tested** — and its own roadmap says so (`docs/launch_roadmap.md`, updated 2026-05-19):
- **P0-5: multi-node testnet is UNPROVEN** — "no evidence cluster survives real P2P failover, leader rotation, or epoch recovery."
- **Quorum signatures are NOT verified yet** — `verifyQuorumCertificate` counts distinct validator IDs but skips Ed25519 verification ("enforced from Phase 7 onward"); empty committee returns accept.
- **Slashing sig-path incomplete** (Phase 4); **consensus buffers are in-memory** (restart loses state → false slashing, P0-1); **no ERC-20 token yet** so reward economics are stubs (P0-3).
- **No mainnet date anywhere.** Throughput numbers are design targets, "not yet measured," run on an in-process validator set.

**So the honest court-grade picture is unchanged in substance but clearer in shape:** the multi-validator network is **real and under active development** (this is not vaporware — it's a working Java BFT prototype), but it is **not yet a hardened, multi-node, signature-verifying, mainnet network.** Court-grade still waits on: real quorum signature verification (Phase 7), proven multi-node survival (P0-5), restart-safe consensus (P0-1), and a mainnet with a genuine independent validator set. **We (app-side) still cannot make it court-grade; the D4 team must finish the network.** Our CLO-64 "readiness code" (flip receipts to `multi-validator` on real quorum data) is exactly right and now has a concrete counterpart to integrate against when Phase 7 lands.

## Integration seam (for when we DO integrate — not yet)

`SubnetProofController` exposes `GET /api/v1/subnet/{subnetId}/proof/{eventId}?epochId=…` → a Merkle inclusion proof (leaf + sibling path + `eventMerkleRoot` + `mainnetAnchorEpoch`), cross-checkable against the Bitcoin OTS anchor. That's the natural integration point for confidential attestation — but as shipped it proves PUBLIC_HASH Merkle inclusion, not a confidential proof. The privacy-mode leaf crypto must be wired into the sealing pipeline first (their side).

## Net takeaways

1. **ZK is absent from the network and not on its roadmap.** The network's privacy plan is encryption/HMAC subnet modes, not zkSNARKs.
2. **Re-scope our ZK question:** if we want confidentiality-from-validators, adopt the network's ENCRYPTED_BATCH/HMAC path (no ZK, no latency risk) once it's wired. Reserve ZK strictly for **predicate proofs** (amount≤cap / prove-permission-without-revealing) — the one thing commitments/encryption cannot do — and only after the CLO-136 spike proves latency.
3. **Court-grade (#7) is real but immature.** The D4 BFT network exists and is progressing; it is NOT yet multi-node-proven or signature-verifying. Our readiness code (CLO-64) is the correct app-side move; integrate against `verifyQuorumCertificate`/QC data when their Phase 7 lands.
4. **These repos are not our integration point yet** — we still run on the hosted MCP. This review is for feasibility only.
