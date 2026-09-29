import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: ExecOS request identity. One normalized ExecOS request is one
 * issue per company. The pair (originKind "execos_request", originId) must be
 * sent together, and a duplicate is an explicit 409 translated from the
 * issues_execos_request_origin_uq partial unique index.
 */
describeEmbeddedPostgres("ExecOS request origin on issue create", () => {
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
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: "owner",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      };
      next();
    });
    server.use("/api", issueRoutes(db, {} as never));
    server.use(errorHandler);
    return server;
  }

  const create = (companyId: string, body: Record<string, unknown>) =>
    request(app(companyId)).post(`/api/companies/${companyId}/issues`).send(body);

  it("records the origin and refuses a duplicate request with 409", async () => {
    const originId = `req_${randomUUID()}`;
    const first = await create(COMPANY, { title: "ExecOS proof", originKind: "execos_request", originId });
    expect(first.status).toBe(201);
    expect(first.body.originKind).toBe("execos_request");
    expect(first.body.originId).toBe(originId);

    const second = await create(COMPANY, { title: "ExecOS proof retry", originKind: "execos_request", originId });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("ExecOS request is already recorded");
    expect(second.body.details).toMatchObject({ code: "EXECOS_REQUEST_ALREADY_RECORDED", originId });

    const rows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, COMPANY), eq(issues.originId, originId)));
    expect(rows).toHaveLength(1);
  });

  it("scopes the key to the company", async () => {
    const originId = `req_${randomUUID()}`;
    expect((await create(COMPANY, { title: "A", originKind: "execos_request", originId })).status).toBe(201);
    expect((await create(OTHER_COMPANY, { title: "B", originKind: "execos_request", originId })).status).toBe(201);
  });

  it("requires both halves of the origin", async () => {
    const kindOnly = await create(COMPANY, { title: "Kind only", originKind: "execos_request" });
    expect(kindOnly.status).toBe(400);
    const idOnly = await create(COMPANY, { title: "Id only", originId: `req_${randomUUID()}` });
    expect(idOnly.status).toBe(400);
    const forged = await create(COMPANY, { title: "Forged", originKind: "routine_execution", originId: "r-1" });
    expect(forged.status).toBe(400);
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
