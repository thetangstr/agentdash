import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, companies, companyMemberships, createDb, issueApprovals, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { approvalRoutes } from "../routes/approvals.js";
import { issueRoutes } from "../routes/issues.js";
import { companyRoutes } from "../routes/companies.js";
import { agentdashMkInboxRoutes } from "../routes/agentdash-mk-inbox.js";
import { errorHandler } from "../middleware/index.js";
vi.mock("../services/issue-current-authority.js", async (original) => ({
  ...(await original<typeof import("../services/issue-current-authority.js")>()), issueCurrentAuthority: () => undefined,
}));
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("budget approval spend visibility", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const payload = { scopeType: "company", scopeName: "Synthetic workspace", budgetAmount: 876543, observedAmount: 987654, guidance: "Ask an administrator to resolve the budget stop" };
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("budget-approval-spend-"); db = createDb(database.connectionString); });
  afterAll(async () => { await database?.cleanup(); });
  async function seed(profile: "default" | "agentdash_mk" = "default") {
    const companyId = randomUUID(), approvalId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic", issuePrefix: `T${randomUUID().slice(0, 7)}`, productProfile: profile, budgetMonthlyCents: 876543 });
    await db.insert(companyMemberships).values(["member", "admin"].map(role => ({ companyId, principalType: "user", principalId: role, membershipRole: role, status: "active" })));
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Budget stop" });
    await db.insert(approvals).values({ id: approvalId, companyId, type: "budget_override_required", requestedByUserId: "member", payload: { ...payload, scopeId: companyId } });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });
    return { companyId, approvalId, issueId, agentId };
  }
  function appAs(companyId: string, role = "member", agentId?: string) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = agentId ? { type: "agent", agentId, companyId, source: "agent_key" } : { type: "board", source: "session", userId: role, companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }] }; next();
    });
    app.use("/api", approvalRoutes(db, { autoDispatchQueuedRuns: false }));
    app.use("/api", issueRoutes(db)); app.use("/api", agentdashMkInboxRoutes(db));
    app.use("/api/companies", companyRoutes(db)); app.use(errorHandler); return app;
  }
  function hidden(value: { payload: Record<string, unknown> }) {
    expect(value.payload.budgetAmount == null).toBe(true);
    expect(value.payload.observedAmount == null).toBe(true);
    expect(value.payload.scopeName).toBe(payload.scopeName);
    expect(value.payload.guidance).toBe(payload.guidance);
  }
  for (const surface of ["detail", "list", "linked-get", "linked-post", "inbox"] as const) {
    it(`${surface} hides amounts from a plain member and preserves stored values`, async () => {
      const { companyId, approvalId, issueId } = await seed(surface === "inbox" ? "agentdash_mk" : "default");
      const app = appAs(companyId);
      const res = surface === "linked-post" ? await request(app).post(`/api/issues/${issueId}/approvals`).send({ approvalId })
        : await request(app).get(surface === "detail" ? `/api/approvals/${approvalId}` : surface === "list" ? `/api/companies/${companyId}/approvals` : surface === "linked-get" ? `/api/issues/${issueId}/approvals` : `/api/companies/${companyId}/me/inbox`);
      expect(res.status, JSON.stringify(res.body)).toBe(surface === "linked-post" ? 201 : 200);
      hidden(surface === "detail" ? res.body : surface === "inbox" ? res.body.items[0] : res.body[0]);
      const [stored] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
      expect(stored.payload.budgetAmount).toBe(876543); expect(stored.payload.observedAmount).toBe(987654);
    });
  }
  for (const decision of ["approve", "reject", "request-revision", "resubmit"] as const) {
    it(`${decision} response does not disclose stored budget amounts`, async () => {
      const { companyId, approvalId } = await seed();
      if (decision === "resubmit") await db.update(approvals).set({ status: "revision_requested" }).where(eq(approvals.id, approvalId));
      const res = await request(appAs(companyId)).post(`/api/approvals/${approvalId}/${decision}`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200); hidden(res.body);
    });
  }
  it("creation responses redact amounts without changing the submitted budget context", async () => {
    const { companyId } = await seed();
    const res = await request(appAs(companyId)).post(`/api/companies/${companyId}/approvals`).send({ type: "budget_override_required", payload });
    expect(res.status, JSON.stringify(res.body)).toBe(201); hidden(res.body);
    const [stored] = await db.select().from(approvals).where(eq(approvals.id, res.body.id));
    expect(stored.payload.observedAmount).toBe(987654);
  });
  it("an authorized override response retains actual budget amounts", async () => {
    const { companyId, approvalId } = await seed("agentdash_mk");
    const res = await request(appAs(companyId, "admin")).post(`/api/approvals/${approvalId}/override`).send({ decision: "rejected", overrideReason: "Synthetic control", channel: "web", revision: 1, idempotencyKey: randomUUID() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.payload.budgetAmount).toBe(876543);
  });
  it("preserves permitted admin and agent values and keeps the override inbox admin-only", async () => {
    const { companyId, approvalId, issueId, agentId } = await seed("agentdash_mk");
    for (const app of [appAs(companyId, "admin"), appAs(companyId, "member", agentId)]) {
      for (const url of [`/api/approvals/${approvalId}`, `/api/companies/${companyId}/approvals`, `/api/issues/${issueId}/approvals`]) {
        const res = await request(app).get(url); expect(res.status).toBe(200);
        expect((Array.isArray(res.body) ? res.body[0] : res.body).payload.budgetAmount).toBe(876543);
      }
    }
    expect((await request(appAs(companyId)).get(`/api/companies/${companyId}/inbox/override`)).status).toBe(403);
    const inbox = await request(appAs(companyId, "admin")).get(`/api/companies/${companyId}/inbox/override`);
    expect(inbox.status).toBe(200); expect(inbox.body.items[0].payload.observedAmount).toBe(987654);
  });
  it("does not redact similarly named fields in unrelated approval prose", async () => {
    const { companyId, approvalId } = await seed();
    await db.update(approvals).set({ type: "request_board_approval" }).where(eq(approvals.id, approvalId));
    const res = await request(appAs(companyId)).get(`/api/approvals/${approvalId}`);
    expect(res.status).toBe(200); expect(res.body.payload.budgetAmount).toBe(876543);
  });
  for (const mutation of ["patch", "branding", "archive"] as const) {
    it(`company ${mutation} does not bypass spend reads or change member action authority`, async () => {
      const { companyId } = await seed(); const app = appAs(companyId);
      const res = mutation === "archive" ? await request(app).post(`/api/companies/${companyId}/archive`)
        : await request(app).patch(`/api/companies/${companyId}${mutation === "branding" ? "/branding" : ""}`).send({ name: "Renamed" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.budgetMonthlyCents).toBeNull(); expect(res.body.spentMonthlyCents).toBeNull();
      const [stored] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(stored.budgetMonthlyCents).toBe(876543);
      expect(mutation === "archive" ? stored.status : stored.name).toBe(mutation === "archive" ? "archived" : "Renamed");
    });
  }
});
