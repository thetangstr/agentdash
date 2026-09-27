import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuns,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { QUOTA_FREE_INCLUDED_RUNS } from "@paperclipai/shared";
import { heartbeatService } from "../services/heartbeat.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * AgentDash (GH #790 review / AGE-121): the quota gate inside claimQueuedRun
 * must cancel a queued run with the `quota_exceeded` error code when a free
 * workspace is out of monthly runs — not merely skip it, and only when billing
 * is actually enabled (dev/self-hosted without Stripe bypasses the gate).
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat quota gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let savedStripeKey: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-quota-gate-");
    db = createDb(tempDb.connectionString);
    // No run is ever executed in this suite — the gate decides at claim time.
    heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
  }, 30_000);

  afterEach(async () => {
    if (savedStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedStripeKey;
    await truncateWithRetry(db, sql`${companies}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Quota Co ${companyId.slice(0, 6)}`,
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      planTier: "free",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quota Test Agent",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  /** Burn the workspace's included free runs so the next claim must refuse. */
  async function exhaustFreeQuota(companyId: string, agentId: string, count = QUOTA_FREE_INCLUDED_RUNS) {
    const completedAt = new Date();
    for (let i = 0; i < count; i++) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "succeeded",
        finishedAt: completedAt,
      });
      await db.insert(agentRuns).values({
        companyId,
        agentId,
        heartbeatRunId: runId,
        completedAt,
      });
    }
  }

  it("cancels the queued run with quota_exceeded when the free allotment is spent", async () => {
    savedStripeKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_quota_gate";
    const { companyId, agentId } = await seedAgent();
    await exhaustFreeQuota(companyId, agentId);

    const run = await heartbeat.wakeup(agentId, { source: "on_demand" });
    expect(run).not.toBeNull();

    const [stored] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id));
    expect(stored.status).toBe("cancelled");
    expect(stored.errorCode).toBe("quota_exceeded");
    expect(stored.error).toContain("quota");

    // The blocked run must not enter the agent_runs ledger.
    const ledgerRows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.heartbeatRunId, run!.id));
    expect(ledgerRows).toEqual([]);
  });

  it("claims normally when billing is not configured on the instance", async () => {
    savedStripeKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    const { companyId, agentId } = await seedAgent();
    await exhaustFreeQuota(companyId, agentId);

    const run = await heartbeat.wakeup(agentId, { source: "on_demand" });
    expect(run).not.toBeNull();

    const [stored] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id));
    expect(stored.status).not.toBe("cancelled");
    expect(stored.errorCode).not.toBe("quota_exceeded");
  });
});
