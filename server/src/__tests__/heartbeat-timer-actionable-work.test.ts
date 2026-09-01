import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat timer actionable-work gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-timer-actionable-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed(status?: "todo" | "in_progress" | "blocked" | "in_review") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Timer Gate Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
      status: "idle",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
      lastHeartbeatAt: new Date("2026-08-26T16:00:00.000Z"),
    });
    if (status) {
      await db.insert(issues).values({
        companyId,
        title: `${status} work`,
        status,
        assigneeAgentId: agentId,
      });
    }
    return { agentId };
  }

  it("does not create a run or invoke work for a due agent with no actionable task", async () => {
    await seed();
    const result = await heartbeatService(db, { autoDispatchQueuedRuns: false }).tickTimers(
      new Date("2026-08-26T16:10:00.000Z"),
    );

    expect(result).toEqual({ checked: 1, enqueued: 0, skipped: 0, skippedNoWork: 1 });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });

  it("does not re-poll an idle due agent before its configured interval elapses", async () => {
    const { agentId } = await seed();
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    await heartbeat.tickTimers(new Date("2026-08-26T16:10:00.000Z"));
    await db.insert(issues).values({
      companyId: (await db.select().from(agents).then((rows) => rows[0]!)).companyId,
      title: "work added after an idle poll",
      status: "todo",
      assigneeAgentId: agentId,
    });

    await heartbeat.tickTimers(new Date("2026-08-26T16:10:30.000Z"));
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);

    await heartbeat.tickTimers(new Date("2026-08-26T16:15:00.000Z"));
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it.each(["todo", "in_progress"] as const)(
    "enqueues one timer wake for assigned %s work",
    async (status) => {
      await seed(status);
      const result = await heartbeatService(db, { autoDispatchQueuedRuns: false }).tickTimers(
        new Date("2026-08-26T16:10:00.000Z"),
      );
      expect(result).toEqual({ checked: 1, enqueued: 1, skipped: 0, skippedNoWork: 0 });
      expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    },
  );

  it("does not count an already queued wake as a newly enqueued timer run", async () => {
    const { agentId } = await seed("todo");
    const [agent] = await db.select().from(agents);
    await db.insert(heartbeatRuns).values({
      companyId: agent!.companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: {},
    });

    const result = await heartbeatService(db, { autoDispatchQueuedRuns: false }).tickTimers(
      new Date("2026-08-26T16:10:00.000Z"),
    );

    expect(result).toEqual({ checked: 1, enqueued: 0, skipped: 1, skippedNoWork: 0 });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it("keeps assigned in-review work idle", async () => {
    await seed("in_review");
    const result = await heartbeatService(db, { autoDispatchQueuedRuns: false }).tickTimers(
      new Date("2026-08-26T16:10:00.000Z"),
    );
    expect(result).toEqual({ checked: 1, enqueued: 0, skipped: 0, skippedNoWork: 1 });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });
});
