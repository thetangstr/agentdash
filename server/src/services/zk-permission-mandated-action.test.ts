import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  mandates,
  startEmbeddedPostgresTestDatabase,
  zkPermissionProofs,
} from "@paperclipai/db";
import { mandatedActionService } from "./mandated-action.js";
import { zkPermissionService } from "./zk-permission.js";

// First Semaphore proof compiles wasm/zkey (~500ms); each wired call generates a real proof.
const PROOF_TIMEOUT = 60_000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("performMandatedAction ZK permission proof (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const ACTION = "release_payment";
  const ACTOR_DID = "did:clockchain:agentdash:actor01";
  const prevFlag = process.env.AGENTDASH_ZK_PROOF_ENABLED;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-zk-permission-");
    db = createDb(tempDb.connectionString);
  }, 180_000);

  afterEach(async () => {
    await db.delete(zkPermissionProofs);
    await db.delete(mandates);
    await db.delete(agents);
    await db.delete(companies);
    if (prevFlag === undefined) delete process.env.AGENTDASH_ZK_PROOF_ENABLED;
    else process.env.AGENTDASH_ZK_PROOF_ENABLED = prevFlag;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // A mock clock that captures the attest inputs so we can assert the proof_hash was bound.
  function makeClock() {
    const captured: { inputs?: Record<string, unknown> } = {};
    const clock = {
      verifyIdentityAt: async () => ({ status: "valid" as const }),
      attestAction: async (args: { inputs?: Record<string, unknown> }) => {
        captured.inputs = args.inputs;
        const receipt = { eventHash: "eh-1", anchor: { ledgerId: "L1", blockHeight: 4477946 }, status: "anchored" };
        return { attested: true, ledgerId: "L1", blockHeight: 4477946, eventHash: "eh-1", status: "anchored" as const, receipt };
      },
      verifyReceipt: async () => ({ verified: true }),
    };
    return { clock, captured };
  }

  async function seed(): Promise<{ companyId: string; granteeAgentId: string; mandateId: string }> {
    const [company] = await db.insert(companies).values({ name: "ZK Permission Co" }).returning();
    const [grantor] = await db.insert(agents).values({ companyId: company.id, name: "Grantor" }).returning();
    const [grantee] = await db.insert(agents).values({ companyId: company.id, name: "Grantee" }).returning();
    const [mandate] = await db
      .insert(mandates)
      .values({
        companyId: company.id,
        grantorAgentId: grantor.id,
        granteeAgentId: grantee.id,
        scope: [ACTION],
        permissionKey: "clockchain:attest",
        spendCapCents: 100_000,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning();
    return { companyId: company.id, granteeAgentId: grantee.id, mandateId: mandate.id };
  }

  function serviceWith(clock: unknown, db_: typeof db) {
    const identity = { resolveAgentDid: async () => ACTOR_DID };
    const mandatesStub = {
      verifyMandate: async () => ({ status: "authorized" as const, scope: [ACTION], spendCapCents: 100_000 }),
    };
    const zk = zkPermissionService(db_);
    // approvals/agents are unused on the performMandatedAction path.
    return mandatedActionService(db_, clock as never, identity as never, mandatesStub as never, {} as never, {} as never, zk);
  }

  it(
    "flag ON: generates a proof, binds proof_hash into attest inputs, persists it, and the verifier confirms both checks",
    async () => {
      process.env.AGENTDASH_ZK_PROOF_ENABLED = "true";
      const { companyId, granteeAgentId, mandateId } = await seed();
      const { clock, captured } = makeClock();
      const svc = serviceWith(clock, db);

      const now = new Date("2026-07-18T00:00:00.000Z");
      const result = await svc.performMandatedAction(
        { companyId, granteeAgentId, mandateId, counterpartyDid: "did:x:cp", action: ACTION, payload: { amountCents: 100 } },
        now,
      );

      expect(result.authorized).toBe(true);
      expect(result.permissionProof).toBeDefined();
      expect(result.permissionProof?.anchored).toBe(true);
      expect(result.permissionProof?.note).toBeUndefined();
      const proofHash = result.permissionProof?.proofHash;
      expect(proofHash).toMatch(/^[0-9a-f]{64}$/);

      // proof_hash rode the EXISTING attest inputs path (no gateway change).
      const carried = captured.inputs?.permission_proof as { proof_hash?: string; scheme?: string } | undefined;
      expect(carried?.proof_hash).toBe(proofHash);
      expect(carried?.scheme).toBe("semaphore-v4");

      // Full proof bytes + nullifier were persisted off-chain.
      const rows = await db.select().from(zkPermissionProofs);
      expect(rows).toHaveLength(1);
      expect(rows[0].proofHash).toBe(proofHash);
      expect(rows[0].receiptStatus).toBe("anchored");
      expect(rows[0].proofBytes.length).toBeGreaterThan(0);

      // Verifier flow: (a) off-chain ZK verify + (b) verify_receipt both pass.
      const zk = zkPermissionService(db);
      const verdict = await zk.verifyStoredProof(companyId, proofHash!, clock as never);
      expect(verdict.found).toBe(true);
      expect(verdict.proofValid).toBe(true);
      expect(verdict.anchored).toBe(true);
      expect(verdict.publicSignals?.scope).toBe(ACTION);
    },
    PROOF_TIMEOUT,
  );

  it(
    "flag ON: a replayed proof (same identity, scope, T) is rejected — attested WITHOUT a proof, only one row stored",
    async () => {
      process.env.AGENTDASH_ZK_PROOF_ENABLED = "true";
      const { companyId, granteeAgentId, mandateId } = await seed();
      const now = new Date("2026-07-18T00:00:00.000Z"); // identical T => identical nullifier

      const first = serviceWith(makeClock().clock, db);
      const r1 = await first.performMandatedAction(
        { companyId, granteeAgentId, mandateId, counterpartyDid: "did:x:cp", action: ACTION, payload: { amountCents: 100 } },
        now,
      );
      expect(r1.permissionProof?.anchored).toBe(true);

      const second = makeClock();
      const svc2 = serviceWith(second.clock, db);
      const r2 = await svc2.performMandatedAction(
        { companyId, granteeAgentId, mandateId, counterpartyDid: "did:x:cp", action: ACTION, payload: { amountCents: 100 } },
        now,
      );

      // The action still authorizes, but the reused proof is NOT re-anchored and is flagged.
      expect(r2.authorized).toBe(true);
      expect(r2.permissionProof?.anchored).toBe(false);
      expect(r2.permissionProof?.note).toBe("replay_rejected");
      // Attest ran WITHOUT a permission_proof (we never anchor a reused proof claim).
      expect(second.captured.inputs?.permission_proof).toBeUndefined();

      const rows = await db.select().from(zkPermissionProofs);
      expect(rows).toHaveLength(1); // no duplicate row
    },
    PROOF_TIMEOUT,
  );

  it(
    "flag OFF (default): no proof generated, attest inputs carry no permission_proof, nothing persisted",
    async () => {
      delete process.env.AGENTDASH_ZK_PROOF_ENABLED;
      const { companyId, granteeAgentId, mandateId } = await seed();
      const { clock, captured } = makeClock();
      const svc = serviceWith(clock, db);

      const result = await svc.performMandatedAction(
        { companyId, granteeAgentId, mandateId, counterpartyDid: "did:x:cp", action: ACTION, payload: { amountCents: 100 } },
        new Date("2026-07-18T00:00:00.000Z"),
      );

      expect(result.authorized).toBe(true);
      expect(result.permissionProof).toBeUndefined();
      expect(captured.inputs?.permission_proof).toBeUndefined();
      const rows = await db.select().from(zkPermissionProofs);
      expect(rows).toHaveLength(0);
    },
    PROOF_TIMEOUT,
  );
});
