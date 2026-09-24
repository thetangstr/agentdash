import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { AGENT_DEFAULT_MAX_DAILY_TOKENS } from "@paperclipai/shared";
import {
  resolveMaxDailyTokens,
  tokenCeilingService,
  utcDayWindow,
} from "../services/token-ceiling.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * OBS-2 (#695): the per-agent daily token ceiling. The service half — how a
 * configured value resolves to an enforced ceiling, and how the UTC day's
 * metered `runFacts` roll up into "paused or not". The wake-gate behaviour
 * lives in heartbeat-token-ceiling.test.ts.
 */
describe("resolveMaxDailyTokens", () => {
  it("defaults to 5M when the key is absent", () => {
    expect(resolveMaxDailyTokens({})).toEqual({
      ceiling: AGENT_DEFAULT_MAX_DAILY_TOKENS,
      isDefault: true,
    });
    expect(resolveMaxDailyTokens({ heartbeat: {} })).toEqual({
      ceiling: AGENT_DEFAULT_MAX_DAILY_TOKENS,
      isDefault: true,
    });
    expect(resolveMaxDailyTokens(null)).toEqual({
      ceiling: AGENT_DEFAULT_MAX_DAILY_TOKENS,
      isDefault: true,
    });
  });

  it("treats explicit 0 and null as off", () => {
    for (const maxDailyTokens of [0, null]) {
      expect(resolveMaxDailyTokens({ heartbeat: { maxDailyTokens } })).toEqual({
        ceiling: null,
        isDefault: false,
      });
    }
  });

  it("honours a positive override, floored", () => {
    expect(resolveMaxDailyTokens({ heartbeat: { maxDailyTokens: 1_000_000 } })).toEqual({
      ceiling: 1_000_000,
      isDefault: false,
    });
    expect(resolveMaxDailyTokens({ heartbeat: { maxDailyTokens: 999.9 } })).toEqual({
      ceiling: 999,
      isDefault: false,
    });
  });

  it("falls back to the default on malformed values — a typo must not disable the bound", () => {
    for (const maxDailyTokens of [-5, "off", NaN, Infinity, true]) {
      const resolved = resolveMaxDailyTokens({ heartbeat: { maxDailyTokens } });
      expect(resolved.ceiling).toBe(AGENT_DEFAULT_MAX_DAILY_TOKENS);
    }
  });
});

describe("utcDayWindow", () => {
  it("frames the UTC calendar day", () => {
    const w = utcDayWindow(new Date("2026-09-20T23:59:59Z"));
    expect(w.dayKey).toBe("2026-09-20");
    expect(w.start.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(w.liftsAt.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("token ceiling daily usage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-token-ceiling-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(runtimeConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ceiling Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Capped",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig,
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedMeteredRun(
    companyId: string,
    agentId: string,
    runFacts: Record<string, unknown>,
    createdAt = new Date(),
  ) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "succeeded",
      resultJson: { runFacts },
      createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
    });
  }

  it("sums input + cached input + output across today's metered runs", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, {
      meteringStatus: "metered",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
      outcome: "produced",
    });
    await seedMeteredRun(companyId, agentId, {
      meteringStatus: "adapter_reported",
      inputTokens: 200,
      outputTokens: 20,
      outcome: "no_op",
    });

    const usage = await tokenCeilingService(db).dailyUsage(companyId, agentId, new Date());
    expect(usage.totalTokens).toBe(370);
    expect(usage.meteredRuns).toBe(2);
    // The no_op run's 220 tokens are the wasted share.
    expect(usage.noOpTokens).toBe(220);
    expect(usage.unmeteredRuns).toBe(0);
  });

  it("never counts unmetered runs — missing metering is unknown spend, not zero", async () => {
    const { companyId, agentId } = await seedAgent({
      heartbeat: { maxDailyTokens: 100 },
    });
    for (const status of ["unmetered_no_ledger", "unmetered_no_session"]) {
      await seedMeteredRun(companyId, agentId, {
        meteringStatus: status,
        inputTokens: null,
        outputTokens: null,
        outcome: "no_op",
      });
    }
    // Even a metered row under the ceiling stays under — the unmetered ones
    // contribute nothing.
    await seedMeteredRun(companyId, agentId, {
      meteringStatus: "metered",
      inputTokens: 50,
      outputTokens: 10,
    });

    const status = await tokenCeilingService(db).evaluate({
      id: agentId,
      companyId,
      runtimeConfig: { heartbeat: { maxDailyTokens: 100 } },
    });
    expect(status.tokensToday).toBe(60);
    expect(status.unmeteredRuns).toBe(2);
    expect(status.paused).toBe(false);
  });

  it("pauses at the ceiling, not just past it", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, {
      meteringStatus: "metered",
      inputTokens: 4_990_000,
      outputTokens: 10_000,
    });

    const status = await tokenCeilingService(db).evaluate(
      { id: agentId, companyId, runtimeConfig: {} },
      new Date(),
    );
    expect(status.ceiling).toBe(AGENT_DEFAULT_MAX_DAILY_TOKENS);
    expect(status.isDefault).toBe(true);
    expect(status.tokensToday).toBe(5_000_000);
    expect(status.paused).toBe(true);
    expect(status.liftsAt).toBe(utcDayWindow(new Date()).liftsAt.toISOString());
  });

  it("respects a per-agent override and an explicit off", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, {
      meteringStatus: "metered",
      inputTokens: 600,
      outputTokens: 0,
    });
    const svc = tokenCeilingService(db);

    const overridden = await svc.evaluate({
      id: agentId,
      companyId,
      runtimeConfig: { heartbeat: { maxDailyTokens: 500 } },
    });
    expect(overridden.paused).toBe(true);
    expect(overridden.ceiling).toBe(500);

    const off = await svc.evaluate({
      id: agentId,
      companyId,
      runtimeConfig: { heartbeat: { maxDailyTokens: 0 } },
    });
    expect(off.ceiling).toBeNull();
    expect(off.paused).toBe(false);
  });

  it("counts only the current UTC day — yesterday's spend does not pause today", async () => {
    const { companyId, agentId } = await seedAgent();
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await seedMeteredRun(
      companyId,
      agentId,
      { meteringStatus: "metered", inputTokens: 9_000_000, outputTokens: 0 },
      yesterday,
    );

    const status = await tokenCeilingService(db).evaluate({
      id: agentId,
      companyId,
      runtimeConfig: {},
    });
    expect(status.tokensToday).toBe(0);
    expect(status.paused).toBe(false);
  });

  it("scopes the sum to the agent — a colleague's spend does not count", async () => {
    const { companyId, agentId } = await seedAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await seedMeteredRun(companyId, otherAgentId, {
      meteringStatus: "metered",
      inputTokens: 9_000_000,
      outputTokens: 0,
    });

    const status = await tokenCeilingService(db).evaluate({
      id: agentId,
      companyId,
      runtimeConfig: {},
    });
    expect(status.tokensToday).toBe(0);
    expect(status.paused).toBe(false);
  });
});
