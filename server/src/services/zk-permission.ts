// CLO-137: server-side ZK permission-proof service (Semaphore v4 / Groth16, PSE).
//
// What this proves: "the acting agent holds a permission credential in scope S,
// issued by authority A, valid at time T — WITHOUT revealing the credential",
// and emits a nullifier so a double-use of the same (identity, scope, T) proof
// is detectable. Public signals: authority (Merkle root), scope, validAt (epoch),
// nullifier. Private: the identity secret + the Merkle path.
//
// Anchor model (unchanged from the CLO-136 spike): the network ANCHORS BYTES and
// NEVER opens the proof. We SHA-256 the canonical proof bytes and ride that 32-byte
// digest through the EXISTING attest_action path (inputs.permission_proof.proof_hash).
// Verification is off-chain, by the relying party — NOT the gateway. The receipt
// proves the hash existed at T; it says nothing about the proof's validity.
//
// Latency (measured, node/server tier, CLO-136): first proof ~500ms (one-time wasm/zkey
// compile), steady-state p50 327ms / p95 352ms on a 10k-member group. Group SIZE does not
// change per-proof latency or validity — only the one-time build cost — so the demo/default
// authority set is deliberately SMALL (a handful of members) to keep tests fast. (A group of
// 1–2 members is not anonymous per Semaphore; the default set uses >=3 members.)

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof, verifyProof } from "@semaphore-protocol/proof";
import type { Db } from "@paperclipai/db";
import { zkPermissionProofs } from "@paperclipai/db";

// Local mirror of the Semaphore v4 proof shape. The package's node `types` entry is
// mis-packaged (points at a non-existent index.node.d.ts) so `SemaphoreProof` is not
// importable; this structural type matches it exactly (points = PackedGroth16Proof, 8 strings)
// and stays assignable both to generateProof's return and verifyProof's parameter.
type PackedGroth16Proof = [string, string, string, string, string, string, string, string];
type SemaphoreProof = {
  merkleTreeDepth: number;
  merkleTreeRoot: string;
  message: string;
  nullifier: string;
  scope: string;
  points: PackedGroth16Proof;
};

export const ZK_SCHEME = "semaphore-v4";

export type PermissionPublicSignals = {
  authority: string; // Merkle root of the authority's member set
  scope: string; // human scope string (e.g. the mandate action)
  validAt: number; // T — epoch seconds (numeric so it reconciles with consensusTime)
  nullifier: string; // per (identity, scope, T) — double-use detectable
};

export type GeneratedPermissionProof = {
  scheme: typeof ZK_SCHEME;
  proofHash: string; // SHA-256(canonical(proofBytes)) — the anchored digest
  publicSignals: PermissionPublicSignals;
  proofBytes: string; // full canonical proof JSON (off-chain); verifyProof re-hydrates from this
};

export type ExpectedPermission = {
  scope: string;
  validAt: number;
  authorityRoot: string;
};

// Zero-config env flag. Default OFF so the mandate demo is unchanged unless opted in.
export function zkProofEnabled(): boolean {
  return process.env.AGENTDASH_ZK_PROOF_ENABLED === "true";
}

// ---- field helpers -------------------------------------------------------

// Map an arbitrary string to a 64-bit field element (well under the SNARK scalar
// field). Deterministic so a verifier recomputes the same value from the same string.
function fieldHash(input: string): bigint {
  return BigInt("0x" + createHash("sha256").update(input).digest("hex").slice(0, 16));
}

// The Semaphore "scope" (external nullifier) binds the permission scope AND T, so the
// nullifier is unique per (identity, scope, epoch): two genuinely-distinct actions at
// different T get distinct nullifiers, while replaying the SAME proof collides -> detected.
function externalNullifierFor(scope: string, validAtEpoch: number): bigint {
  return fieldHash(`${scope}:${validAtEpoch}`);
}

// The Semaphore "message" binds a scope id + T into the signed payload (defence in depth:
// the message is checked alongside the nullifier scope on verify).
function messageFor(scope: string, validAtEpoch: number): bigint {
  return (fieldHash(scope) << 64n) | BigInt(validAtEpoch);
}

// Deterministic, key-ordered serialization of a Semaphore proof. proofHash covers the
// WHOLE proof (including merkleTreeDepth) so the stored bytes are fully re-verifiable.
function canonicalizeProof(proof: SemaphoreProof): string {
  return JSON.stringify({
    merkleTreeDepth: proof.merkleTreeDepth,
    merkleTreeRoot: proof.merkleTreeRoot,
    message: proof.message,
    nullifier: proof.nullifier,
    scope: proof.scope,
    points: proof.points,
  });
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---- pure crypto ---------------------------------------------------------

/** Hold an authority's commitment set as a Semaphore group (an authority = the granting company/agent). */
export function buildAuthoritySet(members: bigint[]): Group {
  return new Group(members);
}

/**
 * Derive a small, deterministic authority set that INCLUDES the prover's commitment.
 * Group size does not change per-proof latency or validity — only the one-time build.
 * Filler members make the set anonymous (>=3 members) without a real registry.
 */
export function deriveAuthorityGroup(input: {
  authoritySeed: string;
  proverCommitment: bigint;
  fillerCount?: number;
}): Group {
  const fillerCount = input.fillerCount ?? 4;
  const members: bigint[] = [input.proverCommitment];
  for (let i = 0; i < fillerCount; i++) {
    members.push(new Identity(`${input.authoritySeed}:filler:${i}`).commitment);
  }
  return buildAuthoritySet(members);
}

/**
 * Generate a permission proof. `group` MUST already contain the prover's commitment
 * (deriveAuthorityGroup guarantees this when seeded with the same prover seed).
 */
export async function generatePermissionProof(input: {
  proverIdentitySeed: string;
  group: Group;
  scope: string;
  validAtEpoch: number;
}): Promise<GeneratedPermissionProof> {
  const identity = new Identity(input.proverIdentitySeed);
  const message = messageFor(input.scope, input.validAtEpoch);
  const externalNullifier = externalNullifierFor(input.scope, input.validAtEpoch);
  const proof = await generateProof(identity, input.group, message, externalNullifier);
  const proofBytes = canonicalizeProof(proof);
  return {
    scheme: ZK_SCHEME,
    proofHash: sha256Hex(proofBytes),
    publicSignals: {
      authority: proof.merkleTreeRoot,
      scope: input.scope,
      validAt: input.validAtEpoch,
      nullifier: proof.nullifier,
    },
    proofBytes,
  };
}

/**
 * Convenience: build the authority group from a seed + prove in one call. Used by the
 * mandate wiring — the mandate IS the authority, so authoritySeed = the mandate id.
 */
export async function proveMandatePermission(input: {
  authoritySeed: string;
  proverIdentitySeed: string;
  scope: string;
  validAtEpoch: number;
  fillerCount?: number;
}): Promise<GeneratedPermissionProof> {
  const identity = new Identity(input.proverIdentitySeed);
  const group = deriveAuthorityGroup({
    authoritySeed: input.authoritySeed,
    proverCommitment: identity.commitment,
    fillerCount: input.fillerCount,
  });
  return generatePermissionProof({
    proverIdentitySeed: input.proverIdentitySeed,
    group,
    scope: input.scope,
    validAtEpoch: input.validAtEpoch,
  });
}

/**
 * Relying-party check: off-chain ZK verify PLUS public-signal binding checks. A proof for a
 * DIFFERENT scope/time/authority than expected fails here even though its hash was anchored —
 * that is the intended, honest behavior (the network attested TIME, not validity).
 */
export async function verifyPermissionProof(proofBytes: string, expected: ExpectedPermission): Promise<boolean> {
  let proof: SemaphoreProof;
  try {
    proof = JSON.parse(proofBytes) as SemaphoreProof;
  } catch {
    return false;
  }
  const expectedMessage = messageFor(expected.scope, expected.validAt);
  const expectedNullifierScope = externalNullifierFor(expected.scope, expected.validAt);
  if (proof.message !== expectedMessage.toString()) return false;
  if (proof.scope !== expectedNullifierScope.toString()) return false;
  if (proof.merkleTreeRoot !== expected.authorityRoot) return false;
  try {
    return await verifyProof(proof);
  } catch {
    return false;
  }
}

// ---- DB storage + nullifier dedup + verifier flow ------------------------

export type RecordProofInput = {
  companyId: string;
  mandateId?: string | null;
  granteeAgentId?: string | null;
  proof: GeneratedPermissionProof;
  ledgerId?: string | null;
  blockHeight?: number | null;
  eventHash?: string | null;
  receiptStatus?: string | null;
  receipt?: Record<string, unknown> | null;
};

export type StoredProofVerification = {
  found: boolean;
  // (a) off-chain ZK verify + public-signal binding
  proofValid: boolean;
  // (b) hash was anchored at T (verify_receipt against the immutable block). NEVER means
  // the network verified the proof — only that the proof_hash existed on-chain at T.
  anchored: boolean;
  receiptMatched?: boolean;
  publicSignals?: PermissionPublicSignals;
  receiptStatus?: string | null;
  note?: string;
};

// A minimal shape of the clockchain client's verifyReceipt (kept structural to avoid a
// hard import cycle; the real client is injected by the caller).
type ReceiptVerifier = {
  verifyReceipt(receipt: Record<string, unknown>): Promise<{ verified: boolean }>;
};

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const msg = (err as { message?: string })?.message ?? "";
  return code === "23505" || /duplicate key|unique constraint/i.test(msg);
}

export function zkPermissionService(db: Db) {
  async function isNullifierSeen(nullifier: string): Promise<boolean> {
    const [row] = await db
      .select({ id: zkPermissionProofs.id })
      .from(zkPermissionProofs)
      .where(eq(zkPermissionProofs.nullifier, nullifier))
      .limit(1);
    return Boolean(row);
  }

  // Persist proof bytes + nullifier off-chain. Rejects a nullifier already seen (double-use) —
  // both proactively (clear signal) and via the DB UNIQUE constraint (race-safe).
  async function recordProof(input: RecordProofInput): Promise<{ recorded: boolean; duplicate: boolean; id?: string }> {
    if (await isNullifierSeen(input.proof.publicSignals.nullifier)) {
      return { recorded: false, duplicate: true };
    }
    try {
      const [row] = await db
        .insert(zkPermissionProofs)
        .values({
          companyId: input.companyId,
          mandateId: input.mandateId ?? null,
          granteeAgentId: input.granteeAgentId ?? null,
          scheme: input.proof.scheme,
          proofHash: input.proof.proofHash,
          nullifier: input.proof.publicSignals.nullifier,
          authority: input.proof.publicSignals.authority,
          scope: input.proof.publicSignals.scope,
          validAt: input.proof.publicSignals.validAt,
          proofBytes: input.proof.proofBytes,
          ledgerId: input.ledgerId ?? null,
          blockHeight: input.blockHeight ?? null,
          eventHash: input.eventHash ?? null,
          receiptStatus: input.receiptStatus ?? null,
          receipt: input.receipt ?? null,
        })
        .returning({ id: zkPermissionProofs.id });
      return { recorded: true, duplicate: false, id: row.id };
    } catch (err) {
      if (isUniqueViolation(err)) return { recorded: false, duplicate: true };
      throw err;
    }
  }

  async function getByProofHash(companyId: string, proofHash: string) {
    const [row] = await db
      .select()
      .from(zkPermissionProofs)
      .where(eq(zkPermissionProofs.proofHash, proofHash))
      .limit(1);
    if (!row || row.companyId !== companyId) return undefined;
    return row;
  }

  /**
   * Verifier flow — two INDEPENDENT checks:
   *   (a) off-chain ZK verify + public-signal binding  => the proof itself is valid;
   *   (b) verify_receipt (via the injected clock)       => the proof_hash was anchored at T.
   * A wrong-scope proof FAILS (a) while still being anchored (b) — intended.
   */
  async function verifyStoredProof(
    companyId: string,
    proofHash: string,
    clock?: ReceiptVerifier,
  ): Promise<StoredProofVerification> {
    const row = await getByProofHash(companyId, proofHash);
    if (!row) return { found: false, proofValid: false, anchored: false };

    const publicSignals: PermissionPublicSignals = {
      authority: row.authority,
      scope: row.scope,
      validAt: row.validAt,
      nullifier: row.nullifier,
    };

    const proofValid = await verifyPermissionProof(row.proofBytes, {
      scope: row.scope,
      validAt: row.validAt,
      authorityRoot: row.authority,
    });

    // (b) anchored: require BOTH a confirmed "anchored" status AND a keyless verify_receipt match.
    // A ledgerId alone is never enough (mirrors the clockchain.ts honesty rule).
    let receiptMatched: boolean | undefined;
    let anchored = false;
    if (clock && row.receipt && row.receiptStatus === "anchored") {
      try {
        const r = await clock.verifyReceipt(row.receipt as Record<string, unknown>);
        receiptMatched = r.verified;
        anchored = r.verified === true;
      } catch {
        receiptMatched = false;
        anchored = false;
      }
    }

    return {
      found: true,
      proofValid,
      anchored,
      receiptMatched,
      publicSignals,
      receiptStatus: row.receiptStatus,
      note: anchored
        ? "proof_hash anchored at T; the network attested TIME, not proof validity"
        : "not confirmed anchored — receipt unconfirmed or verify_receipt unavailable",
    };
  }

  return { isNullifierSeen, recordProof, getByProofHash, verifyStoredProof };
}
