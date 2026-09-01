import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  deriveNormalizedUsageDelta,
  pickUsageBaseline,
} from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * How a run's own token consumption is worked out.
 *
 * Adapters that resume a session report the session's RUNNING TOTAL, so a run
 * consumed (this total − the previous run's total). The subtraction is only
 * correct if "the previous run" is one that actually reported a total.
 *
 * A failed run reports nothing. So after a stretch of failures the next success
 * found no baseline and the whole session history was charged to that single
 * run. Observed on a live instance: 144 consecutive failures across three days,
 * then a six-second run booked at 11,622,466 input tokens — roughly doubling
 * the reported spend for that agent. The tokens were real once and counted
 * twice, which is worse than not metering at all: it is a wrong number that
 * looks like a measurement.
 */
describe("pickUsageBaseline", () => {
  const totals = (inputTokens: number) => ({
    inputTokens,
    cachedInputTokens: 0,
    outputTokens: 10,
    rawInputTokens: inputTokens,
  });

  it("takes the newest row that reported usage", () => {
    const picked = pickUsageBaseline([
      { id: "newest", usageJson: totals(300) },
      { id: "older", usageJson: totals(200) },
    ]);
    expect(picked?.id).toBe("newest");
    expect(picked?.totals.inputTokens).toBe(300);
  });

  it("skips runs that recorded nothing, however many there are", () => {
    // The shape of the incident: a long tail of failures between two real runs.
    const rows = [
      ...Array.from({ length: 144 }, (_, i) => ({ id: `failed-${i}`, usageJson: null })),
      { id: "last-good", usageJson: totals(11_405_159) },
    ];
    expect(pickUsageBaseline(rows)?.id).toBe("last-good");
  });

  it("skips a usage object that is present but empty", () => {
    // A run can record the shape without any countable totals. Treating that as
    // a baseline of zero would charge the whole session to the next run, which
    // is the same bug wearing a different hat.
    const picked = pickUsageBaseline([
      { id: "empty", usageJson: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } },
      { id: "real", usageJson: totals(500) },
    ]);
    expect(picked?.id).toBe("real");
  });

  it("returns null when nothing in the session has reported usage", () => {
    // Genuinely the first run of a session. The caller charges the full totals,
    // which is correct — there is no history to have already counted.
    expect(pickUsageBaseline([{ id: "a", usageJson: null }])).toBeNull();
    expect(pickUsageBaseline([])).toBeNull();
  });
});

describe("deriveNormalizedUsageDelta", () => {
  const t = (inputTokens: number, outputTokens = 0) => ({
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
  });

  it("charges the difference when a baseline exists", () => {
    expect(deriveNormalizedUsageDelta(t(11_622_466, 5_870), t(11_405_159, 5_849))).toEqual({
      inputTokens: 217_307,
      cachedInputTokens: 0,
      outputTokens: 21,
    });
  });

  it("charges everything only when there is genuinely no baseline", () => {
    expect(deriveNormalizedUsageDelta(t(25_522), null)).toEqual({
      inputTokens: 25_522,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });

  it("treats a total that went backwards as a fresh session", () => {
    // Session rotation resets the counter; the current value is then the run's
    // own consumption rather than a negative delta.
    expect(deriveNormalizedUsageDelta(t(80_000), t(400_000))).toEqual({
      inputTokens: 80_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * The same rule against the real query shape, because the defect was half in
 * SQL: the lookup took whichever run was most recent and only then asked
 * whether it had usage.
 */
describeEmbeddedPostgres("usage baseline against the real table", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-usage-baseline-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Usage Co",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Metered",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  /** Mirrors the production query. */
  async function baselineFor(agentId: string, sessionId: string, excludeRunId: string) {
    const rows = await db
      .select({ id: heartbeatRuns.id, usageJson: heartbeatRuns.usageJson })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.sessionIdAfter, sessionId),
          isNotNull(heartbeatRuns.usageJson),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(500);
    return pickUsageBaseline(rows.filter((r) => r.id !== excludeRunId));
  }

  it("looks past a three-day run of failures to the last real total", async () => {
    const { companyId, agentId } = await seed();
    const sessionId = "01a0185d-c346-79d1-ab62-a8200e3ed909";
    const start = Date.now() - 5 * 24 * 60 * 60 * 1000;

    const goodId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: goodId,
      companyId,
      agentId,
      status: "succeeded",
      sessionIdAfter: sessionId,
      usageJson: { rawInputTokens: 11_405_159, rawOutputTokens: 5_849, rawCachedInputTokens: 6_996_224 },
      createdAt: new Date(start),
    });

    // 144 failures, every 30 minutes, exactly as the incident ran.
    for (let i = 1; i <= 144; i += 1) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "failed",
        sessionIdAfter: sessionId,
        usageJson: null,
        createdAt: new Date(start + i * 30 * 60 * 1000),
      });
    }

    const currentId = randomUUID();
    const baseline = await baselineFor(agentId, sessionId, currentId);
    expect(baseline?.id, "baseline should be the last run that reported usage").toBe(goodId);

    const charged = deriveNormalizedUsageDelta(
      { inputTokens: 11_622_466, cachedInputTokens: 7_007_232, outputTokens: 5_870 },
      baseline?.totals ?? null,
    );
    // The six-second run consumed 217,307 — not the 11,622,466 it was booked at.
    expect(charged?.inputTokens).toBe(217_307);
    expect(charged?.outputTokens).toBe(21);
  });

  it("still charges the full total for the first run of a session", async () => {
    const { companyId, agentId } = await seed();
    const sessionId = "fresh-session";
    const currentId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: currentId,
      companyId,
      agentId,
      status: "succeeded",
      sessionIdAfter: sessionId,
      usageJson: { rawInputTokens: 25_522, rawOutputTokens: 255 },
      createdAt: new Date(),
    });

    const baseline = await baselineFor(agentId, sessionId, currentId);
    expect(baseline).toBeNull();
    expect(
      deriveNormalizedUsageDelta({ inputTokens: 25_522, cachedInputTokens: 0, outputTokens: 255 }, null),
    ).toEqual({ inputTokens: 25_522, cachedInputTokens: 0, outputTokens: 255 });
  });
});
