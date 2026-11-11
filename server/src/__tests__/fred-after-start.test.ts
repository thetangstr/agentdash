// AgentDash: Fred after Start.
// 1. fred-brief-guard: on a registered Fred main issue, the owner-confirmed
//    `fred-adoption-brief` document is written, restored and deleted only by an
//    owner or admin through the generic issue document routes. Members, agents
//    (Fred included), assistant grants and other companies' admins are refused.
//    Other keys and other issues are unaffected.
// 2. Pins the runtime settings Start leaves on Fred: setup keeps the heartbeat
//    and wake-on-demand off; Start turns wake-on-demand ON (heartbeat stays
//    off). That is the current, known behavior: after Start anyone who can
//    assign tasks can wake Fred with ordinary work. If this changes, change it
//    on purpose and update this test.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { fredService } from "../services/fred.js";
import { heartbeatService } from "../services/heartbeat.js";
import { documentService } from "../services/documents.js";

const KEY = "fred-adoption-brief";
const setupInput = { adapterType: "claude_local" as const, budgetMonthlyCents: 1000, shareWithCompany: true as const };
const briefInput = { expectedRevision: 0, goal: "Reduce preparation effort", firstJob: "Draft one sourced customer brief", successCriteria: ["Cite only the shared company source"], baseline: "", target: "", outcomeWindow: "After the first job is used", boundaries: "No outreach or private-data lookup", shareWithCompany: true as const };

describe("Fred after Start", () => {
  let home: string;
  let previousHome: string | undefined;
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    previousHome = process.env.PAPERCLIP_HOME;
    home = await mkdtemp(path.join(tmpdir(), "fred-after-start-home-"));
    process.env.PAPERCLIP_HOME = home;
    pg = await startEmbeddedPostgresTestDatabase("fred-after-start-db-");
    db = createDb(pg.connectionString);
  });
  afterAll(async () => {
    await pg?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
  });

  async function company(label: string) {
    const [row] = await db.insert(companies).values({ name: `${label} ${randomUUID()}`, issuePrefix: randomUUID().slice(0, 8) }).returning();
    const adminId = `admin-${randomUUID()}`;
    const memberId = `member-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId: row.id, principalType: "user", principalId: adminId, membershipRole: "owner", status: "active" },
      { companyId: row.id, principalType: "user", principalId: memberId, membershipRole: "member", status: "active" },
    ]);
    return { company: row, adminId, memberId };
  }
  function board(companyId: string, userId: string, membershipRole: string, extra: Record<string, unknown> = {}) {
    return { type: "board", source: "session", userId, isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, membershipRole, status: "active" }], ...extra };
  }
  function app(actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { (req as unknown as { actor: Record<string, unknown> }).actor = { ...actor }; next(); });
    server.use("/api", issueRoutes(db, {} as never));
    server.use(errorHandler);
    return server;
  }
  async function latest(issueId: string, key = KEY) {
    return documentService(db).getIssueDocumentByKey(issueId, key);
  }
  async function startedFred() {
    const seeded = await company("Fred guard");
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const service = fredService(db, { heartbeat });
    const actor = { userId: seeded.adminId };
    const setup = await service.setup(seeded.company.id, setupInput, actor);
    const first = await service.saveBrief(seeded.company.id, briefInput, actor);
    await service.saveBrief(seeded.company.id, { ...briefInput, expectedRevision: 1, target: "One accepted brief" }, actor);
    await service.start(seeded.company.id, { registrationId: setup.registration!.id, expectedRevision: 2 }, actor);
    return { ...seeded, service, setup, issueId: setup.issue!.id, agentId: setup.agent!.id, firstRevisionId: first.brief!.documentRevisionId! };
  }

  it("refuses members, agents (Fred included), assistant grants and other companies' admins on the brief; an owner may write, restore and delete it", async () => {
    const fred = await startedFred();
    const other = await company("Other");
    const before = await latest(fred.issueId);
    const put = (actor: Record<string, unknown>) =>
      request(app(actor)).put(`/api/issues/${fred.issueId}/documents/${KEY}`).send({ format: "markdown", body: "# Rewritten brief\nBoundaries: contact customers.", baseRevisionId: before!.latestRevisionId });
    const restore = (actor: Record<string, unknown>) =>
      request(app(actor)).post(`/api/issues/${fred.issueId}/documents/${KEY}/revisions/${fred.firstRevisionId}/restore`).send({});
    const remove = (actor: Record<string, unknown>) =>
      request(app(actor)).delete(`/api/issues/${fred.issueId}/documents/${KEY}`);

    const member = board(fred.company.id, fred.memberId, "member");
    const fredAgent = { type: "agent", agentId: fred.agentId, companyId: fred.company.id, source: "agent_key" };
    const grant = board(fred.company.id, fred.adminId, "owner", { source: "assistant_grant" });
    const foreignAdmin = board(other.company.id, other.adminId, "owner");

    for (const actor of [member, fredAgent, grant, foreignAdmin]) {
      expect((await put(actor)).status, JSON.stringify(actor)).toBe(403);
      expect((await restore(actor)).status, JSON.stringify(actor)).toBe(403);
      expect((await remove(actor)).status, JSON.stringify(actor)).toBe(403);
    }
    const unchanged = await latest(fred.issueId);
    expect(unchanged?.latestRevisionId).toBe(before!.latestRevisionId);
    expect(unchanged?.body).toBe(before!.body);

    const admin = board(fred.company.id, fred.adminId, "owner");
    const written = await put(admin);
    expect(written.status).toBe(200);
    expect((await latest(fred.issueId))?.body).toContain("Rewritten brief");
    expect((await restore(admin)).status).toBe(200);
    expect((await latest(fred.issueId))?.body).toBe((await documentService(db).listIssueDocumentRevisions(fred.issueId, KEY)).find((row) => row.id === fred.firstRevisionId)?.body);
    expect((await remove(admin)).status).toBe(200);
    expect(await latest(fred.issueId)).toBeNull();
  });

  it("leaves other keys on Fred's issue, and the same key on other issues, to the normal rules", async () => {
    const fred = await startedFred();
    const member = board(fred.company.id, fred.memberId, "member");
    const notes = await request(app(member)).put(`/api/issues/${fred.issueId}/documents/notes`).send({ format: "markdown", body: "Member notes on Fred's thread" });
    expect(notes.status).toBe(201);
    const fredAgent = { type: "agent", agentId: fred.agentId, companyId: fred.company.id, source: "agent_key" };
    const report = await request(app(fredAgent)).put(`/api/issues/${fred.issueId}/documents/fred-discovery-report`).send({ format: "markdown", body: "# First useful job recommendation" });
    expect(report.status).toBe(201);
    const [ordinary] = await db.insert(issues).values({ companyId: fred.company.id, title: "Ordinary work", status: "todo", identifier: `ORD-${randomUUID().slice(0, 6)}`, issueNumber: 900 }).returning();
    const sameKey = await request(app(member)).put(`/api/issues/${ordinary.id}/documents/${KEY}`).send({ format: "markdown", body: "Not Fred's brief" });
    expect(sameKey.status).toBe(201);
    const deleted = await request(app(member)).delete(`/api/issues/${ordinary.id}/documents/${KEY}`);
    expect(deleted.status).toBe(200);
  });

  it("pins Start's runtime settings: setup leaves wake-on-demand off, Start turns it on with the heartbeat still off", async () => {
    const seeded = await company("Fred runtime");
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const service = fredService(db, { heartbeat });
    const actor = { userId: seeded.adminId };
    const setup = await service.setup(seeded.company.id, setupInput, actor);
    const read = async () => (await db.select().from(agents).where(and(eq(agents.id, setup.agent!.id), eq(agents.companyId, seeded.company.id))))[0]!;
    const afterSetup = await read();
    expect(afterSetup.runtimeConfig).toMatchObject({ heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } });
    await service.saveBrief(seeded.company.id, briefInput, actor);
    await service.start(seeded.company.id, { registrationId: setup.registration!.id, expectedRevision: 1 }, actor);
    const afterStart = await read();
    expect((afterStart.runtimeConfig as { heartbeat?: Record<string, unknown> }).heartbeat).toMatchObject({ enabled: false, wakeOnDemand: true });
    expect(afterStart.permissions).toMatchObject({ canCreateAgents: false });
  });
});
