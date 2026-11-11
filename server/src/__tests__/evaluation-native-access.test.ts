import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, createDb, documentRevisions, evaluationEvents, issues, projectAccess, projects } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { evaluationRoutes } from "../routes/evaluation.js";
import { documentService } from "../services/documents.js";
import { evaluationIngest } from "../services/evaluation/ingest.js";
import { evaluationLedger } from "../services/evaluation/ledger.js";
import { addAgent, addCompany, addUser, boardActor, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
const nativeTypes = "issue.document_revision,issue.document_removed";

describeDatabase("native receipt current authority on raw evaluation routes", () => {
  let db: TestDb;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("native-receipt-access-"); db = createDb(temp.connectionString); }, 120_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture() {
    const companyId = (await addCompany(db, "Native receipt access", "default")).id;
    const ownerId = await addUser(db, companyId, "owner");
    const memberId = await addUser(db, companyId, "member");
    const insiderId = await addUser(db, companyId, "member");
    const worker = await addAgent(db, companyId, { name: "Native receipt writer" });
    const [open] = await db.insert(projects).values({ companyId, name: "Public source" }).returning();
    const [restricted] = await db.insert(projects).values({ companyId, name: "Current private source", visibility: "restricted", createdByUserId: ownerId }).returning();
    await db.insert(projectAccess).values({ projectId: restricted!.id, principalType: "user", principalId: insiderId, grantedByUserId: ownerId });
    const actors = { owner: boardActor(companyId, ownerId, "owner"), member: boardActor(companyId, memberId), insider: boardActor(companyId, insiderId) };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { ...actors[(req.header("x-test-actor") ?? "member") as keyof typeof actors] }; next(); });
    app.use("/api", evaluationRoutes(db));
    app.use(errorHandler);
    const base = `/api/companies/${companyId}/evaluation`;
    const get = (path: string, actor: keyof typeof actors = "member") => request(app).get(`${base}${path}`).set("x-test-actor", actor);
    async function issue(title: string, parentId: string | null = null) {
      return (await db.insert(issues).values({ companyId, title, projectId: parentId ? null : open!.id, parentId, assigneeAgentId: worker.id }).returning())[0]!;
    }
    async function document(issueId: string, secondsAgo: number) {
      const result = await documentService(db).upsertIssueDocument({ issueId, key: "result", format: "markdown", body: `Exact native output for ${issueId}`, createdByAgentId: worker.id });
      await db.update(documentRevisions).set({ createdAt: new Date(Date.now() - secondsAgo * 1000) }).where(eq(documentRevisions.id, result.document.latestRevisionId!));
      return result.document;
    }
    const ingest = () => evaluationIngest(db, { sources: ["document_revisions"] }).tick(companyId);
    const nativeRows = () => db.select().from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId));
    return { companyId, workerId: worker.id, openId: open!.id, restrictedId: restricted!.id, get, issue, document, ingest, nativeRows };
  }

  it.each([false, true])("narrows receipts before pagination and counts after a scope move (inherited=%s)", async (inherited) => {
    const f = await fixture();
    const older = await f.issue("Older visible output");
    await f.document(older.id, 20);
    const parent = inherited ? await f.issue("Parent whose scope changes") : null;
    const moved = await f.issue("Output moved after ingest", parent?.id);
    const removed = await f.issue("Removal receipt moved after ingest", parent?.id);
    await f.document(moved.id, 10);
    const removedDocument = await f.document(removed.id, 5);
    await f.ingest();
    await documentService(db).deleteIssueDocument(removed.id, "result");
    await f.ingest();
    const rows = await f.nativeRows();
    const visible = rows.find((row) => row.payload?.issueId === older.id)!;
    const hidden = rows.filter((row) => row.payload?.issueId === moved.id || row.payload?.issueId === removed.id);
    expect(hidden.map((row) => row.eventType)).toContain("issue.document_removed");
    expect(hidden.every((row) => row.accessClass === "company")).toBe(true);
    if (parent) await db.update(issues).set({ projectId: f.restrictedId }).where(eq(issues.id, parent.id));
    else for (const item of [moved, removed]) await db.update(issues).set({ projectId: f.restrictedId }).where(eq(issues.id, item.id));
    // No ingestion follows the move. Both receipt shapes must use current authority.
    const listed = await f.get(`/events?type=${nativeTypes}&order=desc&limit=1`);
    expect(listed.status).toBe(200);
    expect(listed.body.events.map((row: { id: string }) => row.id)).toEqual([visible.id]);
    expect(listed.body.count).toBe(1);
    const all = await f.get(`/events?type=${nativeTypes}&limit=5000`);
    expect(all.body.events.map((row: { id: string }) => row.id)).toEqual([visible.id]);
    for (const row of hidden) {
      expect((await f.get(`/events/${row.id}`)).status).toBe(404);
      for (const privateValue of [row.id, row.payload?.issueId, row.payload?.documentId, row.payload?.revisionId, row.payload?.sha256]) {
        if (privateValue) expect(JSON.stringify(all.body)).not.toContain(privateValue);
      }
    }
    const state = await f.get("/ingest-state");
    expect(state.body.eventsByType["issue.document_revision"]).toBe(1);
    expect(state.body.eventsByType["issue.document_removed"]).toBeUndefined();
    expect(JSON.stringify(state.body.cursors)).not.toContain(removedDocument.latestRevisionId);
    for (const actor of ["owner", "insider"] as const) {
      const allowed = await f.get(`/events?type=${nativeTypes}&limit=5000`, actor);
      expect(allowed.body.count).toBe(rows.length);
      for (const row of hidden) expect((await f.get(`/events/${row.id}`, actor)).status).toBe(200);
      const allowedState = await f.get("/ingest-state", actor);
      expect(allowedState.body.eventsByType["issue.document_revision"]).toBe(3);
      expect(allowedState.body.eventsByType["issue.document_removed"]).toBe(1);
    }
  });

  it("fails closed for a deleted issue, including its revision and removal receipts", async () => {
    const f = await fixture();
    const item = await f.issue("Deleted source issue");
    const doc = await f.document(item.id, 5);
    await f.ingest();
    await documentService(db).deleteIssueDocument(item.id, "result");
    await f.ingest();
    const rows = await f.nativeRows();
    expect(rows).toHaveLength(2);
    await db.delete(issues).where(eq(issues.id, item.id));
    for (const actor of ["owner", "member"] as const) {
      const list = await f.get(`/events?type=${nativeTypes}`, actor);
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ events: [], count: 0 });
      for (const row of rows) expect((await f.get(`/events/${row.id}`, actor)).status).toBe(404);
      const state = await f.get("/ingest-state", actor);
      expect(state.body.eventsByType["issue.document_revision"]).toBeUndefined();
      expect(state.body.eventsByType["issue.document_removed"]).toBeUndefined();
      expect(JSON.stringify(state.body.cursors)).not.toContain(doc.latestRevisionId);
    }
  });

  it("does not resolve a native receipt's source across companies", async () => {
    const local = await fixture();
    const foreign = await fixture();
    const foreignIssue = await foreign.issue("Foreign issue");
    await foreign.document(foreignIssue.id, 5);
    await foreign.ingest();
    const [foreignRow] = await foreign.nativeRows();
    expect((await local.get(`/events/${foreignRow!.id}`, "owner")).status).toBe(404);
    const result = await evaluationLedger(db).append([{ companyId: local.companyId, actorType: "system", sourceTable: "document_revisions", sourceId: foreignRow!.sourceId, sourceVersion: "foreign-reference", eventType: "issue.document_revision", eventTime: new Date(), payload: foreignRow!.payload }]);
    expect(result.inserted).toBe(1);
    expect((await local.get(`/events?type=${nativeTypes}`, "owner")).body.events).toEqual([]);
    expect((await local.get(`/events/${result.insertedIds[0]}`, "owner")).status).toBe(404);
  });

  it("retains stored restricted access when the current issue becomes public", async () => {
    const f = await fixture();
    const item = await f.issue("Historically restricted output");
    await db.update(issues).set({ projectId: f.restrictedId }).where(eq(issues.id, item.id));
    await f.document(item.id, 5);
    await f.ingest();
    const [row] = await f.nativeRows();
    expect(row!.accessClass).toBe(`project:${f.restrictedId}`);
    await db.update(issues).set({ projectId: f.openId }).where(eq(issues.id, item.id));
    expect((await f.get(`/events?type=${nativeTypes}`)).body.events).toEqual([]);
    expect((await f.get(`/events/${row!.id}`)).status).toBe(404);
    expect((await f.get(`/events/${row!.id}`, "insider")).status).toBe(200);
  });

  it("uses the normal issue authority when its assigned agent becomes owner-only", async () => {
    const f = await fixture();
    const item = await f.issue("Private worker output");
    await f.document(item.id, 5);
    await f.ingest();
    const [row] = await f.nativeRows();
    expect((await f.get(`/events/${row!.id}`)).status).toBe(200);
    await db.update(agents).set({ visibility: "owner" }).where(eq(agents.id, f.workerId));
    expect((await f.get(`/events/${row!.id}`)).status).toBe(404);
    expect((await f.get(`/events?type=${nativeTypes}`)).body.events).toEqual([]);
    expect((await f.get("/ingest-state")).body.eventsByType["issue.document_revision"]).toBeUndefined();
    expect((await f.get(`/events/${row!.id}`, "owner")).status).toBe(200);
  });

  it.each(["foreign", "cycle"] as const)("fails closed when inherited scope cannot resolve because of %s ancestry", async (kind) => {
    const f = await fixture();
    const item = await f.issue("Unresolved inherited scope");
    await f.document(item.id, 5);
    await f.ingest();
    const [row] = await f.nativeRows();
    let parentId = item.id;
    if (kind === "foreign") {
      const foreign = await fixture();
      parentId = (await foreign.issue("Other company parent")).id;
    }
    await db.update(issues).set({ projectId: null, parentId }).where(eq(issues.id, item.id));
    for (const actor of ["member", "owner"] as const) {
      expect((await f.get(`/events/${row!.id}`, actor)).status).toBe(404);
      expect((await f.get(`/events?type=${nativeTypes}`, actor)).body.events).toEqual([]);
    }
  });

});
