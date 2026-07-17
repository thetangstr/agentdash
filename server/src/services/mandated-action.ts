import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mandates as mandatesTable, mandateAttestations } from "@paperclipai/db";
import { clockchainService } from "./clockchain.js";
import { agentIdentityService } from "./agent-identity.js";
import { mandatesService } from "./mandates.js";
import { approvalService } from "./approvals.js";
import { agentService } from "./agents.js";

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
  receipt?: { ledgerId?: string; blockHeight?: number; status: "anchored" | "pending"; flagged?: boolean };
};

const BOUNCE_BACK_REASONS = new Set(["expired", "over_cap", "out_of_scope"]);

export function mandatedActionService(
  db: Db,
  clock = clockchainService(),
  identity = agentIdentityService(db, clock),
  mandates = mandatesService(db, clock, identity),
  approvals = approvalService(db),
  agents = agentService(db),
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
    const scope = verdict.scope ?? [];
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
    // 4. Attest — fail-open-but-flagged on a degraded/missing anchor.
    const att = await clock.attestAction({
      agentDid: actorDid ?? "",
      action: input.action,
      inputs: { ...(input.payload ?? {}), counterpartyDid: input.counterpartyDid, mandateId: input.mandateId },
      outputs: {},
    });
    // Only a truthful, non-degraded anchor earns the clean "anchored" receipt.
    if (att.attested && att.ledgerId && att.status !== "degraded") {
      return { authorized: true, receipt: { ledgerId: att.ledgerId, blockHeight: att.blockHeight, status: "anchored" } };
    }
    // Degraded-but-anchored keeps its ledgerId (honest); missing anchor has none.
    return { authorized: true, receipt: { ledgerId: att.ledgerId, blockHeight: att.blockHeight, status: "pending", flagged: true } };
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
