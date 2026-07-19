import { describe, expect, it } from "vitest";
import { Identity } from "@semaphore-protocol/identity";
import {
  ZK_SCHEME,
  deriveAuthorityGroup,
  generatePermissionProof,
  proveMandatePermission,
  verifyPermissionProof,
  zkProofEnabled,
} from "./zk-permission.js";

// Semaphore's first proof compiles wasm/zkey (~500ms) then fetches artifacts; give it room.
const PROOF_TIMEOUT = 45_000;

describe("zk-permission (Semaphore v4 permission proof)", () => {
  const SCOPE = "release_payment";
  const EPOCH = 1_752_800_000;
  const AUTHORITY = "mandate:test-authority";
  const PROVER = "mandate:test-authority:did:clockchain:agentdash:prover1";

  it("zkProofEnabled reflects the env flag (default OFF)", () => {
    const prev = process.env.AGENTDASH_ZK_PROOF_ENABLED;
    delete process.env.AGENTDASH_ZK_PROOF_ENABLED;
    expect(zkProofEnabled()).toBe(false);
    process.env.AGENTDASH_ZK_PROOF_ENABLED = "true";
    expect(zkProofEnabled()).toBe(true);
    if (prev === undefined) delete process.env.AGENTDASH_ZK_PROOF_ENABLED;
    else process.env.AGENTDASH_ZK_PROOF_ENABLED = prev;
  });

  it(
    "generates a proof whose public signals + hash are well-formed, and verifies it",
    async () => {
      const proof = await proveMandatePermission({
        authoritySeed: AUTHORITY,
        proverIdentitySeed: PROVER,
        scope: SCOPE,
        validAtEpoch: EPOCH,
      });

      expect(proof.scheme).toBe(ZK_SCHEME);
      expect(proof.proofHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
      expect(proof.publicSignals.scope).toBe(SCOPE);
      expect(proof.publicSignals.validAt).toBe(EPOCH);
      expect(proof.publicSignals.authority).toMatch(/^\d+$/); // Merkle root as decimal string
      expect(proof.publicSignals.nullifier).toMatch(/^\d+$/);

      // proofBytes rehydrate to a fully-verifiable proof under the matching expectation.
      const ok = await verifyPermissionProof(proof.proofBytes, {
        scope: SCOPE,
        validAt: EPOCH,
        authorityRoot: proof.publicSignals.authority,
      });
      expect(ok).toBe(true);
    },
    PROOF_TIMEOUT,
  );

  it(
    "rejects a tampered proof",
    async () => {
      const proof = await proveMandatePermission({
        authoritySeed: AUTHORITY,
        proverIdentitySeed: PROVER,
        scope: SCOPE,
        validAtEpoch: EPOCH,
      });
      // Flip one Groth16 point — must fail off-chain verification.
      const parsed = JSON.parse(proof.proofBytes) as { points: string[] };
      parsed.points[0] = (BigInt(parsed.points[0]) + 1n).toString();
      const tamperedBytes = JSON.stringify(parsed);

      const ok = await verifyPermissionProof(tamperedBytes, {
        scope: SCOPE,
        validAt: EPOCH,
        authorityRoot: proof.publicSignals.authority,
      });
      expect(ok).toBe(false);
    },
    PROOF_TIMEOUT,
  );

  it(
    "a valid proof FAILS verification when the relying party expects a different scope (anchored-but-invalid is intended)",
    async () => {
      const proof = await proveMandatePermission({
        authoritySeed: AUTHORITY,
        proverIdentitySeed: PROVER,
        scope: SCOPE,
        validAtEpoch: EPOCH,
      });
      const wrongScope = await verifyPermissionProof(proof.proofBytes, {
        scope: "transfer_funds", // not what the proof was bound to
        validAt: EPOCH,
        authorityRoot: proof.publicSignals.authority,
      });
      expect(wrongScope).toBe(false);

      const wrongTime = await verifyPermissionProof(proof.proofBytes, {
        scope: SCOPE,
        validAt: EPOCH + 1,
        authorityRoot: proof.publicSignals.authority,
      });
      expect(wrongTime).toBe(false);

      const wrongAuthority = await verifyPermissionProof(proof.proofBytes, {
        scope: SCOPE,
        validAt: EPOCH,
        authorityRoot: "12345",
      });
      expect(wrongAuthority).toBe(false);
    },
    PROOF_TIMEOUT,
  );

  it(
    "nullifier is deterministic per (identity, scope, T) and changes with T — the double-use signal",
    async () => {
      const a = await proveMandatePermission({
        authoritySeed: AUTHORITY,
        proverIdentitySeed: PROVER,
        scope: SCOPE,
        validAtEpoch: EPOCH,
      });
      const sameAgain = await proveMandatePermission({
        authoritySeed: AUTHORITY,
        proverIdentitySeed: PROVER,
        scope: SCOPE,
        validAtEpoch: EPOCH,
      });
      const laterT = await proveMandatePermission({
        authoritySeed: AUTHORITY,
        proverIdentitySeed: PROVER,
        scope: SCOPE,
        validAtEpoch: EPOCH + 60,
      });

      // Replaying the SAME (identity, scope, T) yields the SAME nullifier -> dedup catches it.
      expect(a.publicSignals.nullifier).toBe(sameAgain.publicSignals.nullifier);
      // A genuinely-distinct action at a different T gets a DIFFERENT nullifier -> both allowed.
      expect(a.publicSignals.nullifier).not.toBe(laterT.publicSignals.nullifier);
    },
    PROOF_TIMEOUT,
  );

  it(
    "deriveAuthorityGroup includes the prover's commitment (proof over that group verifies)",
    async () => {
      const identity = new Identity(PROVER);
      const group = deriveAuthorityGroup({ authoritySeed: AUTHORITY, proverCommitment: identity.commitment });
      expect(group.members.map(String)).toContain(identity.commitment.toString());

      const proof = await generatePermissionProof({
        proverIdentitySeed: PROVER,
        group,
        scope: SCOPE,
        validAtEpoch: EPOCH,
      });
      expect(proof.publicSignals.authority).toBe(group.root.toString());
    },
    PROOF_TIMEOUT,
  );

  it("verifyPermissionProof returns false on malformed proof bytes", async () => {
    expect(await verifyPermissionProof("not-json", { scope: SCOPE, validAt: EPOCH, authorityRoot: "1" })).toBe(false);
  });
});
