import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals as approvalsTable, companies, mandates, mandateAttestations, zkPermissionProofs, approvalComments, activityLog, companySkills } from "@paperclipai/db";
import { clockchainService, clockchainEnabled } from "./clockchain.js";
import { agentIdentityService } from "./agent-identity.js";
import { mandatesService } from "./mandates.js";
import { mandatedActionService } from "./mandated-action.js";
import { approvalService } from "./approvals.js";
import { handshakeAgentRunner, type HandshakeAgentRunner } from "./handshake-agent-runner.js";

// Turnkey two-company Agent Trust Handshake demo (scripted-real).
// One "Go" steps the real flow: discover → approve (payer human) → publish
// mandate → counterparty sees it → approve (payee human) → transact (KYA →
// attest → receipt). Every Clockchain call is real; the two approval steps
// pause until a human resolves them through the normal approvals inbox.
//
// State is derived, not stored: each step's completion is read from the DB
// (companies/agents/approvals/mandates/attestations), so "Go" is resumable
// and idempotent.
//
// AGENT-DRIVEN mode (flag AGENTDASH_HANDSHAKE_AGENT_DRIVEN, default OFF): when
// ON, two of the transitions are additionally gated by a REAL Hermes agent
// decision layered ON TOP of the existing human approval gates — Atlas (CEO)
// reasons about whether to grant the mandate, and Iris reasons about whether to
// release the payment. When OFF the behavior below is byte-for-byte the
// scripted-real flow. See handshake-agent-runner.ts.

const PAYER_NAME = "Meridian Pay";
const PAYEE_NAME = "Trellis Freight";
const PAYER_AGENT = "Iris";
const PAYEE_AGENT = "Billie";
const DEMO_ADAPTER = "hermes_local";
const DEMO_SCOPE = ["release_payment"];
const DEMO_CAP_CENTS = 100000;

// Role AGENTS.md for the two decision-making agents (inline; mirrors the driver).
// Atlas grants least authority; Iris acts only within its mandate's scope+cap.
const ATLAS_AGENTS_MD =
  "You are Atlas, CEO of Meridian Pay. You authorize your agents by granting scoped, " +
  "capped, time-bound mandates that are anchored on Clockchain. You grant only what the " +
  "business needs and never more.";
const IRIS_AGENTS_MD =
  "You are Iris, the payments agent at Meridian Pay. You operate strictly under mandates " +
  "granted by your CEO. Every payment you release is anchored on Clockchain. You act only " +
  "within your mandate's scope and cap.";

/** Read the agent-driven flag at call time so it can be toggled per-request/test. */
function agentDriven(): boolean {
  const v = process.env.AGENTDASH_HANDSHAKE_AGENT_DRIVEN;
  return v === "1" || v === "true";
}

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
  agentRunner: HandshakeAgentRunner = handshakeAgentRunner(),
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
    const probe = await clock.getTime(); // clean live-time probe (real OK response)
    steps.push({ key: "discover", title: "Clockchain MCP discovered (gateway reachable)", status: probe.reachable ? "done" : "blocked", evidence: { reachable: probe.reachable, ...(probe.blockHeight != null ? { blockHeight: probe.blockHeight } : {}), ...(probe.time ? { time: probe.time } : {}) } });
    if (!probe.reachable) return { steps, done: false };

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
    let grantorReasoning: string | undefined;
    if (!mandate) {
      // AGENT-DRIVEN: Atlas (CEO) makes a real decision before we create the
      // mandate. This runs ONLY when no mandate row exists yet, so a re-run of
      // "Go" never re-invokes hermes once the mandate is created (the row is the
      // idempotency signal). NOTE: a DECLINE creates no row, so a repeated Go
      // will re-run Atlas — acceptable for the demo.
      if (agentDriven()) {
        const cap = DEMO_CAP_CENTS / 100;
        const grant = await agentRunner.runDecision({
          agentId: atlas.id,
          name: "Atlas",
          companyId: payer.id,
          role: "ceo",
          agentsMd: ATLAS_AGENTS_MD,
          task:
            `Iris, your payments agent, needs to pay vendor ${PAYEE_NAME} up to $${cap} over the next week for freight services.\n` +
            `Decide whether to grant Iris a mandate: scope=release_payment, spend cap $${cap}, expires in 7 days.\n` +
            `Reply with EXACTLY one line: "APPROVE: <why>" or "DECLINE: <why>".`,
        });
        if (!grant.approved) {
          steps.push({
            key: "mandate",
            title: "Atlas (CEO) declined to grant the mandate",
            status: "blocked",
            detail: grant.decision,
            evidence: { grantorAgent: "Atlas", decision: grant.decision, reasoning: grant.reasoning },
          });
          return { steps, done: false };
        }
        grantorReasoning = grant.reasoning;
      }
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
    steps.push({ key: "mandate", title: "Mandate anchored + published to Trellis", status: "done", evidence: { mandateId: mandate.id, ledgerId: mandate.ccLedgerId, blockHeight: mandate.ccBlockHeight, ...(grantorReasoning ? { grantorAgent: "Atlas", grantorReasoning } : {}) } });

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
      // AGENT-DRIVEN: Iris (the grantee) makes a real decision before we attest.
      // Runs ONLY when no anchored attestation exists yet, so a re-run never
      // re-invokes hermes once the receipt row exists. NOTE: a DECLINE creates
      // no anchored attestation, so a repeated Go will re-run Iris — acceptable
      // for the demo.
      let granteeReasoning: string | undefined;
      if (agentDriven()) {
        const cap = DEMO_CAP_CENTS / 100;
        const release = await agentRunner.runDecision({
          agentId: iris.id,
          name: PAYER_AGENT,
          companyId: payer.id,
          role: "payments",
          agentsMd: IRIS_AGENTS_MD,
          task:
            `You hold an accepted mandate: scope=release_payment, cap $${cap}, counterparty ${PAYEE_NAME} (cleared to transact). ` +
            `A $100.00 freight invoice from ${PAYEE_NAME} is due now — within scope and cap.\n` +
            `Decide whether to release this $100.00 payment.\n` +
            `Reply with EXACTLY one line: "APPROVE: <why>" or "DECLINE: <why>".`,
        });
        if (!release.approved) {
          steps.push({
            key: "transact",
            title: "Iris declined to release the payment",
            status: "blocked",
            detail: release.decision,
            evidence: { granteeAgent: PAYER_AGENT, decision: release.decision, reasoning: release.reasoning, counterpartyDid: billieDid },
          });
          return { steps, done: false };
        }
        granteeReasoning = release.reasoning;
      }
      const result = await actions.runDemoAttestation({ companyId: payer.id, mandateId: mandate.id, action: DEMO_SCOPE[0] });
      // ZK permission proof (present only when AGENTDASH_ZK_PROOF_ENABLED): prove Iris
      // holds the release_payment permission without revealing the underlying credential;
      // only the 32-byte proof hash is anchored on-chain.
      const zk = result.permissionProof;
      steps.push({
        key: "transact",
        title: result.authorized ? "Transaction attested — receipt anchored" : `Transaction denied (${result.reason})`,
        status: result.authorized ? "done" : "blocked",
        evidence: {
          ledgerId: result.ledgerId,
          blockHeight: result.blockHeight,
          eventHash: result.eventHash,
          counterpartyDid: billieDid,
          ...(granteeReasoning ? { granteeAgent: PAYER_AGENT, granteeReasoning } : {}),
          ...(zk ? { zkPermissionProof: { scheme: zk.scheme, proofHash: zk.proofHash, publicSignals: zk.publicSignals, anchored: zk.anchored, ...(zk.note ? { note: zk.note } : {}) } } : {}),
        },
      });
      return { steps, done: Boolean(result.authorized) };
    }
    steps.push({ key: "transact", title: "Transaction attested — receipt anchored", status: "done", evidence: { ledgerId: receipt.ledgerId, blockHeight: receipt.blockHeight, eventHash: receipt.eventHash } });
    return { steps, done: true };
  }

  // Reset the demo to a clean slate so "Run" starts fresh (agents re-reason, new
  // mandate anchored, new ZK proof). Deletes the two demo companies + their demo
  // footprint in FK-safe order. Scoped strictly to the demo company names.
  async function reset(): Promise<{ reset: boolean; companies: number }> {
    let removed = 0;
    for (const name of [PAYER_NAME, PAYEE_NAME]) {
      const co = await findCompany(name);
      if (!co) continue;
      await db.delete(zkPermissionProofs).where(eq(zkPermissionProofs.companyId, co.id));
      await db.delete(mandateAttestations).where(eq(mandateAttestations.companyId, co.id));
      await db.delete(mandates).where(eq(mandates.companyId, co.id));
      await db.delete(approvalComments).where(eq(approvalComments.companyId, co.id));
      await db.delete(approvalsTable).where(eq(approvalsTable.companyId, co.id));
      await db.delete(activityLog).where(eq(activityLog.companyId, co.id));
      await db.delete(companySkills).where(eq(companySkills.companyId, co.id));
      await db.delete(agents).where(eq(agents.companyId, co.id));
      await db.delete(companies).where(eq(companies.id, co.id));
      removed += 1;
    }
    return { reset: true, companies: removed };
  }

  return { advance, reset };
}
