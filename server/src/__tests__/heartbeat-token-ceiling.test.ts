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
  issueComments,
  issues,
  stewardInboxEvents,
} from "@paperclipai/db";
import { AGENT_DEFAULT_MAX_DAILY_TOKENS } from "@paperclipai/shared";
import { heartbeatService } from "../services/heartbeat.js";
import { dispatchResolvedInteractionContinuation } from "../services/issue-interaction-continuation.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { normalizeWakeReason, WAKE_REQUESTED_DIRECTLY_KEY } from "../services/run-facts.js";
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
    /** Seed a second agent into an existing company. */
    companyId?: string;
    name?: string;
  }) {
    const companyId = input?.companyId ?? randomUUID();
    const agentId = randomUUID();
    if (!input?.companyId) {
      await db.insert(companies).values({
        id: companyId,
        name: `Ceil Co ${companyId.slice(0, 6)}`,
        issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        productProfile: input?.productProfile ?? "default",
      });
    }
    const heartbeat: Record<string, unknown> = { enabled: true, wakeOnDemand: true };
    if (input && "maxDailyTokens" in input) heartbeat.maxDailyTokens = input.maxDailyTokens;
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: input?.name ?? "Spendy",
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

  /** An open issue assigned to the agent, with one comment by a person on it. */
  async function issueWithPersonComment(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Hand-off", status: "in_progress", assigneeAgentId: agentId });
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorUserId: "person-1", body: "Here is what I changed." });
    return { issueId, commentId };
  }

  it("still pauses a plain comment wake, exactly as a person's comment on the page sends it", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);
    const { issueId, commentId } = await issueWithPersonComment(companyId, agentId);

    // issue-patch-actions' comment wake, verbatim.
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId, mutation: "comment" },
      requestedByActorType: "user",
      requestedByActorId: "person-1",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
        wakeReason: "issue_commented",
      },
    });
    expect(run).toBeNull();
    expect(await skippedRequestsToday(agentId)).toHaveLength(1);
  });

  it("wakes the agent with a person's send-back over the ceiling: the wake that was skipped as token_ceiling", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);
    const { issueId, commentId } = await issueWithPersonComment(companyId, agentId);
    const interactionId = randomUUID();

    // The observed wake: source "automation", trigger "system", payload
    // {issueId, mutation: "bridge_reply", commentId, interactionId}.
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "bridge_reply",
      payload: { issueId, mutation: "bridge_reply", commentId, interactionId },
      requestedByActorType: "user",
      requestedByActorId: "person-1",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        interactionId,
        source: "bridge.work.reply",
        wakeReason: "bridge_reply",
      },
    });
    expect(run).not.toBeNull();
    expect(run?.status).toBe("queued");
    expect(await skippedRequestsToday(agentId)).toHaveLength(0);
  });

  it("skips an agent's self-wake that claims a person's reason over the ceiling", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);

    // POST /agents/:id/wakeup as the agent itself, verbatim from the route:
    // the body's `reason` passes straight through.
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "bridge_reply",
      payload: null,
      requestedByActorType: "agent",
      requestedByActorId: agentId,
      contextSnapshot: { triggeredBy: "agent", actorId: agentId, forceFreshSession: false },
    });
    expect(run).toBeNull();
    const skips = await skippedRequestsToday(agentId);
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe("token_ceiling");

    // Claiming a person as the requester in the context does not help: the
    // heartbeat stamps the wake's own actor over it.
    for (const reason of ["changes_requested", "interaction_resolved"]) {
      const forged = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason,
        requestedByActorType: "agent",
        requestedByActorId: agentId,
        contextSnapshot: { wakeReason: reason, wakeRequestedByActorType: "user" },
      });
      expect(forged, reason).toBeNull();
    }
    expect(await skippedRequestsToday(agentId)).toHaveLength(3);
  });

  it("wakes the agent with a person's change request over the ceiling", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);
    const { issueId, commentId } = await issueWithPersonComment(companyId, agentId);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "changes_requested",
      payload: { issueId, commentId, mutation: "comment" },
      requestedByActorType: "user",
      requestedByActorId: "person-1",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
        wakeReason: "changes_requested",
      },
    });
    expect(run).not.toBeNull();
    expect(await skippedRequestsToday(agentId)).toHaveLength(0);
  });

  it("wakes the agent with a person's answer to its question over the ceiling, but not with an agent's", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Asked", status: "in_progress", assigneeAgentId: agentId });
    const interaction = (id: string) => ({
      id,
      kind: "ask_user_questions",
      status: "answered",
      continuationPolicy: "wake_assignee",
      sourceCommentId: null,
      sourceRunId: null,
    });

    // The one continuation every answer path uses: the web route, the
    // inbox, and the bridge's inbox_answer.
    const byPerson = await dispatchResolvedInteractionContinuation({
      heartbeat,
      issue: { id: issueId, assigneeAgentId: agentId, status: "in_progress" },
      interaction: interaction(randomUUID()),
      actor: { actorType: "user", actorId: "person-1" },
      source: "issue.interaction.respond",
    });
    expect(byPerson).not.toBeNull();
    expect(byPerson?.contextSnapshot).toMatchObject({ wakeReason: "interaction_resolved" });
    expect(await skippedRequestsToday(agentId)).toHaveLength(0);

    // Another agent answering is unattended spend: still a comment wake.
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, byPerson!.id));
    const byAgent = await dispatchResolvedInteractionContinuation({
      heartbeat,
      issue: { id: issueId, assigneeAgentId: agentId, status: "in_progress" },
      interaction: interaction(randomUUID()),
      actor: { actorType: "agent", actorId: randomUUID() },
      source: "issue.interaction.respond",
    });
    expect(byAgent).toBeNull();
    expect(await skippedRequestsToday(agentId)).toHaveLength(1);
  });

  describe("wakes an agent requested", () => {
    /**
     * POST /agents/:id/wakeup with an agent key, verbatim from the route: the
     * body's reason and source pass straight through, and the route marks
     * the wake as a direct request.
     */
    function agentWakeupRoute(requesterAgentId: string, body: { reason?: string | null; source?: "on_demand" | "automation" | "assignment" | "timer" } = {}) {
      return {
        source: body.source ?? "on_demand",
        triggerDetail: "manual",
        reason: body.reason ?? null,
        payload: null,
        idempotencyKey: null,
        requestedByActorType: "agent",
        requestedByActorId: requesterAgentId,
        requestedDirectly: true,
        contextSnapshot: { triggeredBy: "agent", actorId: requesterAgentId, forceFreshSession: false },
      } as const;
    }

    it("skips an agent's self-wake with no reason over the ceiling, and says why and until when", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);

      const skips: Array<{ reason: string; tokenCeiling: { paused: boolean; liftsAt: string } | null }> = [];
      const run = await heartbeat.wakeup(agentId, { ...agentWakeupRoute(agentId), onSkipped: (skip) => skips.push(skip) });
      expect(run).toBeNull();
      const rows = await skippedRequestsToday(agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe("on_demand");
      expect(rows[0]!.requestedByActorType).toBe("agent");
      expect(skips).toHaveLength(1);
      expect(skips[0]!.reason).toBe(TOKEN_CEILING_SKIP_REASON);
      expect(skips[0]!.tokenCeiling?.paused).toBe(true);
      expect(Date.parse(skips[0]!.tokenCeiling!.liftsAt)).toBeGreaterThan(Date.now());
    });

    it("skips it with an arbitrary reason, or one that claims assignment, a retry or a person", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);

      const claims = [
        { reason: "keep_going" },
        { reason: "keep_going", source: "automation" },
        { reason: "issue_assigned", source: "assignment" },
        { reason: "process_lost_retry", source: "automation" },
        { reason: "issue_execution_promoted", source: "automation" },
        { reason: "approval_approved" },
        { reason: "bridge_reply" },
      ] as const;
      for (const claim of claims) {
        expect(await heartbeat.wakeup(agentId, agentWakeupRoute(agentId, claim)), claim.reason).toBeNull();
      }
      expect(await skippedRequestsToday(agentId)).toHaveLength(claims.length);
      // A forged direct flag in the caller's context is discarded too.
      const forged = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        requestedByActorType: "user",
        requestedByActorId: "person-1",
        contextSnapshot: { [WAKE_REQUESTED_DIRECTLY_KEY]: false, wakeRequestedByActorType: "agent" },
      });
      expect(forged, "a person's manual wake still runs").not.toBeNull();
    });

    it("skips an agent waking another agent that is over its own ceiling", async () => {
      const { companyId, agentId: targetId } = await seedAgent();
      const { agentId: requesterId } = await seedAgent({ companyId, name: "Requester" });
      await seedMeteredRun(companyId, targetId, AGENT_DEFAULT_MAX_DAILY_TOKENS);

      expect(await heartbeat.wakeup(targetId, agentWakeupRoute(requesterId))).toBeNull();
      expect(await heartbeat.wakeup(targetId, agentWakeupRoute(requesterId, { reason: "please_look" }))).toBeNull();
      // Not marked direct, no reason: still nothing server-side says why.
      expect(
        await heartbeat.wakeup(targetId, {
          source: "on_demand",
          requestedByActorType: "agent",
          requestedByActorId: requesterId,
        }),
      ).toBeNull();
      expect(await skippedRequestsToday(targetId)).toHaveLength(3);
      // The requester is under its own ceiling and is not touched.
      expect(await heartbeat.wakeup(requesterId, agentWakeupRoute(requesterId))).not.toBeNull();
    });

    it("lets a person's manual wake through the same route run over the ceiling", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);

      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: null,
        requestedByActorType: "user",
        requestedByActorId: "person-1",
        requestedDirectly: true,
        contextSnapshot: { triggeredBy: "board", actorId: "person-1", forceFreshSession: false },
      });
      expect(run).not.toBeNull();
      expect(run?.status).toBe("queued");
      expect(await skippedRequestsToday(agentId)).toHaveLength(0);
    });

    it("still wakes an agent another agent assigned an issue to, over the ceiling", async () => {
      const { companyId, agentId: assigneeId } = await seedAgent();
      const { agentId: assignerId } = await seedAgent({ companyId, name: "Assigner" });
      await seedMeteredRun(companyId, assigneeId, AGENT_DEFAULT_MAX_DAILY_TOKENS);
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "Handed over", status: "todo", assigneeAgentId: assigneeId });

      // The hand-off every issue create/update path sends.
      const run = await queueIssueAssignmentWakeup({
        heartbeat,
        issue: { id: issueId, assigneeAgentId: assigneeId, status: "todo" },
        reason: "issue_assigned",
        mutation: "update",
        contextSource: "issue.update",
        requestedByActorType: "agent",
        requestedByActorId: assignerId,
      });
      expect(run).not.toBeNull();
      expect(await skippedRequestsToday(assigneeId)).toHaveLength(0);
    });

    it("still runs retries, execution promotion, and work routing an agent set off, over the ceiling", async () => {
      const { companyId, agentId } = await seedAgent();
      const { agentId: otherAgentId } = await seedAgent({ companyId, name: "Finisher" });
      await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS);

      const wakes = [
        { source: "automation", reason: "process_lost_retry", requestedByActorType: "system", requestedByActorId: "heartbeat" },
        { source: "automation", reason: "transient_failure_retry", requestedByActorType: "system", requestedByActorId: "heartbeat" },
        { source: "automation", reason: "run_liveness_continuation", requestedByActorType: "system", requestedByActorId: "heartbeat" },
        { source: "automation", reason: "issue_execution_promoted", requestedByActorType: "system", requestedByActorId: null },
        { source: "automation", reason: "issue_children_completed", requestedByActorType: "agent", requestedByActorId: otherAgentId },
        { source: "automation", reason: "issue_blockers_resolved", requestedByActorType: "agent", requestedByActorId: otherAgentId },
      ] as const;
      for (const wake of wakes) {
        const issueId = randomUUID();
        await db.insert(issues).values({ id: issueId, companyId, title: wake.reason, status: "in_progress", assigneeAgentId: agentId });
        const run = await heartbeat.wakeup(agentId, {
          ...wake,
          triggerDetail: "system",
          payload: { issueId },
          contextSnapshot: { issueId },
        });
        expect(run, wake.reason).not.toBeNull();
      }
      expect(await skippedRequestsToday(agentId)).toHaveLength(0);
    });

    it("runs every one of them under the ceiling, and labels the agent's own run agent_requested", async () => {
      const { companyId, agentId } = await seedAgent();
      const { agentId: otherAgentId } = await seedAgent({ companyId, name: "Other" });
      await seedMeteredRun(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS - 1);

      const selfWake = await heartbeat.wakeup(agentId, agentWakeupRoute(agentId, { reason: "keep_going" }));
      expect(selfWake).not.toBeNull();
      const context = (selfWake!.contextSnapshot ?? {}) as Record<string, unknown>;
      expect(context[WAKE_REQUESTED_DIRECTLY_KEY]).toBe(true);
      expect(normalizeWakeReason({ invocationSource: selfWake!.invocationSource, contextSnapshot: context })).toBe("agent_requested");

      expect(await heartbeat.wakeup(agentId, agentWakeupRoute(otherAgentId))).not.toBeNull();
      expect(await heartbeat.wakeup(agentId, SCHEDULER_TIMER_WAKE)).not.toBeNull();
      expect(await skippedRequestsToday(agentId)).toHaveLength(0);
    });
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

    it("counts unmetered agent-requested runs toward the guard — an agent waking itself is unattended spend", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedUnmeteredRuns(companyId, agentId, UNMETERED_RUNAWAY_GUARD_LIMIT + 1, "agent_requested");

      const selfWake = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        requestedByActorType: "agent",
        requestedByActorId: agentId,
        requestedDirectly: true,
      });
      expect(selfWake).toBeNull();
      expect(await skippedRequestsToday(agentId, UNMETERED_RUNAWAY_GUARD_REASON)).toHaveLength(1);

      // A person's manual wake is not paused by the guard.
      const manual = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        requestedByActorType: "user",
        requestedByActorId: "person-1",
        requestedDirectly: true,
      });
      expect(manual).not.toBeNull();
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
