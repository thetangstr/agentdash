import type { Db } from "@paperclipai/db";
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

  return { performMandatedAction, enforceMandatedAction };
}
