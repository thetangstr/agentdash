import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mandates as mandatesTable, mandateAttestations } from "@paperclipai/db";
import { clockchainService } from "./clockchain.js";
import { agentIdentityService } from "./agent-identity.js";
import { mandatesService } from "./mandates.js";
import { approvalService } from "./approvals.js";
import { agentService } from "./agents.js";
import {
  zkPermissionService,
  proveMandatePermission,
  zkProofEnabled,
  ZK_SCHEME,
  type GeneratedPermissionProof,
} from "./zk-permission.js";

export type MandatedActionInput = {
  companyId: string;
  granteeAgentId: string;
  mandateId: string;
  counterpartyDid: string;
  action: string;
  payload?: Record<string, unknown>;
};
export type MandatedActionResult = {
  authorized: boolean;
  reason?: string;
  receipt?: { ledgerId?: string; blockHeight?: number; eventHash?: string; status: "anchored" | "pending"; flagged?: boolean };
  // Present only when AGENTDASH_ZK_PROOF_ENABLED. `anchored` is true ONLY when a fresh proof was
  // generated, its hash was carried in the attest inputs, AND the attest confirmed (status
  // "anchored"). `note` flags a degraded case (proof disabled/failed/replayed) honestly.
  permissionProof?: {
    scheme: string;
    proofHash?: string;
    publicSignals?: GeneratedPermissionProof["publicSignals"];
    anchored: boolean;
    note?: string;
  };
};

const BOUNCE_BACK_REASONS = new Set(["expired", "over_cap", "out_of_scope"]);

export function mandatedActionService(
  db: Db,
  clock = clockchainService(),
  identity = agentIdentityService(db, clock),
  mandates = mandatesService(db, clock, identity),
  approvals = approvalService(db),
  agents = agentService(db),
  zk = zkPermissionService(db),
) {
  async function performMandatedAction(input: MandatedActionInput, now: Date = new Date()): Promise<MandatedActionResult> {
    // 1. Mandate — fail-closed.
    const verdict = await mandates.verifyMandate(input.mandateId, now, input.granteeAgentId);
    if (verdict.status !== "authorized") {
      return { authorized: false, reason: verdict.reason ?? verdict.status };
    }
    // 1b. Scope + cap — the gateway has no verify_delegation_at, so the gate enforces
    // the mandate's action scope and spend cap locally. (No accumulation yet for the
    // demo: a single action whose amount exceeds the cap is over_cap.)
    const scope = Array.isArray(verdict.scope) ? verdict.scope : [];
    if (!scope.includes(input.action)) {
      return { authorized: false, reason: "out_of_scope" };
    }
    const amountCents = typeof input.payload?.amountCents === "number" ? input.payload.amountCents : 0;
    if (amountCents > (verdict.spendCapCents ?? 0)) {
      return { authorized: false, reason: "over_cap" };
    }
    // 2. KYA the counterparty — fail-closed on anything but valid.
    const kya = await clock.verifyIdentityAt({ did: input.counterpartyDid, at: now.toISOString() });
    if (kya.status !== "valid") {
      return { authorized: false, reason: `counterparty_${kya.status}` };
    }
    // 3. Actor DID for the attest — fail-closed: can't attest as an unprovisioned agent.
    const actorDid = await identity.resolveAgentDid(input.granteeAgentId);
    if (!actorDid) return { authorized: false, reason: "actor_unresolved" };

    // 3b. ZK permission proof (flag-gated, default OFF). Generate a proof that the acting
    // agent holds this mandate's permission, WITHOUT revealing the credential. Its 32-byte
    // hash rides the EXISTING attest inputs (no gateway change); the network never opens it.
    // Degrade gracefully + flag on any failure/replay — never imply a proof that isn't there.
    let permissionProofInput: Record<string, unknown> | undefined;
    let generatedProof: GeneratedPermissionProof | undefined;
    let proofNote: string | undefined;
    if (zkProofEnabled()) {
      const validAtEpoch = Math.floor(now.getTime() / 1000);
      try {
        // The mandate IS the authority; the grantee's membership is specific to this mandate.
        const proof = await proveMandatePermission({
          authoritySeed: `mandate:${input.mandateId}`,
          proverIdentitySeed: `${input.mandateId}:${actorDid}`,
          scope: input.action,
          validAtEpoch,
        });
        if (await zk.isNullifierSeen(proof.publicSignals.nullifier)) {
          // Reused (identity, scope, T) proof — a replay. Do NOT anchor a reused proof claim.
          proofNote = "replay_rejected";
        } else {
          generatedProof = proof;
          permissionProofInput = {
            scheme: proof.scheme,
            proof_hash: proof.proofHash,
            public_signals: {
              authority: proof.publicSignals.authority,
              scope: proof.publicSignals.scope,
              validAt: proof.publicSignals.validAt,
              nullifier: proof.publicSignals.nullifier,
            },
          };
        }
      } catch {
        proofNote = "proof_failed";
      }
    }

    // 4. Attest — fail-open-but-flagged on a degraded/missing anchor. The proof_hash (when
    // present) is now bound into the on-chain eventHash via the attest inputs.
    const att = await clock.attestAction({
      agentDid: actorDid ?? "",
      action: input.action,
      inputs: {
        ...(input.payload ?? {}),
        counterpartyDid: input.counterpartyDid,
        mandateId: input.mandateId,
        ...(permissionProofInput ? { permission_proof: permissionProofInput } : {}),
      },
      outputs: {},
    });

    // Only a CONFIRMED anchor (status === "anchored") earns the clean "anchored" receipt.
    const anchoredOk = att.attested && Boolean(att.ledgerId) && att.status === "anchored";

    // Persist the full proof bytes + nullifier off-chain so a relying party can re-verify and
    // reuse stays detectable. Only when a fresh proof was actually carried in the attest.
    if (generatedProof && permissionProofInput) {
      try {
        const rec = await zk.recordProof({
          companyId: input.companyId,
          mandateId: input.mandateId,
          granteeAgentId: input.granteeAgentId,
          proof: generatedProof,
          ledgerId: att.ledgerId,
          blockHeight: att.blockHeight,
          eventHash: att.eventHash,
          receiptStatus: att.status,
          receipt: att.receipt,
        });
        if (rec.duplicate) proofNote = "replay_rejected";
      } catch {
        proofNote = proofNote ?? "persist_failed";
      }
    }

    const permissionProof = zkProofEnabled()
      ? {
          scheme: generatedProof?.scheme ?? ZK_SCHEME,
          proofHash: generatedProof?.proofHash,
          publicSignals: generatedProof?.publicSignals,
          // Honest: a proof was generated, carried in inputs, AND the attest confirmed anchored.
          anchored: Boolean(generatedProof && permissionProofInput && anchoredOk),
          note: proofNote,
        }
      : undefined;

    if (anchoredOk) {
      return {
        authorized: true,
        receipt: { ledgerId: att.ledgerId, blockHeight: att.blockHeight, eventHash: att.eventHash, status: "anchored" },
        ...(permissionProof ? { permissionProof } : {}),
      };
    }
    // Pending/degraded: authorized, but the anchor is not confirmed — flag it honestly.
    return {
      authorized: true,
      receipt: { ledgerId: att.ledgerId, blockHeight: att.blockHeight, eventHash: att.eventHash, status: "pending", flagged: true },
      ...(permissionProof ? { permissionProof } : {}),
    };
  }

  async function enforceMandatedAction(
    input: MandatedActionInput,
    now: Date = new Date(),
  ): Promise<MandatedActionResult & { escalated: boolean; approvalId?: string }> {
    const result = await performMandatedAction(input, now);
    if (!result.authorized && result.reason && BOUNCE_BACK_REASONS.has(result.reason)) {
      const approval = await approvals.create(input.companyId, {
        type: "mandate_violation",
        requestedByAgentId: input.granteeAgentId,
        payload: {
          mandateId: input.mandateId,
          action: input.action,
          counterpartyDid: input.counterpartyDid,
          reason: result.reason,
        },
      });
      await agents.pause(input.granteeAgentId, "mandate");
      return { ...result, escalated: true, approvalId: (approval as { id: string }).id };
    }
    return { ...result, escalated: false };
  }

  // Demo trigger: run a real mandated action as the mandate's grantee and persist the receipt.
  // Mints + anchors a fresh counterparty identity so KYA (valid-at-T) passes — the demo
  // counterpart is "Billie (Trellis Freight)". The action must be in the mandate's scope.
  async function runDemoAttestation(input: { companyId: string; mandateId: string; action: string }) {
    const [mandate] = await db.select().from(mandatesTable).where(eq(mandatesTable.id, input.mandateId));
    if (!mandate) throw new Error("mandate_not_found");

    const suffix = Math.random().toString(36).slice(2, 8);
    const counterpartyDid = `did:clockchain:agentdash:billie-${suffix}`;
    // Mint the counterparty; mint_identity derives the did from agentId, so pass a stable id.
    const mint = await clock.mintIdentity({ agentId: `billie-${suffix}`, name: "Billie (Trellis Freight)" });
    const did = mint.did ?? counterpartyDid;
    // KYA requires the counterparty mint to be anchored before T — poll briefly.
    if (mint.minted && mint.ledgerId) {
      for (let i = 0; i < 25; i++) {
        const e = await clock.getLogEntry(mint.ledgerId);
        if (e.anchored) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    const result = await enforceMandatedAction(
      { companyId: input.companyId, granteeAgentId: mandate.granteeAgentId, mandateId: input.mandateId, counterpartyDid: did, action: input.action },
      new Date(),
    );

    const [row] = await db.insert(mandateAttestations).values({
      companyId: input.companyId,
      mandateId: input.mandateId,
      granteeAgentId: mandate.granteeAgentId,
      action: input.action,
      counterpartyDid: did,
      authorized: result.authorized,
      reason: result.reason ?? null,
      ledgerId: result.receipt?.ledgerId ?? null,
      blockHeight: result.receipt?.blockHeight ?? null,
      eventHash: result.receipt?.eventHash ?? null,
      receiptStatus: result.receipt?.status ?? (result.authorized ? "pending" : "denied"),
      escalated: result.escalated,
      approvalId: result.approvalId ?? null,
    }).returning();
    return row;
  }

  async function listAttestations(companyId: string, mandateId?: string) {
    const where = mandateId ? and(eq(mandateAttestations.companyId, companyId), eq(mandateAttestations.mandateId, mandateId)) : eq(mandateAttestations.companyId, companyId);
    return db.select().from(mandateAttestations).where(where).orderBy(desc(mandateAttestations.createdAt));
  }

  return { performMandatedAction, enforceMandatedAction, runDemoAttestation, listAttestations };
}
