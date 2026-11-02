import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, evaluationEvents, evaluationIngestState, heartbeatRuns } from "@paperclipai/db";
import type { AgentCardView } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser, boardActor, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { evaluationAgentRoutes } from "../routes/evaluation-agents.js";
import { evaluationIngest, MAX_BACKFILL_PASSES, withCompanyLock } from "../services/evaluation/ingest.js";
import { evaluationLedger } from "../services/evaluation/ledger.js";
import { SOURCE_READERS } from "../services/evaluation/sources.js";

// AgentDash: the scheduled ingest is on by default (server/src/index.ts), so
// agent cards are drawn from real records without anyone running the ingest
// route. An install whose ledger was never filled — every install from before
// the default changed — gets its history on the first scheduled pass: the pass
// keeps ticking while a source returned a full row budget, bounded, and a
// history larger than the bound goes on at the next pass from the cursor.
// Between ticks the pass lets go of the company lock, so other ledger writers
// get it; a company whose pass fails (a statement timeout, any error) keeps
// what it committed and is backed off, doubling to an hour.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const H = 3_600_000;

describeEmbeddedPostgres("scheduled evaluation ingest (default on)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evaluation-ingest-schedule-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A company with history the ledger has never seen: `runs` finished runs by one agent over the past day. */
  async function companyWithHistory(runs: number) {
    const company = await addCompany(db, "Ingest", "default");
    const ownerId = await addUser(db, company.id, "owner");
    const agent = await addAgent(db, company.id, { name: "Builder" });
    const start = Date.now() - 24 * H;
    for (let i = 0; i < runs; i++) {
      const finishedAt = new Date(start + i * 60_000);
      await db.insert(heartbeatRuns).values({
        companyId: company.id,
        agentId: agent.id,
        status: i % 4 === 3 ? "failed" : "succeeded",
        invocationSource: "timer",
        exitCode: i % 4 === 3 ? 1 : 0,
        startedAt: new Date(finishedAt.getTime() - 30_000),
        finishedAt,
        updatedAt: finishedAt,
      });
    }
    return { company, ownerId, agent };
  }

  async function runEvents(companyId: string) {
    return db
      .select({ id: evaluationEvents.id })
      .from(evaluationEvents)
      .where(and(eq(evaluationEvents.companyId, companyId), eq(evaluationEvents.eventType, "run.finished")));
  }

  async function computeCard(companyId: string, agentId: string, actor: Record<string, unknown>): Promise<AgentCardView> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = { ...actor };
      next();
    });
    app.use("/api", evaluationAgentRoutes(db));
    app.use(errorHandler);
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const res = await request(`http://127.0.0.1:${address.port}`).get(`/api/companies/${companyId}/evaluation/agents/${agentId}/compute`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.card as AgentCardView;
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }

  it("fills a never-ingested ledger on the first scheduled pass, more than one row budget deep, then ticks once", async () => {
    const s = await companyWithHistory(8);
    expect(await db.select().from(evaluationIngestState).where(eq(evaluationIngestState.companyId, s.company.id))).toEqual([]);

    // A row budget of 3: eight runs need three ticks. One scheduled pass reads them all.
    const ingest = evaluationIngest(db, { rowBudget: 3, passYieldMs: 0 });
    const first = (await ingest.tickAll()).find((stats) => stats.companyId === s.company.id)!;
    expect(first).toMatchObject({ caughtUp: true });
    expect(first.passes).toBeGreaterThanOrEqual(3);
    expect(first.perSource.heartbeat_runs).toMatchObject({ scanned: 8, inserted: 8 });
    expect(await runEvents(s.company.id)).toHaveLength(8);

    // Caught up: the next pass is one tick that finds nothing new.
    const second = (await ingest.tickAll()).find((stats) => stats.companyId === s.company.id)!;
    expect(second).toMatchObject({ passes: 1, caughtUp: true, inserted: 0 });
    expect(await runEvents(s.company.id)).toHaveLength(8);
  });

  it("stops a pass at the bound and goes on from the cursor at the next pass", async () => {
    const runs = MAX_BACKFILL_PASSES + 5;
    const s = await companyWithHistory(runs);
    const ingest = evaluationIngest(db, { rowBudget: 1, sources: ["heartbeat_runs"], passYieldMs: 0 });

    const first = (await ingest.tickAll()).find((stats) => stats.companyId === s.company.id)!;
    expect(first).toMatchObject({ passes: MAX_BACKFILL_PASSES, caughtUp: false, inserted: MAX_BACKFILL_PASSES });
    expect(await runEvents(s.company.id)).toHaveLength(MAX_BACKFILL_PASSES);

    const second = (await ingest.tickAll()).find((stats) => stats.companyId === s.company.id)!;
    expect(second).toMatchObject({ caughtUp: true, inserted: 5 });
    expect(await runEvents(s.company.id)).toHaveLength(runs);
  });

  it("an agent card counts the agent's runs after a scheduled pass, with no manual ingest call", async () => {
    const s = await companyWithHistory(8);
    const owner = boardActor(s.company.id, s.ownerId, "owner");

    // Before any ingest the ledger is empty, and so is the card: this was the reported bug.
    const before = await computeCard(s.company.id, s.agent.id, owner);
    expect(before.worker.cost.visibility).toBe("visible");
    if (before.worker.cost.visibility === "not_visible") throw new Error("cost section hidden");
    expect(before.worker.cost.body.runs.total).toBe(0);

    // The scheduler's pass (default budget), not the operator route.
    await evaluationIngest(db).tickAll();

    const after = await computeCard(s.company.id, s.agent.id, owner);
    if (after.worker.cost.visibility === "not_visible") throw new Error("cost section hidden");
    expect(after.worker.cost.body.runs).toMatchObject({ total: 8, succeeded: 6, failed: 2 });
  });

  it("lets go of the company lock between ticks: a writer that tries the lock once gets it mid-pass", async () => {
    const s = await companyWithHistory(8);
    const writes: string[] = [];
    const pauses: number[] = [];
    const ingest = evaluationIngest(db, {
      rowBudget: 3,
      passYieldMs: 2000,
      // Between two ticks, as a snapshot, a disposition or a contract declaration would: one try, no retry.
      pause: async (ms) => {
        pauses.push(ms);
        writes.push(
          await withCompanyLock(db, s.company.id, async (tx) => {
            await evaluationLedger(tx).append([
              {
                companyId: s.company.id,
                actorType: "user",
                actorId: s.ownerId,
                sourceTable: "evaluation_contracts",
                sourceId: `mid-pass:${writes.length}`,
                sourceVersion: "1",
                eventType: "contract.declared",
                eventTime: new Date(),
                payload: { midPass: true },
              },
            ]);
            return "written";
          }),
        );
      },
    });
    const stats = (await ingest.tickAll()).find((x) => x.companyId === s.company.id)!;
    expect(stats).toMatchObject({ passes: 3, caughtUp: true });
    // Two pauses, of the configured length, one between each pair of ticks; each writer got the lock.
    expect(pauses).toEqual([2000, 2000]);
    expect(writes).toEqual(["written", "written"]);
    expect(await runEvents(s.company.id)).toHaveLength(8);
    const midPass = await db
      .select({ id: evaluationEvents.id })
      .from(evaluationEvents)
      .where(and(eq(evaluationEvents.companyId, s.company.id), eq(evaluationEvents.eventType, "contract.declared")));
    expect(midPass).toHaveLength(2);
  });

  it("a source that times out partway through a pass ends it, keeps the committed ticks and backs the company off", async () => {
    const s = await companyWithHistory(8);
    let clock = Date.now();
    let calls = 0;
    const ingest = evaluationIngest(db, {
      rowBudget: 3,
      passYieldMs: 0,
      statementTimeoutMs: 1000,
      now: () => new Date(clock),
      readers: {
        heartbeat_runs: async (tx, companyId, cursor, limit) => {
          // The second tick's read of this company's runs outlasts the statement timeout.
          if (companyId === s.company.id && ++calls === 2) await tx.execute(sql`select pg_sleep(2)`);
          return SOURCE_READERS.heartbeat_runs(tx, companyId, cursor, limit);
        },
      },
    });

    const first = await ingest.tickAll();
    expect(first.find((x) => x.companyId === s.company.id)).toBeUndefined();
    // The first tick committed; the second rolled back whole.
    expect(await runEvents(s.company.id)).toHaveLength(3);
    const backoff = ingest.backoffOf(s.company.id)!;
    expect(backoff).toMatchObject({ failures: 1 });
    expect(backoff.error).toMatch(/statement timeout/);
    expect(backoff.until.getTime() - clock).toBe(5 * 60_000);

    // Within the backoff the schedule leaves the company alone.
    clock += 60_000;
    await ingest.tickAll();
    expect(calls).toBe(2);

    // After it, the pass goes on from the committed cursor and the backoff clears.
    clock = backoff.until.getTime() + 1;
    const resumed = (await ingest.tickAll()).find((x) => x.companyId === s.company.id)!;
    expect(resumed).toMatchObject({ caughtUp: true });
    expect(await runEvents(s.company.id)).toHaveLength(8);
    expect(ingest.backoffOf(s.company.id)).toBeNull();
  });

  it("backs a failing company off exponentially up to an hour, and keeps ingesting the others", async () => {
    const failing = await companyWithHistory(2);
    const healthy = await companyWithHistory(2);
    let clock = Date.now();
    let failingReads = 0;
    const ingest = evaluationIngest(db, {
      passYieldMs: 0,
      now: () => new Date(clock),
      readers: {
        heartbeat_runs: async (tx, companyId, cursor, limit) => {
          if (companyId === failing.company.id) {
            failingReads++;
            throw new Error("source unavailable");
          }
          return SOURCE_READERS.heartbeat_runs(tx, companyId, cursor, limit);
        },
      },
    });

    const first = await ingest.tickAll();
    expect(first.find((x) => x.companyId === healthy.company.id)).toMatchObject({ caughtUp: true });
    expect(await runEvents(healthy.company.id)).toHaveLength(2);

    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      if (i > 0) {
        // Just before the backoff ends: skipped, the source isn't read.
        const reads = failingReads;
        clock = ingest.backoffOf(failing.company.id)!.until.getTime() - 1;
        await ingest.tickAll();
        expect(failingReads).toBe(reads);
        clock += 2;
        await ingest.tickAll();
      }
      const entry = ingest.backoffOf(failing.company.id)!;
      expect(entry.failures).toBe(i + 1);
      delays.push((entry.until.getTime() - clock) / 60_000);
    }
    expect(delays).toEqual([5, 10, 20, 40, 60, 60, 60]);
    expect(await runEvents(failing.company.id)).toHaveLength(0);
  });
});
