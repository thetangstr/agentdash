import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals as approvalsTable, companies, mandates } from "@paperclipai/db";
import { clockchainService, clockchainEnabled } from "./clockchain.js";
import { agentIdentityService } from "./agent-identity.js";
import { mandatesService } from "./mandates.js";
import { mandatedActionService } from "./mandated-action.js";
import { approvalService } from "./approvals.js";

// Turnkey two-company Agent Trust Handshake demo (scripted-real).
// One "Go" steps the real flow: discover → approve (payer human) → publish
// mandate → counterparty sees it → approve (payee human) → transact (KYA →
// attest → receipt). Every Clockchain call is real; the two approval steps
// pause until a human resolves them through the normal approvals inbox.
//
// State is derived, not stored: each step's completion is read from the DB
// (companies/agents/approvals/mandates/attestations), so "Go" is resumable
// and idempotent.

const PAYER_NAME = "Meridian Pay";
const PAYEE_NAME = "Trellis Freight";
const PAYER_AGENT = "Iris";
const PAYEE_AGENT = "Billie";
const DEMO_ADAPTER = "hermes_local";
const DEMO_SCOPE = ["release_payment"];
const DEMO_CAP_CENTS = 100000;

export type HandshakeStep = {
  key: string;
  title: string;
  status: "done" | "waiting_approval" | "ready" | "blocked";
  detail?: string;
  approvalId?: string;
  evidence?: Record<string, unknown>;
};

export function handshakeDemoService(
  db: Db,
  clock = clockchainService(),
  identity = agentIdentityService(db, clock),
  mandatesSvc = mandatesService(db, clock, identity),
  approvals = approvalService(db),
  actions = mandatedActionService(db, clock, identity, mandatesSvc),
) {
  async function findCompany(name: string) {
    const [row] = await db.select().from(companies).where(eq(companies.name, name));
    return row ?? null;
  }

  async function findAgent(companyId: string, name: string) {
    const [row] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, name)));
    return row ?? null;
  }

  async function findApproval(companyId: string, type: string) {
    const rows = await db.select().from(approvalsTable)
      .where(and(eq(approvalsTable.companyId, companyId), eq(approvalsTable.type, type)))
      .orderBy(desc(approvalsTable.createdAt));
    return rows[0] ?? null;
  }

  async function ensureCompany(name: string, issuePrefix: string) {
    const existing = await findCompany(name);
    if (existing) return existing;
    const [row] = await db.insert(companies).values({ name, issuePrefix }).returning();
    return row;
  }

  async function ensureAgent(companyId: string, name: string, role: string) {
    const existing = await findAgent(companyId, name);
    if (existing) return existing;
    const [row] = await db.insert(agents).values({ companyId, name, role, adapterType: DEMO_ADAPTER }).returning();
    return row;
  }

  async function demoMandate(payerCompanyId: string) {
    const rows = await db.select().from(mandates)
      .where(and(eq(mandates.companyId, payerCompanyId), eq(mandates.status, "active")))
      .orderBy(desc(mandates.createdAt));
    return rows.find((m) => m.published || m.ccLedgerId) ?? rows[0] ?? null;
  }

  // Advance the demo by one step (or report the waiting state). Idempotent.
  async function advance(): Promise<{ steps: HandshakeStep[]; done: boolean }> {
    const steps: HandshakeStep[] = [];

    // 0. Seed both companies + agents (Iris pays; Billie is the payee's agent).
    const payer = await ensureCompany(PAYER_NAME, "MER");
    const payee = await ensureCompany(PAYEE_NAME, "TRE");
    const iris = await ensureAgent(payer.id, PAYER_AGENT, "general");
    const billie = await ensureAgent(payee.id, PAYEE_AGENT, "general");
    const atlas = await ensureAgent(payer.id, "Atlas", "ceo");
    steps.push({ key: "seed", title: "Two companies + agents ready", status: "done", evidence: { payer: payer.id, payee: payee.id } });

    // 1. Discover — is the Clockchain MCP reachable (real check)?
    if (!clockchainEnabled()) {
      steps.push({ key: "discover", title: "Discover Clockchain MCP", status: "blocked", detail: "AGENTDASH_ATTESTATION_ENABLED/key not set" });
      return { steps, done: false };
    }
    const probe = await clock.getLogEntry("00000000-0000-0000-0000-000000000000"); // any call proves reachability; found:false is fine
    steps.push({ key: "discover", title: "Clockchain MCP discovered (gateway reachable)", status: "done", evidence: { reachable: true, probed: !probe.found } });

    // 2. Payer human approves Clockchain use (once).
    let onboarding = await findApproval(payer.id, "clockchain_onboarding");
    if (!onboarding) {
      onboarding = await approvals.create(payer.id, {
        type: "clockchain_onboarding",
        requestedByAgentId: iris.id,
        payload: { question: "Allow Iris to use the Clockchain MCP for verified attestations?" },
      });
    }
    if ((onboarding as any).status !== "approved") {
      steps.push({ key: "onboard", title: `${PAYER_NAME}: approve Clockchain use`, status: "waiting_approval", approvalId: (onboarding as any).id });
      return { steps, done: false };
    }
    steps.push({ key: "onboard", title: `${PAYER_NAME} approved Clockchain use`, status: "done" });

    // 3. Grant + publish the mandate (Atlas → Iris, published to Trellis). Real on-chain anchor.
    let mandate = await demoMandate(payer.id);
    if (!mandate) {
      mandate = await mandatesSvc.createMandate({
        companyId: payer.id,
        grantorAgentId: atlas.id,
        granteeAgentId: iris.id,
        scope: DEMO_SCOPE,
        permissionKey: "clockchain:attest",
        spendCapCents: DEMO_CAP_CENTS,
        expiresAt: new Date(Date.now() + 7 * 86400000),
      });
    }
    if (!mandate.ccLedgerId) {
      steps.push({ key: "mandate", title: "Mandate anchoring on-chain…", status: "ready", detail: "anchor pending; re-run Go", evidence: { mandateId: mandate.id } });
      return { steps, done: false };
    }
    if (!mandate.published) {
      mandate = await mandatesSvc.publishMandate(payer.id, mandate.id, payee.id);
    }
    steps.push({ key: "mandate", title: "Mandate anchored + published to Trellis", status: "done", evidence: { mandateId: mandate.id, ledgerId: mandate.ccLedgerId, blockHeight: mandate.ccBlockHeight } });

    // 4. Payee sees it + payee human accepts.
    if (!mandate.acceptedAt) {
      let accept = await findApproval(payee.id, "mandate_acceptance");
      if (!accept) {
        accept = await approvals.create(payee.id, {
          type: "mandate_acceptance",
          payload: { mandateId: mandate.id, from: PAYER_NAME, scope: mandate.scope, spendCapCents: mandate.spendCapCents, question: "Accept this mandate — ready to transact with Meridian Pay?" },
        });
      }
      if ((accept as any).status !== "approved") {
        steps.push({ key: "accept", title: `${PAYEE_NAME}: accept the mandate`, status: "waiting_approval", approvalId: (accept as any).id });
        return { steps, done: false };
      }
      mandate = await mandatesSvc.acceptMandate(payee.id, mandate.id);
    }
    steps.push({ key: "accept", title: `${PAYEE_NAME} accepted — cleared to transact`, status: "done", evidence: { acceptedAt: mandate.acceptedAt } });

    // 5. Transact — Iris KYAs Billie + attests the payment (real receipt).
    const billieDid = await identity.resolveAgentDid(billie.id);
    const existing = await actions.listAttestations(payer.id, mandate.id);
    const receipt = existing.find((a) => a.authorized && a.receiptStatus === "anchored");
    if (!receipt) {
      const result = await actions.runDemoAttestation({ companyId: payer.id, mandateId: mandate.id, action: DEMO_SCOPE[0] });
      steps.push({
        key: "transact",
        title: result.authorized ? "Transaction attested — receipt anchored" : `Transaction denied (${result.reason})`,
        status: result.authorized ? "done" : "blocked",
        evidence: { ledgerId: result.ledgerId, blockHeight: result.blockHeight, eventHash: result.eventHash, counterpartyDid: billieDid },
      });
      return { steps, done: Boolean(result.authorized) };
    }
    steps.push({ key: "transact", title: "Transaction attested — receipt anchored", status: "done", evidence: { ledgerId: receipt.ledgerId, blockHeight: receipt.blockHeight, eventHash: receipt.eventHash } });
    return { steps, done: true };
  }

  return { advance };
}
