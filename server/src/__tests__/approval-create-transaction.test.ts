import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issues,
  workflowEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { setPluginEventBus } from "../services/activity-log.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

function makeBoardActor(companyId: string, userId: string) {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
  };
}

async function createApp(db: TestDb, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", approvalRoutes(db, { autoDispatchQueuedRuns: false }));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("POST /companies/:companyId/approvals atomicity (GH #919)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-tx-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Plugin domain events are captured from the real bus hook; live events from
  // the real company subscription.
  const pluginEvents: Array<{ eventType: string; entityId?: string; companyId?: string }> = [];
  beforeAll(() => {
    setPluginEventBus({
      emit: async (event: { eventType: string; entityId?: string; companyId?: string }) => {
        pluginEvents.push(event);
        return { errors: [] };
      },
    } as unknown as Parameters<typeof setPluginEventBus>[0]);
  });
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function freshCompany(productProfile?: string) {
    return db
      .insert(companies)
      .values({
        name: `ApprovalTx ${randomUUID()}`,
        issuePrefix: `TX${randomUUID().slice(0, 6).toUpperCase()}`,
        ...(productProfile ? { productProfile } : {}),
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("leaves no orphan approval when an issue id fails to link", async () => {
    const company = await freshCompany();
    const app = await createApp(db, makeBoardActor(company.id, "user-1"));

    const res = await request(app)
      .post(`/api/companies/${company.id}/approvals`)
      .send({
        type: "request_board_approval",
        payload: { summary: "Link to a ghost issue" },
        issueIds: [randomUUID()],
      });

    expect(res.status).toBe(404);
    // The whole create must roll back: no approval row, no links, no activity.
    expect(
      await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(eq(approvals.companyId, company.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: issueApprovals.approvalId })
        .from(issueApprovals)
        .where(eq(issueApprovals.companyId, company.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(eq(activityLog.companyId, company.id)),
    ).toEqual([]);
  });

  it("creates approval, links, and activity row together on the happy path", async () => {
    const company = await freshCompany();
    const issue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Real issue", status: "todo" })
      .returning()
      .then((rows) => rows[0]!);
    const app = await createApp(db, makeBoardActor(company.id, "user-1"));

    const res = await request(app)
      .post(`/api/companies/${company.id}/approvals`)
      .send({
        type: "request_board_approval",
        payload: { summary: "Link to a real issue" },
        issueIds: [issue.id],
      });

    expect(res.status).toBe(201);
    const approvalRows = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(eq(approvals.companyId, company.id));
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]!.id).toBe(res.body.id);
    expect(
      await db
        .select({ id: issueApprovals.approvalId })
        .from(issueApprovals)
        .where(eq(issueApprovals.companyId, company.id)),
    ).toHaveLength(1);
    const logged = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.companyId, company.id));
    expect(logged.map((row) => row.action)).toContain("approval.created");
  });

  it("announces nothing when the transaction rolls back after the activity row is written", async () => {
    const company = await freshCompany();
    const issue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Real issue", status: "todo" })
      .returning()
      .then((rows) => rows[0]!);
    // Fail at COMMIT, i.e. after the approval, the link AND the activity row
    // were all written inside the transaction: a deferred constraint trigger
    // on this company's activity rows. Anything published before COMMIT would
    // announce an approval that never existed.
    const fn = `fail_activity_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`
      create function ${fn}() returns trigger language plpgsql as $$
      begin raise exception 'forced commit failure'; end $$;
      create constraint trigger ${fn}_trg after insert on activity_log
        deferrable initially deferred for each row
        when (new.company_id = '${company.id}')
        execute function ${fn}();
    `));
    cleanups.push(async () => {
      await db.execute(sql.raw(`drop trigger if exists ${fn}_trg on activity_log; drop function if exists ${fn}();`));
    });
    const live: Array<{ type: string; payload: Record<string, unknown> }> = [];
    cleanups.push(subscribeCompanyLiveEvents(company.id, (event) => {
      live.push(event as unknown as { type: string; payload: Record<string, unknown> });
    }));
    const pluginBefore = pluginEvents.length;
    const app = await createApp(db, makeBoardActor(company.id, "user-1"));

    const res = await request(app)
      .post(`/api/companies/${company.id}/approvals`)
      .send({
        type: "request_board_approval",
        payload: { summary: "Commit will fail" },
        issueIds: [issue.id],
      });

    expect(res.status).toBe(500);
    expect(
      await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.companyId, company.id)),
    ).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(live.filter((event) => event.type === "activity.logged")).toEqual([]);
    expect(
      pluginEvents.slice(pluginBefore).filter((event) => event.companyId === company.id),
    ).toEqual([]);
  });

  it("publishes approval.created only after COMMIT — a listener reading the approval back finds it", async () => {
    const company = await freshCompany();
    // What live-event visibility (GH #933 / PR #1037) does on an approval
    // activity: resolve the approval row on another pool connection. Issued
    // synchronously from the listener, it only sees the row if COMMIT already
    // happened.
    const lookups: Array<Promise<Array<{ id: string }>>> = [];
    cleanups.push(subscribeCompanyLiveEvents(company.id, (event) => {
      const payload = (event as unknown as { payload: { action?: string; entityId?: string } }).payload;
      if (payload.action === "approval.created" && payload.entityId) {
        lookups.push(
          // `.then` starts the query now — a bare drizzle builder is lazy.
          db.select({ id: approvals.id }).from(approvals).where(eq(approvals.id, payload.entityId)).then((rows) => rows),
        );
      }
    }));
    // The ordering itself, deterministically: note when the route's
    // db.transaction resolves (COMMIT done) and when the event is published.
    const order: string[] = [];
    const trackedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (...args: Parameters<TestDb["transaction"]>) => {
            const result = await target.transaction(...args);
            order.push("commit");
            return result;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as TestDb;
    cleanups.push(subscribeCompanyLiveEvents(company.id, (event) => {
      const payload = (event as unknown as { payload: { action?: string } }).payload;
      if (payload.action === "approval.created") order.push("publish");
    }));
    const pluginBefore = pluginEvents.length;
    const app = await createApp(trackedDb, makeBoardActor(company.id, "user-1"));

    const res = await request(app)
      .post(`/api/companies/${company.id}/approvals`)
      .send({ type: "request_board_approval", payload: { summary: "Committed first" } });

    expect(res.status).toBe(201);
    expect(order.indexOf("publish")).toBeGreaterThan(-1);
    expect(order.indexOf("commit")).toBeGreaterThan(-1);
    expect(order.indexOf("commit")).toBeLessThan(order.indexOf("publish"));
    expect(lookups).toHaveLength(1);
    expect(await lookups[0]!).toEqual([{ id: res.body.id }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      pluginEvents
        .slice(pluginBefore)
        .filter((event) => event.companyId === company.id)
        .map((event) => [event.eventType, event.entityId]),
    ).toEqual([["approval.created", res.body.id]]);
  });

  it("a failed workflow-metrics write cannot abort the create transaction", async () => {
    // Measurement only runs for agentdash_mk companies; make its insert fail
    // for this company and nothing else.
    const company = await freshCompany("agentdash_mk");
    const issue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Real issue", status: "todo" })
      .returning()
      .then((rows) => rows[0]!);
    const constraint = `wf_block_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db.execute(sql.raw(
      `alter table workflow_events add constraint ${constraint} check (company_id <> '${company.id}') not valid`,
    ));
    cleanups.push(async () => {
      await db.execute(sql.raw(`alter table workflow_events drop constraint if exists ${constraint}`));
    });
    const app = await createApp(db, makeBoardActor(company.id, "user-1"));

    const res = await request(app)
      .post(`/api/companies/${company.id}/approvals`)
      .send({
        type: "request_board_approval",
        payload: { summary: "Metrics write will fail" },
        issueIds: [issue.id],
      });

    expect(res.status).toBe(201);
    expect(
      await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.companyId, company.id)),
    ).toHaveLength(1);
    expect(
      await db.select({ id: issueApprovals.approvalId }).from(issueApprovals).where(eq(issueApprovals.companyId, company.id)),
    ).toHaveLength(1);
    expect(
      (await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.companyId, company.id)))
        .map((row) => row.action),
    ).toContain("approval.created");
    expect(
      await db.select({ id: workflowEvents.id }).from(workflowEvents).where(eq(workflowEvents.companyId, company.id)),
    ).toEqual([]);
  });
});
