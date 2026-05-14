// Closes #297: integration coverage for the run-healer eligibility scanner
// against a real embedded Postgres. The previous unit tests stubbed drizzle
// chains, which is what let PR #232's `sql\`= ANY(\${tuple})\`` bug ship as
// a silent no-op (the stub returned []) — exactly the failure mode we now
// want a guardrail for.
//
// We exercise the public `_scanEligibleRunsForTests` hook (added by PR #296)
// rather than the full `scan()` pipeline because scan() also calls into the
// LLM diagnoser + fixer, which would require a live model in CI. The piece
// at risk is the SQL — specifically the `inArray(status, [...])` filter and
// the grouped heal-attempt count join — and that's what this exercises.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  createDb,
  healAttempts,
  heartbeatRuns,
} from "@paperclipai/db";
import { runHealerService } from "../services/run-healer/service.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("run-healer eligibility scan (Postgres integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let healer!: ReturnType<typeof runHealerService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-healer-");
    db = createDb(tempDb.connectionString);
    // Tighten the windows so we can plant rows with mundane timestamps:
    //  - minAgeMs: 1ms — anything older than ~now passes the "stabilized" gate
    //  - lookbackMs: 1h — wide enough that fresh inserts fall inside
    //  - maxHealsPerRun: 2 — we want to assert the over-cap row is dropped
    healer = runHealerService(db, {
      minAgeMs: 1,
      lookbackMs: 60 * 60 * 1000,
      maxHealsPerRun: 2,
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(healAttempts);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Healer Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Healer Target",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("returns failed runs whose error code looks adapter-related", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldEnough = new Date(Date.now() - 60_000);

    const failedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId,
      status: "failed",
      errorCode: "auth_invalid_token",
      error: "API key rejected",
      stderrExcerpt: "auth failed",
      createdAt: oldEnough,
    });

    const eligible = await healer._scanEligibleRunsForTests();
    expect(eligible.map((r) => r.id)).toEqual([failedRunId]);
    expect(eligible[0]).toMatchObject({
      id: failedRunId,
      companyId,
      agentId,
      status: "failed",
      errorCode: "auth_invalid_token",
      adapterType: "claude_local",
      agentName: "Healer Target",
      healAttemptCount: 0,
    });
  });

  it("includes 'running' rows even without an error (the stuck-run case)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldEnough = new Date(Date.now() - 60_000);

    const stuckRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: stuckRunId,
      companyId,
      agentId,
      status: "running",
      createdAt: oldEnough,
    });

    const eligible = await healer._scanEligibleRunsForTests();
    expect(eligible.map((r) => r.id)).toContain(stuckRunId);
  });

  it("excludes runs that have already exceeded maxHealsPerRun", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldEnough = new Date(Date.now() - 60_000);

    const underCapId = randomUUID();
    const overCapId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: underCapId,
        companyId,
        agentId,
        status: "failed",
        errorCode: "auth_invalid_token",
        error: "first attempt",
        createdAt: oldEnough,
      },
      {
        id: overCapId,
        companyId,
        agentId,
        status: "failed",
        errorCode: "auth_invalid_token",
        error: "exhausted attempts",
        createdAt: oldEnough,
      },
    ]);

    // overCapId has 2 prior heal attempts, hitting maxHealsPerRun=2 — must be dropped.
    await db.insert(healAttempts).values([
      {
        runId: overCapId,
        diagnosis: { category: "auth_failure" },
        fixType: "retry",
        actionTaken: "rotate_credentials",
        succeeded: false,
      },
      {
        runId: overCapId,
        diagnosis: { category: "auth_failure" },
        fixType: "retry",
        actionTaken: "rotate_credentials",
        succeeded: false,
      },
    ]);

    const eligible = await healer._scanEligibleRunsForTests();
    const ids = eligible.map((r) => r.id);
    expect(ids).toContain(underCapId);
    expect(ids).not.toContain(overCapId);

    // And the surviving row reports its real heal count from the grouped query.
    const underCap = eligible.find((r) => r.id === underCapId);
    expect(underCap?.healAttemptCount).toBe(0);
  });

  it("excludes runs created outside the lookback window", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const tooOld = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6h, lookback is 1h

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "failed",
      errorCode: "auth_invalid_token",
      error: "ancient",
      createdAt: tooOld,
    });

    const eligible = await healer._scanEligibleRunsForTests();
    expect(eligible).toHaveLength(0);
  });

  it("excludes runs in non-eligible statuses (succeeded/queued)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldEnough = new Date(Date.now() - 60_000);

    await db.insert(heartbeatRuns).values([
      {
        companyId,
        agentId,
        status: "succeeded",
        errorCode: "auth_invalid_token", // even with a "scary" error, succeeded runs are out
        createdAt: oldEnough,
      },
      {
        companyId,
        agentId,
        status: "queued",
        createdAt: oldEnough,
      },
    ]);

    const eligible = await healer._scanEligibleRunsForTests();
    expect(eligible).toHaveLength(0);
  });
});
