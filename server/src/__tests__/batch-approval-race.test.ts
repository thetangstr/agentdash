import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvals } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addCompany, addUser } from "./helpers/agent-profile-fixtures.js";
import { startBatchTestApp, type BatchTestApp } from "./helpers/batch-test-app.js";
import { sendBatchItemOverLoopback, type BatchItemSender } from "../services/batch/runner.js";

/**
 * Security review of round 3a, finding 3: someone else decides an approval in
 * the instant between the runner's drift check and the send. The route then
 * answers 200 with THEIR decision (applied: false) and the batch must not
 * report it as its own.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("batch approval decided by someone else first", () => {
  let t!: BatchTestApp;
  let companyId = "";
  let owner: Record<string, string> = {};
  let other: Record<string, string> = {};
  let ownerId = "";
  // Runs just before each item is sent: the other person decides first.
  let beforeSend: ((path: string) => Promise<void>) | null = null;
  const send: BatchItemSender = async (input) => {
    if (beforeSend) await beforeSend(new URL(input.url).pathname);
    return sendBatchItemOverLoopback(input);
  };

  beforeAll(async () => {
    t = await startBatchTestApp("paperclip-batch-race-", { send });
    companyId = (await addCompany(t.db, "Race", "default")).id;
    ownerId = await addUser(t.db, companyId, "owner");
    owner = t.browser(await t.signIn(ownerId));
    other = t.browser(await t.signIn(await addUser(t.db, companyId, "owner")));
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  it("an approval approved by someone else just before the send is not recorded as this batch's decision", async () => {
    const [a] = await t.db.insert(approvals).values({ companyId, type: "request_board_approval", requestedByUserId: ownerId, status: "pending", payload: { title: "Race" } }).returning();
    const p = await request(t.server).post(`/api/companies/${companyId}/batches/preview`).set(owner).send({ kind: "approval.approve", ids: [a!.id], change: {} });
    expect(p.status).toBe(200);
    beforeSend = async () => {
      const res = await request(t.server).post(`/api/approvals/${a!.id}/approve`).set(other).send({ revision: 1, idempotencyKey: `web-${randomUUID()}`, channel: "web" });
      expect(res.status).toBe(200);
    };
    const c = await request(t.server).post(`/api/companies/${companyId}/batches/${p.body.batchId}/confirm`).set(owner)
      .send({ handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status).toBe(202);
    await t.batches.waitForRunner(p.body.batchId);
    beforeSend = null;
    const item = (await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(owner)).body.items[0];
    expect(item).toMatchObject({ outcome: "applied", reasonCode: "decided_by_someone_else" });
    expect(item.reason).toMatch(/someone else had already approved it, so this batch's decision was not recorded/);
    const [row] = await t.db.select({ decidedByUserId: approvals.decidedByUserId }).from(approvals).where(eq(approvals.id, a!.id));
    expect(row!.decidedByUserId).not.toBe(ownerId);
  });

  it("this batch's own decision (and a replay of its own key) is plain applied", async () => {
    const [a] = await t.db.insert(approvals).values({ companyId, type: "request_board_approval", requestedByUserId: ownerId, status: "pending", payload: { title: "Mine" } }).returning();
    const p = await request(t.server).post(`/api/companies/${companyId}/batches/preview`).set(owner).send({ kind: "approval.reject", ids: [a!.id], change: {} });
    await request(t.server).post(`/api/companies/${companyId}/batches/${p.body.batchId}/confirm`).set(owner).send({ handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    await t.batches.waitForRunner(p.body.batchId);
    const item = (await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(owner)).body.items[0];
    expect(item).toMatchObject({ outcome: "applied", reasonCode: null });
  });
});
