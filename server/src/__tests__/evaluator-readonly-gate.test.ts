import { createHash, randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agentApiKeys, agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";

// AgentDash: Company Evaluator — Milestone 3, decision D11 / spec §10.2.
// The evaluator's prohibition is a property of the system: an API key whose
// `principal_kind` is `evaluator` mints a read-only actor, and any non-safe
// request from it is refused before a router sees it unless the path is on
// the evaluator write allowlist. Every refusal leaves an `authz.refused` row.
// An ordinary agent key is untouched.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("evaluator read-only gate (embedded postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let evaluatorToken!: string;
  let ordinaryToken!: string;
  let app!: express.Express;
  const reached: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evaluator-gate-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Gate Co", issuePrefix: "GTE" }).returning();
    companyId = company!.id;
    const [evaluator] = await db.insert(agents).values({ companyId, name: "Evaluator", role: "evaluator", status: "idle" }).returning();
    const [worker] = await db.insert(agents).values({ companyId, name: "Worker", role: "engineer", status: "idle" }).returning();
    const mint = async (agentId: string, principalKind: string | null) => {
      const token = randomBytes(24).toString("hex");
      await db.insert(agentApiKeys).values({ agentId, companyId, name: "test", keyHash: createHash("sha256").update(token).digest("hex"), principalKind });
      return token;
    };
    evaluatorToken = await mint(evaluator!.id, "evaluator");
    ordinaryToken = await mint(worker!.id, null);
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    const record = (label: string) => (req: express.Request, res: express.Response) => {
      reached.push(label);
      res.json({ ok: true, actor: { type: req.actor.type, readOnly: req.actor.readOnly ?? false, principalKind: req.actor.principalKind ?? null } });
    };
    app.get("/api/companies/:companyId/issues", record("get-issues"));
    app.post("/api/companies/:companyId/issues", record("post-issues"));
    app.post("/api/companies/:companyId/verdicts", record("post-verdicts"));
    app.patch("/api/issues/:id", record("patch-issue"));
    app.delete("/api/agents/:id", record("delete-agent"));
    app.post("/api/companies/:companyId/evaluation/findings", record("post-findings"));
    app.post("/api/companies/:companyId/evaluation/review-items", record("post-review-items"));
    app.post("/api/companies/:companyId/evaluation/scorecards/snapshot", record("post-snapshot"));
    app.post("/api/companies/:companyId/evaluation/corrections/abc/note", record("post-correction-note"));
    app.post("/api/companies/:companyId/evaluation/ingest/run", record("post-ingest-run"));
    app.post("/api/companies/:companyId/evaluation/contracts", record("post-contracts"));
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const asEvaluator = (r: request.Test) => r.set("Authorization", `Bearer ${evaluatorToken}`);
  const asWorker = (r: request.Test) => r.set("x-agent-key", ordinaryToken);

  it("mints a read-only evaluator actor and lets its reads through", async () => {
    const res = await asEvaluator(request(app).get(`/api/companies/${companyId}/issues`));
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ type: "agent", readOnly: true, principalKind: "evaluator" });
  });

  it("refuses every non-allowlisted non-safe request from the evaluator before any router runs, and records each refusal", async () => {
    reached.length = 0;
    const attempts: Array<[string, request.Test]> = [
      ["post-issues", request(app).post(`/api/companies/${companyId}/issues`).send({ title: "x" })],
      ["post-verdicts", request(app).post(`/api/companies/${companyId}/verdicts`).send({})],
      ["patch-issue", request(app).patch("/api/issues/00000000-0000-4000-8000-000000000001").send({ status: "done" })],
      ["delete-agent", request(app).delete("/api/agents/00000000-0000-4000-8000-000000000002")],
      ["post-ingest-run", request(app).post(`/api/companies/${companyId}/evaluation/ingest/run`)],
      ["post-contracts", request(app).post(`/api/companies/${companyId}/evaluation/contracts`).send({})],
    ];
    for (const [label, req] of attempts) {
      const res = await asEvaluator(req);
      expect(res.status, label).toBe(403);
      expect(res.body.code, label).toBe("EVALUATOR_READ_ONLY");
    }
    expect(reached).toEqual([]);
    // fire-and-forget: give the inserts a moment
    await new Promise((r) => setTimeout(r, 200));
    const rows = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "authz.refused")));
    expect(rows.length).toBe(attempts.length);
    expect(rows.every((r) => (r.details as { reasonCode?: string }).reasonCode === "EVALUATOR_READ_ONLY" && r.actorType === "agent")).toBe(true);
    const paths = rows.map((r) => (r.details as { routePath: string }).routePath).sort();
    expect(paths).toContain(`/api/companies/${companyId}/evaluation/ingest/run`);
    expect(rows.some((r) => JSON.stringify(r.details).includes('"title"'))).toBe(false); // never the body
  });

  it("lets the evaluator reach exactly its own allowlisted write routes", async () => {
    reached.length = 0;
    for (const path of [`evaluation/findings`, `evaluation/review-items`, `evaluation/scorecards/snapshot`, `evaluation/corrections/abc/note`]) {
      const res = await asEvaluator(request(app).post(`/api/companies/${companyId}/${path}`).send({}));
      expect(res.status, path).toBe(200);
    }
    expect(reached.sort()).toEqual(["post-correction-note", "post-findings", "post-review-items", "post-snapshot"]);
  });

  it("changes nothing for an ordinary agent key", async () => {
    reached.length = 0;
    const res = await asWorker(request(app).post(`/api/companies/${companyId}/issues`).send({ title: "x" }));
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ type: "agent", readOnly: false, principalKind: "agent" });
    expect(reached).toEqual(["post-issues"]);
  });
});
