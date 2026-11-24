import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Retired issue origin on issue create", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OTHER_COMPANY = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execos-origin-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: COMPANY, name: "ExecOS Co", issuePrefix: "EXO" },
      { id: OTHER_COMPANY, name: "Other Co", issuePrefix: "OTH" },
    ]);
    for (const companyId of [COMPANY, OTHER_COMPANY]) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "owner",
        status: "active",
        membershipRole: "owner",
      });
    }
    await db.insert(companyMemberships).values({
      companyId: COMPANY,
      principalType: "user",
      principalId: "member",
      status: "active",
      membershipRole: "member",
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(
    companyId: string,
    source: "session" | "assistant_grant" = "session",
    role: "owner" | "member" = "owner",
  ) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source,
        ...(source === "assistant_grant" ? { assistantGrantId: "grant-1" } : {}),
        userId: role,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: role, status: "active" }],
      };
      next();
    });
    server.use("/api", issueRoutes(db, {} as never));
    server.use(errorHandler);
    return server;
  }

  const create = (companyId: string, body: Record<string, unknown>) =>
    request(app(companyId)).post(`/api/companies/${companyId}/issues`).send(body);

  it("returns 410 for a new origin without allocating an issue", async () => {
    const originId = randomUUID();
    const counter = () => db.select({ value: companies.issueCounter }).from(companies).where(eq(companies.id, COMPANY));
    const before = await counter();
    const res = await create(COMPANY, { title: "Fresh request", originKind: "execos_request", originId });
    expect(res.status).toBe(410);
    expect(res.body.details).toEqual({ code: "EXECOS_REQUEST_RETIRED" });
    expect(await counter()).toEqual(before);
    expect(await db.select().from(issues).where(eq(issues.originId, originId))).toHaveLength(0);
  });

  it("preserves the conflict for a visible historical issue", async () => {
    const originId = randomUUID();
    await db.insert(issues).values({ companyId: COMPANY, title: "Original", originKind: "execos_request", originId });
    const res = await create(COMPANY, { title: "Retry", originKind: "execos_request", originId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ExecOS request is already recorded");
    expect(res.body.details).toEqual({ code: "EXECOS_REQUEST_ALREADY_RECORDED", originId });
    const found = await request(app(COMPANY))
      .get(`/api/companies/${COMPANY}/issues`)
      .query({ originKind: "execos_request", originId });
    expect(found.status).toBe(200);
    expect(found.body).toEqual([expect.objectContaining({ title: "Original", originId })]);
  });

  it("gives the same response for unknown, hidden, restricted and other-company origins", async () => {
    const hidden = randomUUID();
    const restricted = randomUUID();
    const other = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId, companyId: COMPANY, name: "Restricted", visibility: "restricted", createdByUserId: "other",
    });
    await db.insert(issues).values([
      { companyId: COMPANY, title: "Hidden", originKind: "execos_request", originId: hidden, hiddenAt: new Date() },
      { companyId: COMPANY, title: "Restricted", originKind: "execos_request", originId: restricted, projectId },
      { companyId: OTHER_COMPANY, title: "Other", originKind: "execos_request", originId: other },
    ]);
    const retry = (originId: string) => request(app(COMPANY, "session", "member"))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Retry", originKind: "execos_request", originId });
    const unknown = await retry(randomUUID());
    expect(unknown.status).toBe(410);
    for (const originId of [hidden, restricted, other]) {
      const res = await retry(originId);
      expect(res.status).toBe(410);
      expect(res.body).toEqual(unknown.body);
    }
  });

  it("requires both halves of the origin", async () => {
    const kindOnly = await create(COMPANY, { title: "Kind only", originKind: "execos_request" });
    expect(kindOnly.status).toBe(400);
    const idOnly = await create(COMPANY, { title: "Id only", originId: `req_${randomUUID()}` });
    expect(idOnly.status).toBe(400);
    const forged = await create(COMPANY, { title: "Forged", originKind: "routine_execution", originId: "r-1" });
    expect(forged.status).toBe(400);
  });

  // The loopback middleware's body allowlist normally refuses these fields
  // first (see assistant-work-tools.test.ts); this pins the route's own guard.
  it("refuses an ExecOS origin on an assistant-grant write instead of overwriting it", async () => {
    const originId = `req_${randomUUID()}`;
    const res = await request(app(COMPANY, "assistant_grant"))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Assistant with ExecOS origin", originKind: "execos_request", originId });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("originKind/originId are not accepted on assistant-grant writes");
    const rows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, COMPANY), eq(issues.originId, originId)));
    expect(rows).toHaveLength(0);
  });

  it("leaves issues without an ExecOS origin unaffected", async () => {
    const first = await create(COMPANY, { title: "Same title" });
    const second = await create(COMPANY, { title: "Same title" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.originKind).toBe("manual");
    expect(second.body.id).not.toBe(first.body.id);

    // Other origin kinds that share (company, kind, id) are not constrained by
    // the ExecOS index.
    const manualOrigin = randomUUID();
    await db.insert(issues).values([
      { companyId: COMPANY, title: "Manual 1", originKind: "manual", originId: manualOrigin },
      { companyId: COMPANY, title: "Manual 2", originKind: "manual", originId: manualOrigin },
    ]);
    const manualRows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, COMPANY), eq(issues.originId, manualOrigin)));
    expect(manualRows).toHaveLength(2);
  });
});
