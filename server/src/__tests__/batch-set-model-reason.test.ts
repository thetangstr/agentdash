import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, batchOperationItems } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser } from "./helpers/agent-profile-fixtures.js";
import { startBatchTestApp, type BatchTestApp } from "./helpers/batch-test-app.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";
import { sendBatchItemOverLoopback, type BatchItemSender } from "../services/batch/runner.js";

/**
 * Review of be7e918cc (read-only question, answered with a fix): a refusal
 * from PATCH /agents/:id could quote configuration values in its message.
 * `agent.set_model` stores only a plain reason by status, never route text.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ADAPTER = "batch_reason_fake";
const SECRET = "sk-live-REASON-LEAK-77aa";

describeEmbeddedPostgres("agent.set_model refusal reasons", () => {
  let t!: BatchTestApp;
  // The route's refusal is simulated: a message that quotes a value.
  const send: BatchItemSender = async (input) => {
    if (input.method === "PATCH" && input.url.includes("/api/agents/")) {
      return { kind: "response", status: 422, body: { error: `adapterConfig.apiKey "${SECRET}" is not valid` } };
    }
    return sendBatchItemOverLoopback(input);
  };

  beforeAll(async () => {
    registerServerAdapter({
      type: ADAPTER,
      models: [{ id: "m1", label: "M1" }, { id: "m2", label: "M2" }],
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "fake" }),
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    } as never);
    t = await startBatchTestApp("paperclip-batch-reason-", { send });
  }, 120_000);

  afterAll(async () => {
    await t?.close();
    unregisterServerAdapter(ADAPTER);
  });

  it("stores a plain reason, never the route's text", async () => {
    const companyId = (await addCompany(t.db, "Reason", "default")).id;
    const owner = t.browser(await t.signIn(await addUser(t.db, companyId, "owner")));
    const agent = await addAgent(t.db, companyId, { name: "Configured", adapterType: ADAPTER, adapterConfig: { model: "m1", apiKey: SECRET }, status: "idle", runtimeConfig: { heartbeat: { enabled: false } } });
    const p = await request(t.server).post(`/api/companies/${companyId}/batches/preview`).set(owner).send({ kind: "agent.set_model", ids: [agent.id], change: { model: "m2" } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    await request(t.server).post(`/api/companies/${companyId}/batches/${p.body.batchId}/confirm`).set(owner).send({ handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    await t.batches.waitForRunner(p.body.batchId);
    const [item] = await t.db.select().from(batchOperationItems).where(eq(batchOperationItems.batchId, p.body.batchId));
    expect(item).toMatchObject({ outcome: "refused", httpStatus: 422, reason: "The agent's runtime did not accept that model, so it was not changed." });
    const activity = await t.db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(JSON.stringify(activity)).not.toContain(SECRET);
    const view = await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(owner);
    expect(JSON.stringify(view.body)).not.toContain(SECRET);
  });
});
