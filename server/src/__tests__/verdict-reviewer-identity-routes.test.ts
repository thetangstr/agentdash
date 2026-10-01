import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { verdictRoutes } from "../routes/verdicts.js";
import { errorHandler } from "../middleware/index.js";

// AgentDash (#859 split, #881 review P3): HTTP verdicts carry the
// authenticated reviewer. A body reviewer id that names someone else is
// impersonation (403); null and undefined both mean "not provided".
describe("verdict reviewer identity over HTTP", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("verdict-reviewer-identity-");
    db = createDb(temp.connectionString);
  });
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Verdict identity", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [reviewer, other] = await db.insert(agents).values([
      { companyId: company.id, name: "Reviewer" },
      { companyId: company.id, name: "Someone else" },
    ]).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Reviewed work", status: "in_review" }).returning();
    return { company, reviewer, other, issue, url: `/api/companies/${company.id}/verdicts` };
  }
  function app(actor: Record<string, unknown>) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    result.use("/api", verdictRoutes(db));
    result.use(errorHandler);
    return result;
  }

  it("refuses a body reviewer id that names someone other than the caller", async () => {
    const f = await fixture();
    const agentApp = app({ type: "agent", agentId: f.reviewer.id, companyId: f.company.id, source: "agent_key" });
    const res = await request(agentApp).post(f.url)
      .send({ entityType: "issue", issueId: f.issue.id, outcome: "passed", reviewerAgentId: f.other.id });
    expect(res.status).toBe(403);
    const asUser = await request(agentApp).post(f.url)
      .send({ entityType: "issue", issueId: f.issue.id, outcome: "passed", reviewerUserId: "someone" });
    expect(asUser.status).toBe(403);
  });

  it("treats explicit null reviewer ids like omitted ones", async () => {
    const f = await fixture();
    const agentApp = app({ type: "agent", agentId: f.reviewer.id, companyId: f.company.id, source: "agent_key" });
    const res = await request(agentApp).post(f.url)
      .send({ entityType: "issue", issueId: f.issue.id, outcome: "passed", reviewerAgentId: null, reviewerUserId: null });
    expect(res.status, JSON.stringify(res.body)).not.toBe(403);
    const boardApp = app({ type: "board", userId: "board-user", companyIds: [f.company.id], source: "local_implicit", isInstanceAdmin: false });
    const board = await request(boardApp).post(f.url)
      .send({ entityType: "issue", issueId: f.issue.id, outcome: "passed", reviewerAgentId: null, reviewerUserId: null });
    expect(board.status, JSON.stringify(board.body)).not.toBe(403);
  });
});
