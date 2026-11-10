import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  authSessions,
  batchOperationItems,
  batchOperations,
  companies,
  issues,
  projects,
} from "@paperclipai/db";
import { BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser } from "./helpers/agent-profile-fixtures.js";
import { startBatchTestApp, type BatchTestApp, type Widget } from "./helpers/batch-test-app.js";
import { createHash, randomBytes } from "node:crypto";
import { sweepBatches } from "../services/batch/sweeper.js";
import { resetBatchItemCredentials, batchItemCredentialCount } from "../services/batch/item-credential.js";

/**
 * AgentDash admin powers, part 2: the batch engine against embedded Postgres
 * with every migration applied (0158 batch tables, 0159 company switches),
 * end to end over a real listener: preview → single-use confirm → each item
 * through its own single-record route over loopback → per-record outcomes →
 * activity rows.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("batch engine (real database, real loopback)", () => {
  let t!: BatchTestApp;
  let companyId = "";
  let otherCompanyId = "";
  let ownerId = "";
  let memberId = "";
  let ownerSession = "";
  let memberSession = "";
  let agentId = "";
  let restrictedProjectId = "";

  beforeAll(async () => {
    t = await startBatchTestApp("paperclip-batch-engine-", { itemTimeoutMs: 600 });
    const company = await addCompany(t.db, "Batch engine", "default");
    companyId = company.id;
    otherCompanyId = (await addCompany(t.db, "Batch elsewhere", "default")).id;
    ownerId = await addUser(t.db, companyId, "owner");
    memberId = await addUser(t.db, companyId, "member");
    ownerSession = await t.signIn(ownerId);
    memberSession = await t.signIn(memberId);
    agentId = (await addAgent(t.db, companyId, { name: "Builder", status: "paused" })).id;
    restrictedProjectId = (await t.db.insert(projects).values({
      companyId, name: "Board pack", visibility: "restricted", createdByUserId: ownerId,
    }).returning())[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  async function issue(values: Partial<typeof issues.$inferInsert> = {}) {
    const [row] = await t.db.insert(issues).values({ companyId, title: `Issue ${randomUUID().slice(0, 6)}`, status: "todo", priority: "medium", ...values }).returning();
    return row!;
  }

  function widget(mode: Widget["mode"] = "ok", value = "old", company = companyId): Widget {
    const w = { id: randomUUID(), companyId: company, value, mode };
    t.widgets.set(w.id, w);
    return w;
  }

  async function preview(sessionId: string, body: Record<string, unknown>, company = companyId) {
    return request(t.server).post(`/api/companies/${company}/batches/preview`).set(t.browser(sessionId)).send(body);
  }

  async function confirm(sessionId: string, batchId: string, body: Record<string, unknown>, company = companyId) {
    return request(t.server).post(`/api/companies/${company}/batches/${batchId}/confirm`).set(t.browser(sessionId)).send(body);
  }

  async function runToEnd(sessionId: string, body: Record<string, unknown>) {
    const p = await preview(sessionId, body);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const c = await confirm(sessionId, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status, JSON.stringify(c.body)).toBe(202);
    await t.batches.waitForRunner(p.body.batchId);
    const g = await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(t.browser(sessionId));
    expect(g.status).toBe(200);
    return { preview: p.body, batch: g.body };
  }

  it("migrations 0158 and 0159 applied: the company switches exist with their defaults", async () => {
    const [row] = await t.db.select().from(companies).where(eq(companies.id, companyId));
    expect(row).toMatchObject({
      adminDirectiveReadEnabled: false,
      adminTranscriptReadEnabled: false,
      assistantAdminBatchesEnabled: false,
      assistantBatchMaxRecords: 50,
      defaultCeilingTemplateId: null,
    });
    await expect(t.db.execute(sql`update companies set assistant_batch_max_records = 201 where id = ${companyId}`)).rejects.toThrow();
  });

  it("preview → confirm → each issue through PATCH /api/issues/:id; no-ops, invisible and foreign ids are left out unnamed", async () => {
    const a = await issue({ status: "todo" });
    const b = await issue({ status: "todo" });
    const already = await issue({ status: "done" });
    const hidden = await issue({ status: "todo", projectId: restrictedProjectId });
    const foreign = (await t.db.insert(issues).values({ companyId: otherCompanyId, title: "Theirs", status: "todo" }).returning())[0]!;

    const p = await preview(memberSession, { kind: "issue.update", ids: [a.id, b.id, already.id, hidden.id, foreign.id, "ENG-1"], change: { status: "done" } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.items.map((item: { entityId: string }) => item.entityId).sort()).toEqual([a.id, b.id].sort());
    expect(p.body.items[0]).toMatchObject({ entityType: "issue", before: { status: "todo" }, after: { status: "done" } });
    expect(p.body.omitted).toEqual({ notFound: 3, noop: 1, notDecidable: 0 });
    expect(JSON.stringify(p.body)).not.toContain(hidden.id);
    expect(JSON.stringify(p.body)).not.toContain(foreign.id);
    expect(p.body.confirmHandle).toEqual(expect.any(String));

    const [stored] = await t.db.select().from(batchOperations).where(eq(batchOperations.id, p.body.batchId));
    expect(stored!.confirmTokenHash).toBe(createHash("sha256").update(p.body.confirmHandle).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(p.body.confirmHandle);

    const c = await confirm(memberSession, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status).toBe(202);
    await t.batches.waitForRunner(p.body.batchId);

    const g = await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(t.browser(memberSession));
    expect(g.body).toMatchObject({ status: "completed", counts: { applied: 2, refused: 0, failed: 0, unknown: 0 } });
    expect(g.body.items.every((item: { outcome: string; httpStatus: number }) => item.outcome === "applied" && item.httpStatus === 200)).toBe(true);
    expect(JSON.stringify(g.body)).not.toContain(p.body.confirmHandle);
    for (const id of [a.id, b.id]) {
      const [row] = await t.db.select({ status: issues.status }).from(issues).where(eq(issues.id, id));
      expect(row!.status).toBe("done");
    }
    // The route's own row, stamped with the batch through the request context.
    const updated = await t.db.select().from(activityLog).where(and(eq(activityLog.action, "issue.updated"), eq(activityLog.entityId, a.id)));
    expect(updated).toHaveLength(1);
    expect(updated[0]!.actorId).toBe(memberId);
    expect((updated[0]!.details as Record<string, unknown>).batch).toMatchObject({ id: p.body.batchId, origin: "ui" });
    const completed = await t.db.select().from(activityLog).where(and(eq(activityLog.action, "batch.completed"), eq(activityLog.entityId, p.body.batchId)));
    expect(completed).toHaveLength(1);
    expect((completed[0]!.details as Record<string, unknown>).counts).toEqual({ applied: 2, refused: 0, failed: 0, unknown: 0 });
    expect(batchItemCredentialCount()).toBe(0);
  });

  it("items are sent with the batch item credential, as the confirming person", async () => {
    const w = widget();
    t.widgetCalls.length = 0;
    const { batch } = await runToEnd(memberSession, { kind: "test.widget", ids: [w.id], change: { value: "new" } });
    expect(batch.counts.applied).toBe(1);
    expect(t.widgetCalls).toEqual([{ widgetId: w.id, credentialKind: "batch_item", actorSource: "session", userId: memberId }]);
    const [row] = await t.db.select().from(activityLog).where(and(eq(activityLog.action, "widget.updated"), eq(activityLog.entityId, w.id)));
    expect((row!.details as Record<string, unknown>).batch).toMatchObject({ id: batch.id, origin: "ui", itemId: batch.items[0].itemId });
  });

  it("of two parallel confirms exactly one wins", async () => {
    const w = widget();
    const p = await preview(memberSession, { kind: "test.widget", ids: [w.id], change: { value: "raced" } });
    const body = { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest };
    const [one, two] = await Promise.all([confirm(memberSession, p.body.batchId, body), confirm(memberSession, p.body.batchId, body)]);
    expect([one.status, two.status].sort()).toEqual([202, 409]);
    await t.batches.waitForRunner(p.body.batchId);
    expect(t.widgetCalls.filter((call) => call.widgetId === w.id)).toHaveLength(1);
  });

  it("refuses a used, expired, mismatched or wrong handle and another person's confirm", async () => {
    const w = widget();
    const p = await preview(memberSession, { kind: "test.widget", ids: [w.id], change: { value: "x" } });
    const good = { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest };
    expect((await confirm(ownerSession, p.body.batchId, good)).status).toBe(404);
    expect((await confirm(memberSession, p.body.batchId, { ...good, previewDigest: "0".repeat(64) })).status).toBe(409);
    expect((await confirm(memberSession, p.body.batchId, { ...good, handle: randomBytes(32).toString("base64url") })).status).toBe(409);
    await t.db.update(batchOperations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(batchOperations.id, p.body.batchId));
    const expired = await confirm(memberSession, p.body.batchId, good);
    expect(expired.status).toBe(409);
    expect(expired.body.error).toMatch(/expired/);
    expect(t.widgets.get(w.id)!.value).toBe("old");
    // Cross-company: the batch is not visible under another company id.
    expect((await confirm(memberSession, p.body.batchId, good, otherCompanyId)).status).toBe(403);
  });

  it("drift: a record changed after the preview is refused and nothing is sent for it", async () => {
    const a = await issue({ priority: "low" });
    const p = await preview(memberSession, { kind: "issue.update", ids: [a.id], change: { priority: "high" } });
    await t.db.update(issues).set({ priority: "critical" }).where(eq(issues.id, a.id));
    const c = await confirm(memberSession, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status).toBe(202);
    await t.batches.waitForRunner(p.body.batchId);
    const [item] = await t.db.select().from(batchOperationItems).where(eq(batchOperationItems.batchId, p.body.batchId));
    expect(item).toMatchObject({ outcome: "refused", reasonCode: "changed_since_preview" });
    expect(item!.reason).toMatch(/changed after you previewed it; nothing was done to it/);
    const [row] = await t.db.select({ priority: issues.priority }).from(issues).where(eq(issues.id, a.id));
    expect(row!.priority).toBe("critical");
    const refusedRows = await t.db.select().from(activityLog).where(and(eq(activityLog.action, "batch.item_refused"), eq(activityLog.entityId, a.id)));
    expect(refusedRows).toHaveLength(1);
    expect(await t.db.select().from(activityLog).where(and(eq(activityLog.action, "issue.updated"), eq(activityLog.entityId, a.id)))).toHaveLength(0);
  });

  it("maps every answer to an outcome: refused with the route's reason, failed, unknown after a 500 that changed it, unknown on no answer", async () => {
    const ok = widget("ok");
    const refuse = widget("refuse");
    const boom = widget("boom");
    const boomAfter = widget("boom-after");
    const hang = widget("hang");
    const { batch } = await runToEnd(memberSession, { kind: "test.widget", ids: [ok.id, refuse.id, boom.id, boomAfter.id, hang.id], change: { value: "new" } });
    const byId = new Map(batch.items.map((item: { entityId: string }) => [item.entityId, item]));
    expect(byId.get(ok.id)).toMatchObject({ outcome: "applied", httpStatus: 200 });
    expect(byId.get(refuse.id)).toMatchObject({ outcome: "refused", httpStatus: 409, reason: "This widget is locked." });
    expect(byId.get(boom.id)).toMatchObject({ outcome: "failed", httpStatus: 500 });
    expect(byId.get(boomAfter.id)).toMatchObject({ outcome: "unknown", httpStatus: 500 });
    expect(byId.get(hang.id)).toMatchObject({ outcome: "unknown", reasonCode: "no_answer", httpStatus: null });
    expect(batch.counts).toEqual({ applied: 1, refused: 1, failed: 1, unknown: 2 });
    expect(batch.status).toBe("completed");
    for (const [action, id] of [["batch.item_refused", refuse.id], ["batch.item_failed", boom.id], ["batch.item_unknown", boomAfter.id], ["batch.item_unknown", hang.id]] as const) {
      const rows = await t.db.select().from(activityLog).where(and(eq(activityLog.action, action), eq(activityLog.entityId, id)));
      expect(rows, `${action} ${id}`).toHaveLength(1);
    }
    // Unknown is never retried: the hanging widget was called once.
    expect(t.widgetCalls.filter((call) => call.widgetId === hang.id)).toHaveLength(1);
  });

  it("stops sending when the person's session ends mid-batch", async () => {
    const sessionId = await t.signIn(memberId);
    const ender = widget("end-session");
    const next = widget("ok");
    const p = await preview(sessionId, { kind: "test.widget", ids: [ender.id, next.id], change: { value: "new" } });
    const c = await confirm(sessionId, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status).toBe(202);
    await t.batches.waitForRunner(p.body.batchId);
    const items = await t.db.select().from(batchOperationItems).where(eq(batchOperationItems.batchId, p.body.batchId)).orderBy(batchOperationItems.ordinal);
    expect(items.map((item) => [item.outcome, item.reasonCode])).toEqual([["applied", null], ["refused", "access_ended"]]);
    expect(t.widgets.get(next.id)!.value).toBe("old");
  });

  it("caps open previews per person and confirmed records per hour", async () => {
    const userId = await addUser(t.db, companyId, "member");
    const sessionId = await t.signIn(userId);
    for (let i = 0; i < 5; i++) {
      expect((await preview(sessionId, { kind: "test.widget", ids: [widget().id], change: { value: "v" } })).status).toBe(200);
    }
    const sixth = await preview(sessionId, { kind: "test.widget", ids: [widget().id], change: { value: "v" } });
    expect(sixth.status).toBe(429);

    const budgetUser = await addUser(t.db, companyId, "member");
    const budgetSession = await t.signIn(budgetUser);
    await t.db.insert(batchOperations).values({
      companyId, kind: "test.widget", change: { value: "v" }, origin: "ui", createdByUserId: budgetUser, status: "completed",
      previewDigest: "f".repeat(64), itemCount: BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR, expiresAt: new Date(), confirmedAt: new Date(),
    });
    const p = await preview(budgetSession, { kind: "test.widget", ids: [widget().id], change: { value: "v" } });
    const c = await confirm(budgetSession, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status).toBe(429);
  });

  it("only a signed-in person in the browser can start a batch: agents and board keys are refused, members of other companies too", async () => {
    const [key] = await t.db.insert(agentApiKeys).values({ agentId, companyId, name: "batch-test", keyHash: createHash("sha256").update("agent-secret-batch").digest("hex") }).returning();
    expect(key).toBeTruthy();
    const asAgent = await request(t.server).post(`/api/companies/${companyId}/batches/preview`)
      .set("authorization", "Bearer agent-secret-batch").send({ kind: "test.widget", ids: [widget().id], change: { value: "v" } });
    expect(asAgent.status).toBe(403);
    const outsider = await addUser(t.db, otherCompanyId, "owner");
    const outsiderSession = await t.signIn(outsider);
    expect((await preview(outsiderSession, { kind: "test.widget", ids: [widget().id], change: { value: "v" } })).status).toBe(403);
    expect((await preview(memberSession, { kind: "nope", ids: [widget().id], change: {} })).status).toBe(400);
    expect((await preview(memberSession, { kind: "issue.update", ids: [randomUUID()], change: { title: "x" } })).status).toBe(400);
  });

  it("the sweeper interrupts a stopped runner: items being sent become unknown and are never resent, unsent ones refused; old previews expire", async () => {
    const [batch] = await t.db.insert(batchOperations).values({
      companyId, kind: "test.widget", change: { value: "v" }, origin: "ui", createdByUserId: memberId, status: "running",
      previewDigest: "a".repeat(64), itemCount: 3, expiresAt: new Date(), confirmedAt: new Date(),
      executorHeartbeatAt: new Date(Date.now() - 120_000),
    }).returning();
    const ids = [widget().id, widget().id, widget().id];
    await t.db.insert(batchOperationItems).values([
      { batchId: batch!.id, ordinal: 0, entityType: "widget", entityId: ids[0]!, label: "A", before: {}, after: {}, fingerprint: "x", outcome: "applied" },
      { batchId: batch!.id, ordinal: 1, entityType: "widget", entityId: ids[1]!, label: "B", before: {}, after: {}, fingerprint: "x", outcome: "applying" },
      { batchId: batch!.id, ordinal: 2, entityType: "widget", entityId: ids[2]!, label: "C", before: {}, after: {}, fingerprint: "x", outcome: "pending" },
    ]);
    const [old] = await t.db.insert(batchOperations).values({
      companyId, kind: "test.widget", change: { value: "v" }, origin: "ui", createdByUserId: memberId, status: "previewed",
      previewDigest: "b".repeat(64), itemCount: 1, expiresAt: new Date(Date.now() - 1000),
    }).returning();
    const result = await sweepBatches(t.db);
    expect(result.interrupted).toBeGreaterThanOrEqual(1);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const [after] = await t.db.select().from(batchOperations).where(eq(batchOperations.id, batch!.id));
    expect(after).toMatchObject({ status: "interrupted", counts: { applied: 1, refused: 1, failed: 0, unknown: 1 } });
    const items = await t.db.select().from(batchOperationItems).where(eq(batchOperationItems.batchId, batch!.id)).orderBy(batchOperationItems.ordinal);
    expect(items.map((item) => item.outcome)).toEqual(["applied", "unknown", "refused"]);
    expect(items[2]!.reasonCode).toBe("batch_interrupted");
    const [expired] = await t.db.select().from(batchOperations).where(eq(batchOperations.id, old!.id));
    expect(expired!.status).toBe("expired");
    expect(await t.db.select().from(activityLog).where(and(eq(activityLog.action, "batch.interrupted"), eq(activityLog.entityId, batch!.id)))).toHaveLength(1);
    // A second sweep finds nothing to do (multi-replica safe).
    const again = await sweepBatches(t.db);
    expect(again.interrupted).toBe(0);
  });

  it("an admin records a verdict on an unknown item once; it never resends; members cannot", async () => {
    const hang = widget("hang");
    const { batch } = await runToEnd(memberSession, { kind: "test.widget", ids: [hang.id], change: { value: "new" } });
    const itemId = batch.items[0].itemId;
    const path = `/api/companies/${companyId}/batches/${batch.id}/items/${itemId}/reconcile`;
    expect((await request(t.server).post(path).set(t.browser(memberSession)).send({ verdict: "landed" })).status).toBe(403);
    const ok = await request(t.server).post(path).set(t.browser(ownerSession)).send({ verdict: "did_not_land", note: "Checked by hand." });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ outcome: "unknown", reconciledVerdict: "did_not_land" });
    expect((await request(t.server).post(path).set(t.browser(ownerSession)).send({ verdict: "landed" })).status).toBe(409);
    expect(t.widgetCalls.filter((call) => call.widgetId === hang.id)).toHaveLength(1);
    expect(await t.db.select().from(activityLog).where(and(eq(activityLog.action, "batch.item_reconciled"), eq(activityLog.entityId, hang.id)))).toHaveLength(1);
  });

  it("reads: the creator and admins see a batch; another member does not; lists are scoped; cancel only before confirm", async () => {
    const w = widget();
    const p = await preview(memberSession, { kind: "test.widget", ids: [w.id], change: { value: "c" } });
    const other = await addUser(t.db, companyId, "member");
    const otherSession = await t.signIn(other);
    expect((await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(t.browser(otherSession))).status).toBe(404);
    expect((await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(t.browser(ownerSession))).status).toBe(200);
    const mine = await request(t.server).get(`/api/companies/${companyId}/batches`).set(t.browser(otherSession));
    expect(mine.body.batches).toEqual([]);
    const all = await request(t.server).get(`/api/companies/${companyId}/batches`).set(t.browser(ownerSession));
    expect(all.body.batches.some((b: { id: string }) => b.id === p.body.batchId)).toBe(true);
    expect((await request(t.server).post(`/api/companies/${companyId}/batches/${p.body.batchId}/cancel`).set(t.browser(otherSession))).status).toBe(404);
    const cancelled = await request(t.server).post(`/api/companies/${companyId}/batches/${p.body.batchId}/cancel`).set(t.browser(memberSession));
    expect(cancelled.body.status).toBe("cancelled");
    const late = await confirm(memberSession, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(late.status).toBe(409);
    expect((await request(t.server).post(`/api/companies/${companyId}/batches/not-a-uuid/cancel`).set(t.browser(memberSession))).status).toBe(404);
  });

  it("a browser request without a trusted origin is still refused by the CSRF guard", async () => {
    const res = await request(t.server).post(`/api/companies/${companyId}/batches/preview`)
      .set("x-test-session", memberSession).send({ kind: "test.widget", ids: [widget().id], change: { value: "v" } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/trusted browser origin/);
  });

  it("assigning issues to an agent goes through the route's assignment rule", async () => {
    const a = await issue();
    const { batch } = await runToEnd(memberSession, { kind: "issue.update", ids: [a.id], change: { assignee: { agentId } } });
    expect(batch.items[0]).toMatchObject({ outcome: "applied", before: { assigneeAgentId: null }, after: { assigneeAgentId: agentId } });
    const [row] = await t.db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, a.id));
    expect(row!.assigneeAgentId).toBe(agentId);
  });

  it("leaves no credentials in flight", () => {
    expect(batchItemCredentialCount()).toBe(0);
    resetBatchItemCredentials();
    void authSessions;
  });
});
