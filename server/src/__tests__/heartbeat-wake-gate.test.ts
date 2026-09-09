import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentFactRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { isNotNull, sql } from "drizzle-orm";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * When an agent should wake up at all.
 *
 * A timer wake used to invoke the model to answer a question the database
 * answers for nothing — "is there anything for me to do?" — and on a live
 * instance 88% of one agent's wakes came back "no pending fact requests or
 * assigned issues". Those were also the most expensive wakes, because a wake
 * with no issue attached cannot use the resume-delta prompt and re-sends the
 * agent's entire mandate.
 *
 * The gate has to be tight in both directions: never spend a run on nothing,
 * and never sleep through something. These pin both, plus the sweep that keeps
 * a quiet agent from going silent forever.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat wake gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-gate-");
    db = createDb(tempDb.connectionString);
    // These tests decide whether a run is *enqueued*; they never need one to
    // execute. With the default (production) behavior, enqueueWakeup claims the
    // run and fires `void executeRun(...)`, so the `process` adapter's `echo`
    // run keeps writing heartbeat_runs/agents in the background after the test
    // returns — and the afterEach truncate below deadlocked against it in CI
    // (PostgresError 40P01 on `truncate table companies cascade`, Release lane,
    // 2026-09-02). Turning dispatch off removes the concurrent writer.
    heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
  }, 30_000);

  afterEach(async () => {
    // Nothing in this suite may execute a run; if this ever fires, dispatch has
    // been re-enabled and the truncate below is racing a live run again.
    const executed = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(isNotNull(heartbeatRuns.finishedAt));
    expect(executed).toEqual([]);
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** An agent whose timer is long overdue, so only the gate decides. */
  async function seedDueAgent(heartbeatOverrides: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Gate Co ${companyId.slice(0, 6)}`,
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Gated",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, ...heartbeatOverrides },
      },
      permissions: {},
      // An hour ago: past the interval, well inside the 12h sweep window.
      lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    return { companyId, agentId };
  }

  async function addIssue(
    companyId: string,
    agentId: string | null,
    status: string,
    createdAt = new Date(),
  ) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Something",
      status,
      assigneeAgentId: agentId,
      createdAt,
    });
    return id;
  }

  it("does not wake an agent with nothing to do", async () => {
    await seedDueAgent();
    const result = await heartbeat.tickTimers();
    expect(result.enqueued).toBe(0);
    expect(result.skippedNoWork).toBe(1);
  });

  it("wakes an agent that has an assigned issue to work", async () => {
    const { companyId, agentId } = await seedDueAgent();
    await addIssue(companyId, agentId, "todo");
    const result = await heartbeat.tickTimers();
    expect(result.enqueued).toBe(1);
    expect(result.skippedNoWork).toBe(0);
  });

  it.each(["in_progress", "blocked"])("wakes for an assigned issue in %s", async (status) => {
    const { companyId, agentId } = await seedDueAgent();
    await addIssue(companyId, agentId, status);
    expect((await heartbeat.tickTimers()).enqueued).toBe(1);
  });

  it.each(["done", "cancelled", "backlog"])(
    "does not wake for an assigned issue in %s",
    async (status) => {
      // Finished and not-yet-started work is not a reason to spend a run.
      const { companyId, agentId } = await seedDueAgent();
      await addIssue(companyId, agentId, status);
      expect((await heartbeat.tickTimers()).skippedNoWork).toBe(1);
    },
  );

  it("does not wake for somebody else's issue", async () => {
    const { companyId } = await seedDueAgent();
    await addIssue(companyId, null, "todo");
    expect((await heartbeat.tickTimers()).skippedNoWork).toBe(1);
  });

  it("wakes when a colleague's agent is blocked waiting on an answer", async () => {
    // A fact request is work even with no issue assigned — the asking agent is
    // stopped until this one replies.
    const { companyId, agentId } = await seedDueAgent();
    const askerId = randomUUID();
    await db.insert(agents).values({
      id: askerId,
      companyId,
      name: "Asker",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentFactRequests).values({
      companyId,
      requestedByAgentId: askerId,
      targetAgentId: agentId,
      factKey: "delivery.date",
      question: "When does it ship?",
      pipelineId: "p1",
      runId: "r1",
      status: "asked",
    });

    expect((await heartbeat.tickTimers()).enqueued).toBe(1);
  });

  it("wakes when somebody comments on its issue after its last run", async () => {
    const { companyId, agentId } = await seedDueAgent();
    // The issue is finished, so only the new comment can justify the wake.
    const issueId = await addIssue(companyId, agentId, "done");
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "Can you double-check this?",
      createdAt: new Date(),
    });

    expect((await heartbeat.tickTimers()).enqueued).toBe(1);
  });

  it("ignores a comment that predates the agent's last run", async () => {
    // Already seen. Waking for it again would re-read the same conversation.
    const { companyId, agentId } = await seedDueAgent();
    const issueId = await addIssue(companyId, agentId, "done");
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "Old news",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    expect((await heartbeat.tickTimers()).skippedNoWork).toBe(1);
  });

  it("sweeps a quiet agent through anyway once the sweep interval passes", async () => {
    // The gate is blind to work nobody has filed, and mandates tell agents to
    // watch for things unprompted. Without this the gate would be a cage.
    await seedDueAgent({ sweepIntervalSec: 60 });
    const result = await heartbeat.tickTimers();
    expect(result.enqueued).toBe(1);
    expect(result.skippedNoWork).toBe(0);
  });

  it("can be turned off per agent, restoring the old always-wake behaviour", async () => {
    await seedDueAgent({ requireWork: false });
    expect((await heartbeat.tickTimers()).enqueued).toBe(1);
  });

  it("still respects the interval — the gate does not make an agent wake early", async () => {
    const { companyId, agentId } = await seedDueAgent({ intervalSec: 24 * 60 * 60 });
    await addIssue(companyId, agentId, "todo");
    const result = await heartbeat.tickTimers();
    expect(result.enqueued).toBe(0);
    expect(result.skippedNoWork).toBe(0);
  });
});
