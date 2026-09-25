import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  stewardInboxEvents,
} from "@paperclipai/db";
import { AGENT_DEFAULT_MAX_DAILY_TOKENS } from "@paperclipai/shared";
import { heartbeatService } from "../services/heartbeat.js";
import {
  TOKEN_CEILING_SKIP_REASON,
  UNMETERED_RUNAWAY_GUARD_LIMIT,
  UNMETERED_RUNAWAY_GUARD_REASON,
} from "../services/token-ceiling.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * OBS-2 (#695): the daily token ceiling at the wake gate. Timer and comment
 * wakes — the unattended spend that caused the 09-15→09-21 incident — pause
 * once today's metered tokens reach the ceiling; work a person aimed at the
 * agent still runs. The pause announces itself once per agent per day.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat token ceiling", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ceiling-gate-");
    db = createDb(tempDb.connectionString);
    // These tests decide whether a wake is *enqueued*; none should execute a
    // run (same reasoning as heartbeat-wake-gate.test.ts — a live dispatch
    // races the afterEach truncate).
    heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input?: {
    maxDailyTokens?: number | null;
    productProfile?: string;
    adapterType?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Ceil Co ${companyId.slice(0, 6)}`,
      issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      productProfile: input?.productProfile ?? "default",
    });
    const heartbeat: Record<string, unknown> = { enabled: true, wakeOnDemand: true };
    if (input && "maxDailyTokens" in input) heartbeat.maxDailyTokens = input.maxDailyTokens;
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Spendy",
      role: "engineer",
      status: "active",
      adapterType: input?.adapterType ?? "process",
      adapterConfig: { command: "echo" },
      runtimeConfig: { heartbeat },
      permissions: {},
    });
    return { companyId, agentId };
  }

  /**
   * The scheduler's real timer wake, verbatim from runDueAgents: the reason is
   * "heartbeat_timer", which enrichWakeContextSnapshot stamps into
   * contextSnapshot.wakeReason — the field normalizeWakeReason reads. A
   * synthetic `{source: "timer"}` wake would not prove the production path is
   * classified as pausable; this is the shape that was actually never paused.
   */
  const SCHEDULER_TIMER_WAKE = {
    source: "timer",
    triggerDetail: "system",
    reason: "heartbeat_timer",
    requestedByActorType: "system",
    requestedByActorId: "heartbeat_scheduler",
    contextSnapshot: { source: "scheduler", reason: "interval_elapsed" },
  } as const;

  /** A finished, metered run — the shape OBS-1's finalization writes. */
  async function seedMeteredRun(
    companyId: string,
    agentId: string,
    tokens: number,
    createdAt = new Date(),
    meteringStatus = "metered",
    wakeReason = "timer",
    ledgerCertainty: string | null = null,
  ) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "succeeded",
      resultJson: {
        runFacts: {
          meteringStatus,
          ledgerCertainty,
          inputTokens: meteringStatus.startsWith("unmetered") ? null : tokens,
          cachedInputTokens: null,
          outputTokens: meteringStatus.startsWith("unmetered") ? null : 0,
          outcome: "no_op",
          wakeReason,
        },
      },
      createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
    });
  }

  async function skippedRequestsToday(agentId: string, reason: string = TOKEN_CEILING_SKIP_REASON) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "skipped"),
          eq(agentWakeupRequests.reason, reason),
        ),
      );
  }

  it("replays the incident: ~40 timer runs at ~250K tokens trip the ceiling that day", async () => {
    const { companyId, agentId } = await seedAgent();
    for (let i = 0; i < 40; i += 1) {
      await seedMeteredRun(companyId, agentId, 250_000);
    }

    const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
    expect(run).toBeNull();

    const skips = await skippedRequestsToday(agentId);
    expect(skips).toHaveLength(1);
    expect(skips[0]!.source).toBe("timer");
  });

  it("skips a timer wake at the default ceiling and records reason token_ceiling", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);

    const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
    expect(run).toBeNull();
    const skips = await skippedRequestsToday(agentId);
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe("token_ceiling");
  });

  it("skips a comment wake too — comments are unattended spend the same way", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Commented task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      reason: "issue_commented",
      contextSnapshot: { wakeReason: "issue_commented", issueId },
    });
    expect(run).toBeNull();
    expect(await skippedRequestsToday(agentId)).toHaveLength(1);
  });

  it("lets assigned work run even over the ceiling", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned task",
      status: "todo",
      assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      reason: "issue_assigned",
      contextSnapshot: { wakeReason: "issue_assigned", issueId },
    });
    expect(run).not.toBeNull();
    expect(run?.status).toBe("queued");
  });

  it("lets a manual wake run even over the ceiling", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });
    expect(run).not.toBeNull();
  });

  it("does not trip on unmetered runs — a ledger outage cannot pause an agent", async () => {
    const { companyId, agentId } = await seedAgent();
    // Past the guard limit on a never-metering adapter with no ledger
    // verdict: none of these are metering-expected, so the guard stays off.
    for (let i = 0; i < UNMETERED_RUNAWAY_GUARD_LIMIT + 1; i += 1) {
      await seedMeteredRun(companyId, agentId, 0, new Date(), "unmetered_no_ledger");
    }

    const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
    expect(run).not.toBeNull();
  });

  it("runs again the moment the ceiling is raised above today's spend", async () => {
    const { companyId, agentId } = await seedAgent({
      maxDailyTokens: 10_000_000,
    });
    await seedMeteredRun(companyId, agentId, 6_000_000);

    const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
    expect(run).not.toBeNull();
  });

  it("honours an explicit off even when the day is over the default", async () => {
    const { companyId, agentId } = await seedAgent({ maxDailyTokens: 0 });
    await seedMeteredRun(companyId, agentId, 6_000_000);

    const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
    expect(run).not.toBeNull();
  });

  it("resumes by itself at the UTC day boundary", async () => {
    const { companyId, agentId } = await seedAgent();
    // Yesterday was a blowout; today is a fresh window.
    await seedMeteredRun(
      companyId,
      agentId,
      9_000_000,
      new Date(Date.now() - 26 * 60 * 60 * 1000),
    );

    const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
    expect(run).not.toBeNull();
  });

  it("posts exactly one steward inbox item per agent per day", async () => {
    const { companyId, agentId } = await seedAgent({ productProfile: "agentdash_mk" });
    const stewardUserId = "user-steward-1";
    await db.insert(agentStewardships).values({ companyId, agentId, userId: stewardUserId });
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);

    // Three over-ceiling timer wakes in the same UTC day.
    for (let i = 0; i < 3; i += 1) {
      expect(await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE)).toBeNull();
    }
    expect(await skippedRequestsToday(agentId)).toHaveLength(3);

    const inbox = await db
      .select()
      .from(stewardInboxEvents)
      .where(
        and(
          eq(stewardInboxEvents.companyId, companyId),
          eq(stewardInboxEvents.kind, "agent.token_ceiling"),
        ),
      );
    expect(inbox, "one inbox item per agent per day, not per skipped wake").toHaveLength(1);
    expect(inbox[0]!.stewardUserId).toBe(stewardUserId);
    expect(inbox[0]!.agentId).toBe(agentId);
    expect(inbox[0]!.payload).toMatchObject({ ceiling: AGENT_DEFAULT_MAX_DAILY_TOKENS });

    const pauses = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.agentId, agentId),
          eq(activityLog.action, "agent.token_ceiling_paused"),
        ),
      );
    expect(pauses).toHaveLength(1);
  });

  it("notes unmetered runs in the inbox payload when metering is off", async () => {
    const { companyId, agentId } = await seedAgent({ productProfile: "agentdash_mk" });
    await db
      .insert(agentStewardships)
      .values({ companyId, agentId, userId: "user-steward-2" });
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);
    await seedMeteredRun(companyId, agentId, 0, new Date(), "unmetered_no_session");

    expect(await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE)).toBeNull();

    const inbox = await db
      .select()
      .from(stewardInboxEvents)
      .where(eq(stewardInboxEvents.kind, "agent.token_ceiling"));
    expect(inbox).toHaveLength(1);
    const payload = inbox[0]!.payload as Record<string, unknown>;
    expect(payload.unmeteredRuns).toBe(1);
    expect(String(payload.message)).toContain("Metering is off");
  });

  describe("unmetered runaway guard", () => {
    /**
     * Unmetered runs where metering was expected — a certain ledger that
     * resolved to no session — so they feed the guard even on this file's
     * default `process` adapter (which never meters on its own).
     */
    async function seedUnmeteredRuns(
      companyId: string,
      agentId: string,
      count: number,
      wakeReason = "timer",
      createdAt = new Date(),
    ) {
      for (let i = 0; i < count; i += 1) {
        await seedMeteredRun(
          companyId,
          agentId,
          0,
          createdAt,
          "unmetered_no_session",
          wakeReason,
          "certain",
        );
      }
    }

    it(`allows ${UNMETERED_RUNAWAY_GUARD_LIMIT} unmetered timer runs — the guard trips above the count`, async () => {
      const { companyId, agentId } = await seedAgent();
      await seedUnmeteredRuns(companyId, agentId, UNMETERED_RUNAWAY_GUARD_LIMIT);

      const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
      expect(run).not.toBeNull();
      expect(await skippedRequestsToday(agentId, UNMETERED_RUNAWAY_GUARD_REASON)).toHaveLength(0);
    });

    it("skips the next real scheduler wake past the threshold with reason 'unmetered runaway guard'", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedUnmeteredRuns(companyId, agentId, UNMETERED_RUNAWAY_GUARD_LIMIT + 1);

      const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
      expect(run).toBeNull();

      const skips = await skippedRequestsToday(agentId, UNMETERED_RUNAWAY_GUARD_REASON);
      expect(skips).toHaveLength(1);
      expect(skips[0]!.reason).toBe("unmetered runaway guard");
      expect(skips[0]!.source).toBe("timer");
    });

    it("counts unmetered comment runs toward the guard — comments are unattended spend too", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedUnmeteredRuns(companyId, agentId, UNMETERED_RUNAWAY_GUARD_LIMIT + 1, "comment");

      const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
      expect(run).toBeNull();
      expect(await skippedRequestsToday(agentId, UNMETERED_RUNAWAY_GUARD_REASON)).toHaveLength(1);
    });

    it("does not count metered or deliberately-aimed unmetered runs", async () => {
      const { companyId, agentId } = await seedAgent();
      // The guard counts only unmetered timer/comment runs: a metered run and
      // unmetered runs a person aimed at the agent must not feed it — more of
      // these than the limit would otherwise look like a runaway.
      for (let i = 0; i < UNMETERED_RUNAWAY_GUARD_LIMIT + 1; i += 1) {
        await seedMeteredRun(companyId, agentId, 1_000);
        await seedMeteredRun(companyId, agentId, 0, new Date(), "unmetered_no_ledger", "assignment");
      }
      await seedMeteredRun(companyId, agentId, 0, new Date(), "unmetered_no_ledger", "manual");
      await seedMeteredRun(companyId, agentId, 0, new Date(), "unmetered_no_ledger", "mention");

      const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
      expect(run).not.toBeNull();
    });

    it("lets assigned and manual wakes run even when the guard has tripped", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedUnmeteredRuns(companyId, agentId, UNMETERED_RUNAWAY_GUARD_LIMIT + 1);
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Assigned task",
        status: "todo",
        assigneeAgentId: agentId,
      });

      const assigned = await heartbeat.wakeup(agentId, {
        source: "assignment",
        reason: "issue_assigned",
        contextSnapshot: { wakeReason: "issue_assigned", issueId },
      });
      expect(assigned).not.toBeNull();

      const manual = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
      });
      expect(manual).not.toBeNull();
    });

    it("resets at the UTC day boundary", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedUnmeteredRuns(
        companyId,
        agentId,
        UNMETERED_RUNAWAY_GUARD_LIMIT + 1,
        "timer",
        new Date(Date.now() - 26 * 60 * 60 * 1000),
      );

      const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
      expect(run).not.toBeNull();
    });

    it("announces the runaway pause once per agent per day with the guard reason", async () => {
      const { companyId, agentId } = await seedAgent({ productProfile: "agentdash_mk" });
      await db
        .insert(agentStewardships)
        .values({ companyId, agentId, userId: "user-steward-guard" });
      await seedUnmeteredRuns(companyId, agentId, UNMETERED_RUNAWAY_GUARD_LIMIT + 1);

      for (let i = 0; i < 3; i += 1) {
        expect(await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE)).toBeNull();
      }
      expect(
        await skippedRequestsToday(agentId, UNMETERED_RUNAWAY_GUARD_REASON),
      ).toHaveLength(3);

      const inbox = await db
        .select()
        .from(stewardInboxEvents)
        .where(eq(stewardInboxEvents.kind, "agent.token_ceiling"));
      expect(inbox).toHaveLength(1);
      const payload = inbox[0]!.payload as Record<string, unknown>;
      expect(payload.pauseReason).toBe("unmetered runaway guard");
      expect(payload.unmeteredPausableRuns).toBe(UNMETERED_RUNAWAY_GUARD_LIMIT + 1);
      expect(String(payload.message)).toContain("unmetered runaway guard");
    });

    it("counts unmetered runs on a usage-reporting adapter even without a ledger verdict", async () => {
      const { companyId, agentId } = await seedAgent({ adapterType: "codex_local" });
      // No ledgerCertainty — the adapter type alone means metering was
      // expected, so an unmetered flood still reads as a runaway.
      for (let i = 0; i < UNMETERED_RUNAWAY_GUARD_LIMIT + 1; i += 1) {
        await seedMeteredRun(companyId, agentId, 0, new Date(), "unmetered_no_ledger");
      }

      const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
      expect(run).toBeNull();
      expect(
        await skippedRequestsToday(agentId, UNMETERED_RUNAWAY_GUARD_REASON),
      ).toHaveLength(1);
    });

    it("an explicit ceiling of 0 disables the guard too — off means off", async () => {
      const { companyId, agentId } = await seedAgent({ maxDailyTokens: 0 });
      await seedUnmeteredRuns(companyId, agentId, UNMETERED_RUNAWAY_GUARD_LIMIT + 1);

      const run = await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE);
      expect(run).not.toBeNull();
      expect(
        await skippedRequestsToday(agentId, UNMETERED_RUNAWAY_GUARD_REASON),
      ).toHaveLength(0);
    });
  });
});
