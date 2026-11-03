import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, documents, evaluationEvents, issues, projects } from "@paperclipai/db";
import { documentService } from "../services/documents.js";
import { evaluationIngest } from "../services/evaluation/ingest.js";
import { readNativeDocumentHeads, nativeDocumentHeadsMatch } from "../services/evaluation/sources.js";
import { addAgent, addCompany, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Regression target: digesting caller text instead of persisted UTF-8, losing scope,
// or leaving a stale positive proof after cascade-delete without an audit row.
describe("native persisted document evidence", () => {
  let db: TestDb;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let projectId: string;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("native-document-evidence-");
    db = createDb(temp.connectionString);
    companyId = (await addCompany(db, "Synthetic native evidence", "default")).id;
    agentId = (await addAgent(db, companyId, { name: "Synthetic writer" })).id;
    projectId = (await db.insert(projects).values({ companyId, name: "Private output", visibility: "restricted" }).returning())[0]!.id;
    issueId = (await db.insert(issues).values({ companyId, title: "Exact document", projectId, assigneeAgentId: agentId }).returning())[0]!.id;
  });
  afterAll(async () => { await temp?.cleanup(); });
  it("hashes native revisions and preserves provenance, scope and deletion absence", async () => {
    const body = "résumé\r\n漢字\n";
    const result = await documentService(db).upsertIssueDocument({ issueId, key: "result", body, format: "markdown", createdByAgentId: agentId });
    await evaluationIngest(db, { sources: ["document_revisions"] }).tick(companyId);
    const rows = await db.select().from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId));
    const proof = rows.find((r) => r.eventType === "issue.document_revision")!;
    expect(proof).toBeDefined();
    expect(proof.accessClass).toBe(`project:${projectId}`);
    expect(proof.payload).toMatchObject({ issueId, key: "result", documentId: result.document.id, revisionId: result.document.latestRevisionId, sha256: createHash("sha256").update(body, "utf8").digest("hex"), createdByAgentId: agentId });
    expect(JSON.stringify(proof.payload)).not.toContain(body);
    const heads = await readNativeDocumentHeads(db, companyId);
    expect(heads[0]?.revisionId).toBe(result.document.latestRevisionId);
    expect(nativeDocumentHeadsMatch(rows, heads, new Set([issueId]))).toBe(true);
    const changed = await documentService(db).upsertIssueDocument({ issueId, key: "result", body: "wrong", format: "markdown", baseRevisionId: result.document.latestRevisionId, createdByAgentId: agentId });
    expect(nativeDocumentHeadsMatch(rows, await readNativeDocumentHeads(db, companyId), new Set([issueId]))).toBe(false);
    expect(nativeDocumentHeadsMatch(rows, [{ ...heads[0]!, documentId: "replacement" }], new Set([issueId]))).toBe(false);
    expect(nativeDocumentHeadsMatch(rows, [{ ...heads[0]!, projectId: null }], new Set([issueId]))).toBe(false);
    expect(changed.document.latestRevisionId).not.toBe(result.document.latestRevisionId);
    // Simulate the documented crash window after cascade-delete and before audit.
    await db.delete(documents).where(eq(documents.id, result.document.id));
    expect(await readNativeDocumentHeads(db, companyId)).toEqual([]);
    expect(nativeDocumentHeadsMatch(rows, [], new Set([issueId]))).toBe(false);
    await evaluationIngest(db, { sources: ["document_revisions"] }).tick(companyId);
    const removed = (await db.select().from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId))).find((r) => r.eventType === "issue.document_removed");
    expect(removed?.accessClass).toBe(`project:${projectId}`);
    expect(removed?.payload).toMatchObject({ issueId, key: "result", documentId: result.document.id, reason: "missing_or_replaced_head" });
  });
});
