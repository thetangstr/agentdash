import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";

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

  async function freshCompany() {
    return db
      .insert(companies)
      .values({
        name: `ApprovalTx ${randomUUID()}`,
        issuePrefix: `TX${randomUUID().slice(0, 6).toUpperCase()}`,
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
});
