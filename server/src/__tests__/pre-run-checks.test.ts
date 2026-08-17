import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { preRunChecks } from "../observability/pre-run-checks.js";
import {
  resetSignalSubscribersForTest,
  subscribeToSignals,
  type Signal,
} from "../observability/signals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("pre-run checks (M3 budget, M4 daily cap)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let COMPANY!: string;
  let AGENT!: string;
  const seen: Signal[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-prerun-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    seen.length = 0;
    resetSignalSubscribersForTest();
    subscribeToSignals((s) => void seen.push(s));
    COMPANY = randomUUID();
    AGENT = randomUUID();
    await db.insert(companies).values({ id: COMPANY, name: `PreRun ${COMPANY.slice(0, 6)}`, issuePrefix: COMPANY.slice(0, 8) });
    await db.insert(agents).values({ id: AGENT, companyId: COMPANY, name: "Runner", role: "general" });
  });

  afterEach(() => {
    delete process.env.AGENTDASH_AGENT_DAILY_RUN_CAP;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRuns(n: number) {
    for (let i = 0; i < n; i++) {
      await db.insert(heartbeatRuns).values({
        companyId: COMPANY,
        agentId: AGENT,
        status: "succeeded",
        invocationSource: "heartbeat",
      } as typeof heartbeatRuns.$inferInsert);
    }
  }

  it("allows a run under the cap and says nothing", async () => {
    process.env.AGENTDASH_AGENT_DAILY_RUN_CAP = "5";
    await seedRuns(4);
    const verdict = await preRunChecks(db, { companyId: COMPANY, agentId: AGENT });
    expect(verdict.allowed).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("refuses at the cap — counting FAILED runs too, a loop of errors must trip it", async () => {
    process.env.AGENTDASH_AGENT_DAILY_RUN_CAP = "5";
    await seedRuns(3);
    await db.insert(heartbeatRuns).values([
      { companyId: COMPANY, agentId: AGENT, status: "failed", invocationSource: "heartbeat" },
      { companyId: COMPANY, agentId: AGENT, status: "failed", invocationSource: "heartbeat" },
    ] as Array<typeof heartbeatRuns.$inferInsert>);

    const verdict = await preRunChecks(db, { companyId: COMPANY, agentId: AGENT });
    expect(verdict.allowed).toBe(false);
    expect(verdict.errorCode).toBe("daily_run_cap");
    expect(seen.map((s) => s.kind)).toContain("run_cap_hit");
  });

  it("budget warn fires at the threshold but the run still starts (notify-only)", async () => {
    await db.insert(budgetPolicies).values({
      companyId: COMPANY,
      scopeType: "company",
      scopeId: COMPANY,
      metric: "billed_cents",
      windowKind: "monthly",
      amount: 10_000, // $100
      warnPercent: 80,
      hardStopEnabled: false,
      notifyEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: COMPANY,
      agentId: AGENT,
      costCents: 8_500,
      provider: "test", model: "test-model", occurredAt: new Date(),
    } as typeof costEvents.$inferInsert);

    const verdict = await preRunChecks(db, { companyId: COMPANY, agentId: AGENT });
    expect(verdict.allowed).toBe(true);
    expect(seen.map((s) => s.kind)).toContain("budget_warn");
  });

  it("hard stop refuses the run when the policy says so", async () => {
    await db.insert(budgetPolicies).values({
      companyId: COMPANY,
      scopeType: "company",
      scopeId: COMPANY,
      metric: "billed_cents",
      windowKind: "monthly",
      amount: 10_000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: COMPANY,
      agentId: AGENT,
      costCents: 10_001,
      provider: "test", model: "test-model", occurredAt: new Date(),
    } as typeof costEvents.$inferInsert);

    const verdict = await preRunChecks(db, { companyId: COMPANY, agentId: AGENT });
    expect(verdict.allowed).toBe(false);
    expect(verdict.errorCode).toBe("budget_hard_stop");
    expect(seen.map((s) => s.kind)).toContain("budget_stop");
  });

  it("over budget with hard stop DISABLED signals but allows — mkboard's deliberate posture until metering is real", async () => {
    await db.insert(budgetPolicies).values({
      companyId: COMPANY,
      scopeType: "company",
      scopeId: COMPANY,
      metric: "billed_cents",
      windowKind: "monthly",
      amount: 10_000,
      warnPercent: 80,
      hardStopEnabled: false,
      notifyEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: COMPANY,
      agentId: AGENT,
      costCents: 20_000,
      provider: "test", model: "test-model", occurredAt: new Date(),
    } as typeof costEvents.$inferInsert);

    const verdict = await preRunChecks(db, { companyId: COMPANY, agentId: AGENT });
    expect(verdict.allowed).toBe(true);
    expect(seen.map((s) => s.kind)).toContain("budget_stop");
  });
});
