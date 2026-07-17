import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mandates } from "@paperclipai/db";
import { clockchainService, type DelegationVerdict } from "./clockchain.js";
import { agentIdentityService } from "./agent-identity.js";

type MandateRow = typeof mandates.$inferSelect;

export type CreateMandateInput = {
  companyId: string;
  grantorAgentId: string;
  granteeAgentId: string;
  scope: string[];
  permissionKey: string;
  spendCapCents: number;
  expiresAt: Date;
  budgetPolicyId?: string;
};

export function mandatesService(db: Db, clock = clockchainService(), identity = agentIdentityService(db, clock)) {
  async function createMandate(input: CreateMandateInput): Promise<MandateRow> {
    const [row] = await db.insert(mandates).values({
      companyId: input.companyId,
      grantorAgentId: input.grantorAgentId,
      granteeAgentId: input.granteeAgentId,
      scope: input.scope,
      permissionKey: input.permissionKey,
      spendCapCents: input.spendCapCents,
      budgetPolicyId: input.budgetPolicyId ?? null,
      expiresAt: input.expiresAt,
    }).returning();

    // Resolve DIDs via the identity service — anchoring is skipped (not an error)
    // when either agent has no resolvable DID; the grant row is still created.
    const grantorDid = await identity.resolveAgentDid(input.grantorAgentId);
    const granteeDid = await identity.resolveAgentDid(input.granteeAgentId);
    if (grantorDid && granteeDid) {
      // Anchor off the critical path — failure never blocks the grant.
      // Guard with .catch so even a THROWING clock (the injected type allows any
      // implementation) can't propagate after the row is already inserted.
      const anchor = await clock.delegateAuthority({
        parentDid: grantorDid,
        childDid: granteeDid,
        scope: input.scope,
        until: input.expiresAt.toISOString(),
      }).catch(() => ({ anchored: false as const }));
      if (anchor.anchored && anchor.ledgerId) {
        // Build the cc* fields once, use for both the DB write-back and the return
        // so the caller sees the live anchor (not the stale pre-insert null) — the
        // honesty surface: a "not anchored" render despite a real anchor would lie.
        const cc = {
          ccLedgerId: anchor.ledgerId,
          ccBlockHeight: anchor.blockHeight ?? null,
          ccAnchoredAt: new Date(),
        };
        await db.update(mandates).set({ ...cc, updatedAt: new Date() }).where(eq(mandates.id, row.id));
        return { ...row, ...cc };
      }
    }
    return row;
  }

  async function verifyMandate(id: string, at: Date, expectedGranteeAgentId?: string): Promise<DelegationVerdict> {
    const [row] = await db.select().from(mandates).where(eq(mandates.id, id));
    if (!row) return { status: "unauthorized", reason: "not_found" };
    // Cheap local pre-checks before spending a chain call.
    if (row.status === "revoked") return { status: "unauthorized", reason: "revoked" };
    if (row.expiresAt.getTime() <= at.getTime()) return { status: "unauthorized", reason: "expired" };
    if (expectedGranteeAgentId && row.granteeAgentId !== expectedGranteeAgentId) {
      return { status: "unauthorized", reason: "not_grantee" };
    }
    // The gateway has no verify_delegation_at tool, so the mandate's validity is proven
    // by its real on-chain grant anchor: confirm the delegate_authority ledgerId is real
    // and anchored. The local window/cap/scope (checked by the gate) govern the rest.
    if (!row.ccLedgerId) return { status: "unauthorized", reason: "not_anchored" };
    const entry = await clock.getLogEntry(row.ccLedgerId);
    if (!entry.found) return { status: "unauthorized", reason: "not_anchored" };
    if (!entry.anchored) return { status: "unauthorized", reason: "pending_anchor" };
    return { status: "authorized", ledgerId: row.ccLedgerId, scope: row.scope, spendCapCents: row.spendCapCents };
  }

  async function listMandates(companyId: string, granteeAgentId?: string): Promise<MandateRow[]> {
    const where = granteeAgentId
      ? and(eq(mandates.companyId, companyId), eq(mandates.granteeAgentId, granteeAgentId))
      : eq(mandates.companyId, companyId);
    return db.select().from(mandates).where(where).orderBy(desc(mandates.createdAt));
  }

  return { createMandate, verifyMandate, listMandates };
}
