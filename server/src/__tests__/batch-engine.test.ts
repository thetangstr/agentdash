import { randomUUID } from "node:crypto";
import type { Request } from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  authSessions,
  batchOperationItems,
  batchOperations,
  companies,
  companyMemberships,
  instanceUserRoles,
  issues,
} from "@paperclipai/db";
import { BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser } from "./helpers/agent-profile-fixtures.js";
import { startBatchTestApp, type BatchTestApp, type Widget } from "./helpers/batch-test-app.js";
import { createHash, randomBytes } from "node:crypto";
import { sweepBatches } from "../services/batch/sweeper.js";
import { logActivity } from "../services/activity-log.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { boardApiKeys } from "@paperclipai/db";
import { resetBatchItemCredentials, batchItemCredentialCount } from "../services/batch/item-credential.js";
import { BATCH_KINDS } from "../services/batch/kinds.js";

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
  let adminId = "";
  let memberId = "";
  let ownerSession = "";
  let adminSession = "";
  let memberSession = "";
  let agentId = "";

  beforeAll(async () => {
    t = await startBatchTestApp("paperclip-batch-engine-", { itemTimeoutMs: 600 });
    const company = await addCompany(t.db, "Batch engine", "default");
    companyId = company.id;
    otherCompanyId = (await addCompany(t.db, "Batch elsewhere", "default")).id;
    ownerId = await addUser(t.db, companyId, "owner");
    adminId = await addUser(t.db, companyId, "admin");
    memberId = await addUser(t.db, companyId, "member");
    ownerSession = await t.signIn(ownerId);
    adminSession = await t.signIn(adminId);
    memberSession = await t.signIn(memberId);
    agentId = (await addAgent(t.db, companyId, { name: "Builder", status: "paused" })).id;
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

  it("preview → confirm → each issue through PATCH /api/issues/:id; no-ops and foreign ids are left out unnamed", async () => {
    const a = await issue({ status: "todo" });
    const b = await issue({ status: "todo" });
    const already = await issue({ status: "done" });
    const foreign = (await t.db.insert(issues).values({ companyId: otherCompanyId, title: "Theirs", status: "todo" }).returning())[0]!;

    const p = await preview(adminSession, { kind: "issue.update", ids: [a.id, b.id, already.id, foreign.id, "ENG-1"], change: { status: "done" } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.items.map((item: { entityId: string }) => item.entityId).sort()).toEqual([a.id, b.id].sort());
    expect(p.body.items[0]).toMatchObject({ entityType: "issue", before: { status: "todo" }, after: { status: "done" } });
    expect(p.body.omitted).toEqual({ notFound: 2, noop: 1, notDecidable: 0 });
    expect(JSON.stringify(p.body)).not.toContain(foreign.id);
    expect(p.body.confirmHandle).toEqual(expect.any(String));

    const [stored] = await t.db.select().from(batchOperations).where(eq(batchOperations.id, p.body.batchId));
    expect(stored!.confirmTokenHash).toBe(createHash("sha256").update(p.body.confirmHandle).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(p.body.confirmHandle);

    const c = await confirm(adminSession, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status).toBe(202);
    await t.batches.waitForRunner(p.body.batchId);

    const g = await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(t.browser(adminSession));
    expect(g.body).toMatchObject({ status: "completed", counts: { applied: 2, refused: 0, failed: 0, unknown: 0, appliedDifferently: 0 } });
    expect(g.body.items.every((item: { outcome: string; httpStatus: number }) => item.outcome === "applied" && item.httpStatus === 200)).toBe(true);
    expect(JSON.stringify(g.body)).not.toContain(p.body.confirmHandle);
    for (const id of [a.id, b.id]) {
      const [row] = await t.db.select({ status: issues.status }).from(issues).where(eq(issues.id, id));
      expect(row!.status).toBe("done");
    }
    // The route's own row, stamped with the batch through the request context.
    const updated = await t.db.select().from(activityLog).where(and(eq(activityLog.action, "issue.updated"), eq(activityLog.entityId, a.id)));
    expect(updated).toHaveLength(1);
    expect(updated[0]!.actorId).toBe(adminId);
    expect((updated[0]!.details as Record<string, unknown>).batch).toMatchObject({ id: p.body.batchId, origin: "ui" });
    const completed = await t.db.select().from(activityLog).where(and(eq(activityLog.action, "batch.completed"), eq(activityLog.entityId, p.body.batchId)));
    expect(completed).toHaveLength(1);
    expect((completed[0]!.details as Record<string, unknown>).counts).toEqual({ applied: 2, refused: 0, failed: 0, unknown: 0, appliedDifferently: 0 });
    expect(batchItemCredentialCount()).toBe(0);
  });

  it("items are sent with the batch item credential, as the confirming person", async () => {
    const w = widget();
    t.widgetCalls.length = 0;
    const { batch } = await runToEnd(adminSession, { kind: "test.widget", ids: [w.id], change: { value: "new" } });
    expect(batch.counts.applied).toBe(1);
    expect(t.widgetCalls).toEqual([{ widgetId: w.id, credentialKind: "batch_item", actorSource: "session", userId: adminId }]);
    const [row] = await t.db.select().from(activityLog).where(and(eq(activityLog.action, "widget.updated"), eq(activityLog.entityId, w.id)));
    expect((row!.details as Record<string, unknown>).batch).toMatchObject({ id: batch.id, origin: "ui", itemId: batch.items[0].itemId });
  });

  it("of two parallel confirms exactly one wins", async () => {
    const w = widget();
    const p = await preview(adminSession, { kind: "test.widget", ids: [w.id], change: { value: "raced" } });
    const body = { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest };
    const [one, two] = await Promise.all([confirm(adminSession, p.body.batchId, body), confirm(adminSession, p.body.batchId, body)]);
    expect([one.status, two.status].sort()).toEqual([202, 409]);
    await t.batches.waitForRunner(p.body.batchId);
    expect(t.widgetCalls.filter((call) => call.widgetId === w.id)).toHaveLength(1);
  });

  it("refuses a used, expired, mismatched or wrong handle and another person's confirm", async () => {
    const w = widget();
    const p = await preview(adminSession, { kind: "test.widget", ids: [w.id], change: { value: "x" } });
    const good = { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest };
    expect((await confirm(ownerSession, p.body.batchId, good)).status).toBe(404);
    expect((await confirm(adminSession, p.body.batchId, { ...good, previewDigest: "0".repeat(64) })).status).toBe(409);
    expect((await confirm(adminSession, p.body.batchId, { ...good, handle: randomBytes(32).toString("base64url") })).status).toBe(409);
    await t.db.update(batchOperations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(batchOperations.id, p.body.batchId));
    const expired = await confirm(adminSession, p.body.batchId, good);
    expect(expired.status).toBe(409);
    expect(expired.body.error).toMatch(/expired/);
    expect(t.widgets.get(w.id)!.value).toBe("old");
    // Cross-company: the batch is not visible under another company id.
    expect((await confirm(adminSession, p.body.batchId, good, otherCompanyId)).status).toBe(403);
  });

  it("drift: a record changed after the preview is refused and nothing is sent for it", async () => {
    const a = await issue({ priority: "low" });
    const p = await preview(adminSession, { kind: "issue.update", ids: [a.id], change: { priority: "high" } });
    await t.db.update(issues).set({ priority: "critical" }).where(eq(issues.id, a.id));
    const c = await confirm(adminSession, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status).toBe(202);
    await t.batches.waitForRunner(p.body.batchId);
    const [item] = await t.db.select().from(batchOperationItems).where(eq(batchOperationItems.batchId, p.body.batchId));
    expect(item).toMatchObject({ outcome: "refused", reasonCode: "changed_since_preview" });
    expect(item!.reason).toBe("This task changed after you previewed it, so nothing was done to it.");
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
    const { batch } = await runToEnd(adminSession, { kind: "test.widget", ids: [ok.id, refuse.id, boom.id, boomAfter.id, hang.id], change: { value: "new" } });
    const byId = new Map(batch.items.map((item: { entityId: string }) => [item.entityId, item]));
    expect(byId.get(ok.id)).toMatchObject({ outcome: "applied", httpStatus: 200 });
    expect(byId.get(refuse.id)).toMatchObject({ outcome: "refused", httpStatus: 409, reason: "This widget is locked." });
    expect(byId.get(boom.id)).toMatchObject({ outcome: "failed", httpStatus: 500 });
    expect(byId.get(boomAfter.id)).toMatchObject({ outcome: "unknown", httpStatus: 500 });
    expect(byId.get(hang.id)).toMatchObject({ outcome: "unknown", reasonCode: "no_answer", httpStatus: null });
    expect(batch.counts).toEqual({ applied: 1, refused: 1, failed: 1, unknown: 2, appliedDifferently: 0 });
    expect(batch.status).toBe("completed");
    for (const [action, id] of [["batch.item_refused", refuse.id], ["batch.item_failed", boom.id], ["batch.item_unknown", boomAfter.id], ["batch.item_unknown", hang.id]] as const) {
      const rows = await t.db.select().from(activityLog).where(and(eq(activityLog.action, action), eq(activityLog.entityId, id)));
      expect(rows, `${action} ${id}`).toHaveLength(1);
    }
    // Unknown is never retried: the hanging widget was called once.
    expect(t.widgetCalls.filter((call) => call.widgetId === hang.id)).toHaveLength(1);
  });

  it("stops sending when the person's session ends mid-batch", async () => {
    const sessionId = await t.signIn(adminId);
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
    const userId = await addUser(t.db, companyId, "admin");
    const sessionId = await t.signIn(userId);
    for (let i = 0; i < 5; i++) {
      expect((await preview(sessionId, { kind: "test.widget", ids: [widget().id], change: { value: "v" } })).status).toBe(200);
    }
    const sixth = await preview(sessionId, { kind: "test.widget", ids: [widget().id], change: { value: "v" } });
    expect(sixth.status).toBe(429);

    const budgetUser = await addUser(t.db, companyId, "admin");
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
    expect((await preview(adminSession, { kind: "nope", ids: [widget().id], change: {} })).status).toBe(400);
    expect((await preview(adminSession, { kind: "issue.update", ids: [randomUUID()], change: { title: "x" } })).status).toBe(400);
  });

  it("the sweeper interrupts a stopped runner: items being sent become unknown and are never resent, unsent ones refused; old previews expire", async () => {
    const [batch] = await t.db.insert(batchOperations).values({
      companyId, kind: "test.widget", change: { value: "v" }, origin: "ui", createdByUserId: adminId, status: "running",
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
      companyId, kind: "test.widget", change: { value: "v" }, origin: "ui", createdByUserId: adminId, status: "previewed",
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
    const { batch } = await runToEnd(adminSession, { kind: "test.widget", ids: [hang.id], change: { value: "new" } });
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
    const p = await preview(adminSession, { kind: "test.widget", ids: [w.id], change: { value: "c" } });
    const other = await addUser(t.db, companyId, "member");
    const otherSession = await t.signIn(other);
    expect((await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(t.browser(otherSession))).status).toBe(404);
    expect((await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(t.browser(ownerSession))).status).toBe(200);
    const mine = await request(t.server).get(`/api/companies/${companyId}/batches`).set(t.browser(otherSession));
    expect(mine.body.batches).toEqual([]);
    const all = await request(t.server).get(`/api/companies/${companyId}/batches`).set(t.browser(ownerSession));
    expect(all.body.batches.some((b: { id: string }) => b.id === p.body.batchId)).toBe(true);
    expect((await request(t.server).post(`/api/companies/${companyId}/batches/${p.body.batchId}/cancel`).set(t.browser(otherSession))).status).toBe(404);
    const cancelled = await request(t.server).post(`/api/companies/${companyId}/batches/${p.body.batchId}/cancel`).set(t.browser(adminSession));
    expect(cancelled.body.status).toBe("cancelled");
    const late = await confirm(adminSession, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(late.status).toBe(409);
    expect((await request(t.server).post(`/api/companies/${companyId}/batches/not-a-uuid/cancel`).set(t.browser(adminSession))).status).toBe(404);
  });

  it("a browser request without a trusted origin is still refused by the CSRF guard", async () => {
    const res = await request(t.server).post(`/api/companies/${companyId}/batches/preview`)
      .set("x-test-session", adminSession).send({ kind: "test.widget", ids: [widget().id], change: { value: "v" } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/trusted browser origin/);
  });

  it("assigning issues to an agent goes through the route's assignment rule", async () => {
    const a = await issue();
    const { batch } = await runToEnd(adminSession, { kind: "issue.update", ids: [a.id], change: { assignee: { agentId } } });
    expect(batch.items[0]).toMatchObject({ outcome: "applied", before: { assigneeAgentId: null }, after: { assigneeAgentId: agentId } });
    const [row] = await t.db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, a.id));
    expect(row!.assigneeAgentId).toBe(agentId);
  });

  // --- Security review fixes (PASS WITH FIXES on eb842442f) ---

  it("review fix 1: a 2xx that did something other than the preview is reported as applied differently, with the actual values", async () => {
    const same = widget("ok");
    const other = widget("different");
    const { batch } = await runToEnd(adminSession, { kind: "test.widget", ids: [same.id, other.id], change: { value: "new" } });
    const byId = new Map(batch.items.map((item: { entityId: string }) => [item.entityId, item]));
    expect(byId.get(same.id)).toMatchObject({ outcome: "applied", reasonCode: null, actual: { value: "new" } });
    expect(byId.get(other.id)).toMatchObject({
      outcome: "applied",
      reasonCode: "applied_differently",
      after: { value: "new" },
      actual: { value: "new-but-different" },
    });
    expect((byId.get(other.id) as { reason: string }).reason).toMatch(/was changed, but not as previewed: value is new-but-different, not new/);
    expect(batch.counts).toMatchObject({ applied: 2, appliedDifferently: 1 });
    const rows = await t.db.select().from(activityLog).where(and(eq(activityLog.action, "batch.item_applied_differently"), eq(activityLog.entityId, other.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ previewed: { value: "new" }, actual: { value: "new-but-different" }, batch: { id: batch.id } });
  });

  it("review fix 1: a done on an issue whose review step would take it is left out at preview, with a plain reason", async () => {
    const reviewer = await addAgent(t.db, companyId, { name: "Reviewer", status: "paused" });
    const policy = normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer.id }] }] })!;
    const reviewed = await issue({ status: "todo", executionPolicy: { ...policy } as never });
    const plain = await issue({ status: "todo" });
    const p = await preview(ownerSession, { kind: "issue.update", ids: [reviewed.id, plain.id], change: { status: "done" } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.items.map((item: { entityId: string }) => item.entityId)).toEqual([plain.id]);
    expect(p.body.omitted).toMatchObject({ notDecidable: 1 });
    expect(p.body.notDecidable).toEqual([expect.objectContaining({ entityId: reviewed.id, reasonCode: "goes_to_review_first" })]);
    expect(p.body.notDecidable[0].reason).toMatch(/goes to review first/);
    // A priority change on the same issue is not affected.
    const q = await preview(ownerSession, { kind: "issue.update", ids: [reviewed.id], change: { priority: "high" } });
    expect(q.body.items).toHaveLength(1);
  });

  it("review fix 4: get, list, cancel and reconcile refuse a board API key like preview and confirm do", async () => {
    const w = widget();
    const p = await preview(adminSession, { kind: "test.widget", ids: [w.id], change: { value: "k" } });
    await t.db.insert(boardApiKeys).values({ userId: adminId, name: "cli", keyHash: createHash("sha256").update("board-key-batch-test").digest("hex") });
    const key = { authorization: "Bearer board-key-batch-test" };
    const base = `/api/companies/${companyId}/batches`;
    expect((await request(t.server).get(`${base}/${p.body.batchId}`).set(key)).status).toBe(403);
    expect((await request(t.server).get(base).set(key)).status).toBe(403);
    expect((await request(t.server).post(`${base}/${p.body.batchId}/cancel`).set(key).send({})).status).toBe(403);
    expect((await request(t.server).post(`${base}/${p.body.batchId}/items/${p.body.items[0].itemId}/reconcile`).set(key).send({ verdict: "landed" })).status).toBe(403);
    const [row] = await t.db.select({ status: batchOperations.status }).from(batchOperations).where(eq(batchOperations.id, p.body.batchId));
    expect(row!.status).toBe("previewed");
  });

  it("review fix 5: a hand-posted or server row outside a batch cannot carry details.batch", async () => {
    const posted = await request(t.server).post(`/api/companies/${companyId}/activity`).set(t.browser(memberSession))
      .send({ action: "note.added", entityType: "company", entityId: companyId, details: { batch: { id: "forged", origin: "ui" }, note: "hi" } });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const [row] = await t.db.select().from(activityLog).where(eq(activityLog.id, posted.body.id));
    expect(row!.details).toMatchObject({ note: "hi" });
    expect((row!.details as Record<string, unknown>).batch).toBeUndefined();

    const entityId = randomUUID();
    await logActivity(t.db, { companyId, actorType: "user", actorId: adminId, action: "widget.updated", entityType: "widget", entityId, details: { batch: { id: "forged" }, value: "x" } });
    const [server] = await t.db.select().from(activityLog).where(eq(activityLog.entityId, entityId));
    expect((server!.details as Record<string, unknown>).batch).toBeUndefined();
  });

  // --- Security re-check fixes (bc4c5ac21) ---

  async function reviewPolicyFor(agentIdForReview: string) {
    return { ...normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: agentIdForReview }] }] })! };
  }

  it("re-check 1a: an in_review on an issue whose review step would take it is left out at preview", async () => {
    const reviewer = await addAgent(t.db, companyId, { name: "Reviewer B", status: "paused" });
    const reviewed = await issue({ status: "todo", executionPolicy: (await reviewPolicyFor(reviewer.id)) as never });
    const p = await preview(ownerSession, { kind: "issue.update", ids: [reviewed.id], change: { status: "in_review" } });
    expect(p.status).toBe(200);
    expect(p.body.items).toEqual([]);
    expect(p.body.notDecidable).toEqual([expect.objectContaining({ entityId: reviewed.id, reasonCode: "goes_to_review_first" })]);
  });

  it("re-check 1a: a review policy added between preview and apply refuses the in_review and sends nothing", async () => {
    const reviewer = await addAgent(t.db, companyId, { name: "Reviewer C", status: "paused" });
    const target = await issue({ status: "todo" });
    const p = await preview(ownerSession, { kind: "issue.update", ids: [target.id], change: { status: "in_review" } });
    await t.db.update(issues).set({ executionPolicy: (await reviewPolicyFor(reviewer.id)) as never }).where(eq(issues.id, target.id));
    const c = await confirm(ownerSession, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status).toBe(202);
    await t.batches.waitForRunner(p.body.batchId);
    const [item] = await t.db.select().from(batchOperationItems).where(eq(batchOperationItems.batchId, p.body.batchId));
    expect(item).toMatchObject({ outcome: "refused", reasonCode: "goes_to_review_first" });
    const [row] = await t.db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, target.id));
    expect(row).toEqual({ status: "todo", assigneeAgentId: null });
  });

  it("re-check 1a: a status change on an issue already in an active review step is left out at preview", async () => {
    const reviewer = await addAgent(t.db, companyId, { name: "Reviewer D", status: "paused" });
    const policy = await reviewPolicyFor(reviewer.id);
    const stage = policy.stages[0]!;
    const inReview = await issue({
      status: "in_review",
      assigneeAgentId: reviewer.id,
      executionPolicy: policy as never,
      executionState: {
        status: "pending", currentStageId: stage.id, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewer.id, userId: null },
        returnAssignee: { type: "user", agentId: null, userId: ownerId },
        reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      } as never,
    });
    const p = await preview(ownerSession, { kind: "issue.update", ids: [inReview.id], change: { status: "blocked" } });
    expect(p.status).toBe(200);
    expect(p.body.items).toEqual([]);
    expect(p.body.notDecidable).toEqual([expect.objectContaining({ entityId: inReview.id, reasonCode: "in_review_now" })]);
    // A priority change does not touch the workflow and still goes ahead.
    const q = await preview(ownerSession, { kind: "issue.update", ids: [inReview.id], change: { priority: "low" } });
    expect(q.body.items).toHaveLength(1);
  });

  it("re-check 1b: a side effect on a field the batch did not ask to change is reported as applied differently", async () => {
    const other = await addAgent(t.db, companyId, { name: "Side effect", status: "paused" });
    const target = await issue({ status: "todo" });
    // Stand-in for any route side effect: whatever moves this issue's status
    // also hands it to another agent.
    await t.db.execute(sql.raw(`
      create or replace function batch_test_side_effect() returns trigger language plpgsql as $$
      begin new.assignee_agent_id := '${other.id}'; return new; end $$;
      create trigger batch_test_side_effect before update of status on issues
        for each row when (new.id = '${target.id}') execute function batch_test_side_effect();`));
    try {
      const { batch } = await runToEnd(adminSession, { kind: "issue.update", ids: [target.id], change: { status: "blocked" } });
      const item = batch.items[0];
      expect(item).toMatchObject({
        outcome: "applied",
        reasonCode: "applied_differently",
        after: { status: "blocked", assigneeAgentId: null, assigneeUserId: null },
        actual: { status: "blocked", assigneeAgentId: other.id },
      });
      expect(item.reason).toMatch(new RegExp(`assigneeAgentId is ${other.id}, not none`));
      expect(batch.counts.appliedDifferently).toBe(1);
    } finally {
      await t.db.execute(sql.raw("drop trigger if exists batch_test_side_effect on issues; drop function if exists batch_test_side_effect();"));
    }
  });

  // --- Bulk changes are for company owners and admins (v2026.1110.1) ---

  it("a plain member is refused at preview for every kind, with a plain reason, and the refusal is logged", async () => {
    const w = widget();
    for (const kind of [...Object.keys(BATCH_KINDS), "test.widget"]) {
      const res = await preview(memberSession, { kind, ids: [w.id], change: {} });
      expect(res.status, `${kind}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error).toBe("Bulk changes are for company owners and admins.");
    }
    const open = await t.db.select().from(batchOperations).where(eq(batchOperations.createdByUserId, memberId));
    expect(open).toEqual([]);
    await vi.waitFor(async () => {
      const refused = await t.db.select().from(activityLog)
        .where(and(eq(activityLog.action, "authz.refused"), eq(activityLog.actorId, memberId)));
      expect(refused.length).toBeGreaterThanOrEqual(1);
      expect(refused[0]!.details).toMatchObject({ reasonCode: "COMPANY_ADMINISTRATOR_REQUIRED" });
    });
  });

  it("confirm asks again: an admin made a member after the preview is refused and nothing is sent", async () => {
    const demoted = await addUser(t.db, companyId, "admin");
    const session = await t.signIn(demoted);
    const w = widget();
    const p = await preview(session, { kind: "test.widget", ids: [w.id], change: { value: "new" } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    await t.db.update(companyMemberships).set({ membershipRole: "member" })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, demoted)));
    const c = await confirm(session, p.body.batchId, { handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status, JSON.stringify(c.body)).toBe(403);
    expect(c.body.error).toBe("Bulk changes are for company owners and admins.");
    const [row] = await t.db.select({ status: batchOperations.status }).from(batchOperations).where(eq(batchOperations.id, p.body.batchId));
    expect(row!.status).toBe("previewed");
    expect(t.widgets.get(w.id)!.value).toBe("old");
    expect(t.widgetCalls.filter((call) => call.widgetId === w.id)).toHaveLength(0);
  });

  it("owners, admins and instance admins can make bulk changes", async () => {
    const instanceAdmin = await addUser(t.db, companyId, "member");
    await t.db.insert(instanceUserRoles).values({ userId: instanceAdmin, role: "instance_admin" });
    for (const session of [ownerSession, adminSession, await t.signIn(instanceAdmin)]) {
      const w = widget();
      const { batch } = await runToEnd(session, { kind: "test.widget", ids: [w.id], change: { value: "new" } });
      expect(batch.counts.applied).toBe(1);
      expect(t.widgets.get(w.id)!.value).toBe("new");
    }
  });

  it("the local operator can make bulk changes", async () => {
    const port = Number(new URL(t.baseUrl).port);
    const req = {
      method: "POST",
      actor: { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true, companyIds: [], memberships: [] },
      socket: { localAddress: "127.0.0.1", localPort: port },
      header: () => undefined,
    } as unknown as Request;
    const w = widget();
    const p = await t.batches.preview(req, companyId, { kind: "test.widget", ids: [w.id], change: { value: "new" } });
    expect(p.batchId).toEqual(expect.any(String));
    const c = await t.batches.confirm(req, companyId, p.batchId!, { handle: p.confirmHandle!, previewDigest: p.previewDigest! });
    expect(c.status).toBe("running");
    await t.batches.waitForRunner(p.batchId!);
    const [item] = await t.db.select().from(batchOperationItems).where(eq(batchOperationItems.batchId, p.batchId!));
    expect(item!.outcome, item!.reason ?? "").toBe("applied");
    expect(t.widgets.get(w.id)!.value).toBe("new");
  });

  it("a plain member still changes a task on its own, exactly as before", async () => {
    const a = await issue({ status: "todo", priority: "low" });
    const res = await request(t.server).patch(`/api/issues/${a.id}`).set(t.browser(memberSession)).send({ status: "blocked", priority: "high" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await t.db.select({ status: issues.status, priority: issues.priority }).from(issues).where(eq(issues.id, a.id));
    expect(row).toEqual({ status: "blocked", priority: "high" });
  });

  it("leaves no credentials in flight", () => {
    expect(batchItemCredentialCount()).toBe(0);
    resetBatchItemCredentials();
    void authSessions;
  });
});
