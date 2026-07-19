import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, approvals as approvalsTable, companies, createDb, mandates } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { handshakeDemoService } from "../services/handshake-demo.ts";
import type { HandshakeAgentRunner } from "../services/handshake-agent-runner.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres handshake-demo agent-driven tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Fakes for the injected collaborators so no real Clockchain/hermes is touched.
// clockchainEnabled() reads env (not injectable), so we set the flags below.
function fakeClock() {
  return { getLogEntry: vi.fn(async () => ({ found: false, anchored: false })) } as never;
}

function fakeMandatesSvc(mandateId: string) {
  const base = {
    id: mandateId,
    companyId: "",
    status: "active",
    ccLedgerId: "ledger-1",
    ccBlockHeight: 1_437_101,
    published: false,
    acceptedAt: null,
    scope: ["release_payment"],
    spendCapCents: 100000,
  };
  return {
    createMandate: vi.fn(async () => ({ ...base })),
    publishMandate: vi.fn(async () => ({ ...base, published: true })),
    acceptMandate: vi.fn(async () => ({ ...base, published: true, acceptedAt: new Date() })),
  } as never;
}

function fakeApprovals() {
  return {
    create: vi.fn(async (_companyId: string, input: Record<string, unknown>) => ({
      id: randomUUID(),
      status: "pending",
      ...input,
    })),
  } as never;
}

const fakeIdentity = { resolveAgentDid: vi.fn(async () => "did:example:billie") } as never;
const fakeActions = { listAttestations: vi.fn(async () => []), runDemoAttestation: vi.fn() } as never;

describeEmbeddedPostgres("handshakeDemoService — agent-driven flag", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const prevEnv = {
    enabled: process.env.AGENTDASH_ATTESTATION_ENABLED,
    key: process.env.CLOCKCHAIN_MCP_KEY,
    flag: process.env.AGENTDASH_HANDSHAKE_AGENT_DRIVEN,
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-handshake-agent-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    process.env.AGENTDASH_ATTESTATION_ENABLED = "true";
    process.env.CLOCKCHAIN_MCP_KEY = "test-key";
    delete process.env.AGENTDASH_HANDSHAKE_AGENT_DRIVEN;
    // Pre-seed the payer company + an already-approved onboarding so advance()
    // reaches the grant step (where the agent gate lives) on the first "Go".
    const [payer] = await db.insert(companies).values({ name: "Meridian Pay", issuePrefix: "MER" }).returning();
    await db.insert(approvalsTable).values({
      companyId: payer.id,
      type: "clockchain_onboarding",
      status: "approved",
      payload: {},
    });
  });

  afterEach(async () => {
    await db.delete(approvalsTable);
    await db.delete(mandates);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    process.env.AGENTDASH_ATTESTATION_ENABLED = prevEnv.enabled;
    process.env.CLOCKCHAIN_MCP_KEY = prevEnv.key;
    process.env.AGENTDASH_HANDSHAKE_AGENT_DRIVEN = prevEnv.flag;
    await tempDb?.cleanup();
  });

  function svc(runner: HandshakeAgentRunner) {
    return handshakeDemoService(
      db,
      fakeClock(),
      fakeIdentity,
      fakeMandatesSvc(randomUUID()),
      fakeApprovals(),
      fakeActions,
      runner,
    );
  }

  it("does NOT invoke the agent runner when the flag is OFF", async () => {
    const runDecision = vi.fn(async () => {
      throw new Error("runner must not be called when the flag is OFF");
    });
    const runner = { runDecision } as unknown as HandshakeAgentRunner;

    const { steps } = await svc(runner).advance();

    expect(runDecision).not.toHaveBeenCalled();
    // reached the mandate step (created + published) with the scripted-real path
    expect(steps.some((s) => s.key === "mandate" && s.status === "done")).toBe(true);
  });

  it("invokes Atlas (the grantor) at the grant step when the flag is ON", async () => {
    process.env.AGENTDASH_HANDSHAKE_AGENT_DRIVEN = "1";
    const runDecision = vi.fn(async () => ({
      decision: "APPROVE: within cap and 7-day window",
      approved: true,
      reasoning: "The cap is proportionate for freight and time-bound.",
      raw: "APPROVE: within cap and 7-day window",
    }));
    const runner = { runDecision } as unknown as HandshakeAgentRunner;

    const { steps } = await svc(runner).advance();

    expect(runDecision).toHaveBeenCalledTimes(1);
    expect(runDecision.mock.calls[0][0]).toMatchObject({ name: "Atlas", role: "ceo" });
    const mandateStep = steps.find((s) => s.key === "mandate");
    expect(mandateStep?.evidence).toMatchObject({ grantorAgent: "Atlas" });
  });

  it("blocks at the grant step and creates no mandate when Atlas DECLINEs", async () => {
    process.env.AGENTDASH_HANDSHAKE_AGENT_DRIVEN = "1";
    const mandatesSvc = fakeMandatesSvc(randomUUID());
    const runDecision = vi.fn(async () => ({
      decision: "DECLINE: vendor not yet vetted",
      approved: false,
      reasoning: "Trellis is not an approved vendor yet.",
      raw: "DECLINE: vendor not yet vetted",
    }));
    const runner = { runDecision } as unknown as HandshakeAgentRunner;

    const demo = handshakeDemoService(
      db,
      fakeClock(),
      fakeIdentity,
      mandatesSvc,
      fakeApprovals(),
      fakeActions,
      runner,
    );
    const { steps, done } = await demo.advance();

    expect(done).toBe(false);
    const mandateStep = steps.find((s) => s.key === "mandate");
    expect(mandateStep?.status).toBe("blocked");
    expect((mandatesSvc as unknown as { createMandate: ReturnType<typeof vi.fn> }).createMandate).not.toHaveBeenCalled();
  });
});
