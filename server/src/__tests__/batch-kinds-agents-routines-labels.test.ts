import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
  batchOperationItems,
  batchOperations,
  companyMemberships,
  issueLabels,
  issues,
  labels,
  routineRuns,
  routines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser } from "./helpers/agent-profile-fixtures.js";
import { startBatchTestApp, type BatchTestApp } from "./helpers/batch-test-app.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";
import { logger } from "../middleware/logger.js";

/**
 * AgentDash admin powers, part 3b: agents (pause, resume, change model,
 * transfer steward), routines (archive, delete) and labels (rename/recolor,
 * delete) through the batch engine and their own single-record routes, plus
 * the two new routes (DELETE /routines/:id, PATCH /labels/:labelId).
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const NO_RUN = { heartbeat: { enabled: false, wakeOnDemand: false } };
const ADAPTER_ONE = "batch_3b_fake_one";
const ADAPTER_TWO = "batch_3b_fake_two";
const SECRET = "sk-live-DO-NOT-LEAK-9f2c";

describeEmbeddedPostgres("batch kinds: agents, routines and labels", () => {
  let t!: BatchTestApp;
  let companyId = "";
  let otherCompanyId = "";
  let ownerId = "";
  let memberId = "";
  let owner: Record<string, string> = {};
  let member: Record<string, string> = {};
  let outsider: Record<string, string> = {};

  beforeAll(async () => {
    for (const [type, models] of [[ADAPTER_ONE, ["model-a", "model-b"]], [ADAPTER_TWO, ["model-c"]]] as const) {
      registerServerAdapter({
        type,
        models: models.map((id) => ({ id, label: id.toUpperCase() })),
        execute: async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "fake" }),
        testEnvironment: async () => ({ adapterType: type, status: "pass", checks: [], testedAt: new Date().toISOString() }),
      } as never);
    }
    t = await startBatchTestApp("paperclip-batch-3b-");
    companyId = (await addCompany(t.db, "Kinds 3b", "default")).id;
    otherCompanyId = (await addCompany(t.db, "Elsewhere 3b", "default")).id;
    ownerId = await addUser(t.db, companyId, "owner");
    memberId = await addUser(t.db, companyId, "member");
    owner = t.browser(await t.signIn(ownerId));
    member = t.browser(await t.signIn(memberId));
    outsider = t.browser(await t.signIn(await addUser(t.db, otherCompanyId, "owner")));
  }, 120_000);

  afterAll(async () => {
    await t?.close();
    unregisterServerAdapter(ADAPTER_ONE);
    unregisterServerAdapter(ADAPTER_TWO);
  });

  async function preview(headers: Record<string, string>, body: Record<string, unknown>, company = companyId) {
    return request(t.server).post(`/api/companies/${company}/batches/preview`).set(headers).send(body);
  }

  async function confirm(headers: Record<string, string>, p: { batchId: string; confirmHandle: string; previewDigest: string }) {
    return request(t.server).post(`/api/companies/${companyId}/batches/${p.batchId}/confirm`).set(headers).send({ handle: p.confirmHandle, previewDigest: p.previewDigest });
  }

  async function run(headers: Record<string, string>, body: Record<string, unknown>, between?: () => Promise<void>) {
    const p = await preview(headers, body);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    await between?.();
    const c = await confirm(headers, p.body);
    expect(c.status, JSON.stringify(c.body)).toBe(202);
    await t.batches.waitForRunner(p.body.batchId);
    const batch = (await request(t.server).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(headers)).body;
    return { preview: p.body, batch };
  }

  function agent(values: Partial<typeof agents.$inferInsert> & { name: string }) {
    return addAgent(t.db, companyId, { status: "idle", runtimeConfig: NO_RUN, adapterType: ADAPTER_ONE, adapterConfig: { model: "model-a" }, ...values });
  }

  describe("agent.set_model", () => {
    it("changes only the model; agents whose runtime lacks it are left out; no other configuration ever leaves the server", async () => {
      const logged: unknown[] = [];
      const spies = (["info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never));
      try {
        const one = await agent({ name: "Uno", adapterConfig: { model: "model-a", apiKey: SECRET, env: { TOKEN: SECRET } } });
        const two = await agent({ name: "Dos", adapterType: ADAPTER_TWO, adapterConfig: { model: "model-c", apiKey: SECRET } });
        const { preview: p, batch } = await run(owner, { kind: "agent.set_model", ids: [one.id, two.id], change: { model: "model-b" } });
        expect(p.items).toEqual([expect.objectContaining({ entityId: one.id, before: { model: "model-a" }, after: { model: "model-b" } })]);
        expect(p.notDecidable).toEqual([expect.objectContaining({ entityId: two.id, reasonCode: "model_not_offered", reason: "Dos runs on a runtime that does not offer model-b, so it was left out." })]);
        expect(batch.items[0]).toMatchObject({ outcome: "applied", reasonCode: null, actual: { model: "model-b" } });
        const [row] = await t.db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.id, one.id));
        expect(row!.adapterConfig).toMatchObject({ model: "model-b", apiKey: SECRET });
        expect(JSON.stringify((row!.adapterConfig as { env: unknown }).env)).toContain(SECRET);
        // The secret is nowhere a batch writes or answers.
        const batchRows = await t.db.select().from(batchOperations).where(eq(batchOperations.id, p.batchId));
        const itemRows = await t.db.select().from(batchOperationItems).where(eq(batchOperationItems.batchId, p.batchId));
        const activity = await t.db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
        for (const [what, value] of [["preview", p], ["batch view", batch], ["batch row", batchRows], ["item rows", itemRows], ["activity", activity], ["log lines", logged]] as const) {
          expect(JSON.stringify(value), what).not.toContain(SECRET);
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it("an agent already on the model is a no-op", async () => {
      const one = await agent({ name: "Same" });
      const p = await preview(owner, { kind: "agent.set_model", ids: [one.id], change: { model: "model-a" } });
      expect(p.body).toMatchObject({ batchId: null, omitted: { noop: 1 } });
    });
  });

  describe("agent.pause / agent.resume", () => {
    it("pauses and resumes, saying what happens; already paused is a no-op", async () => {
      const idle = await agent({ name: "Idle" });
      const running = await agent({ name: "Busy", status: "running" });
      const paused = await agent({ name: "Resting", status: "paused" });
      const { preview: p, batch } = await run(owner, { kind: "agent.pause", ids: [idle.id, running.id, paused.id], change: {} });
      expect(p.omitted.noop).toBe(1);
      const notes = new Map(p.items.map((item: { entityId: string; notes: string[] }) => [item.entityId, item.notes]));
      expect(notes.get(idle.id)).toEqual(["Pausing stops it from starting new work."]);
      expect(notes.get(running.id)).toEqual(["Pausing stops the work it is doing now."]);
      expect(batch.counts).toMatchObject({ applied: 2, appliedDifferently: 0 });
      const resumed = await run(owner, { kind: "agent.resume", ids: [idle.id, paused.id], change: {} });
      expect(resumed.preview.items.every((item: { notes: string[] }) => item.notes[0] === "Resuming may start work now.")).toBe(true);
      expect(resumed.batch.counts.applied).toBe(2);
      const rows = await t.db.select({ id: agents.id, status: agents.status }).from(agents).where(eq(agents.id, paused.id));
      expect(rows[0]!.status).not.toBe("paused");
    });

    it("is refused at preview without agent management, and re-checked at confirm: an owner demoted in between sends nothing", async () => {
      const target = await agent({ name: "Target" });
      expect((await preview(member, { kind: "agent.pause", ids: [target.id], change: {} })).status).toBe(403);
      const demoted = await addUser(t.db, companyId, "owner");
      const headers = t.browser(await t.signIn(demoted));
      const p = await preview(headers, { kind: "agent.pause", ids: [target.id], change: {} });
      expect(p.status).toBe(200);
      await t.db.update(companyMemberships).set({ membershipRole: "member" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, demoted)));
      const c = await confirm(headers, p.body);
      expect(c.status).toBe(403);
      const [row] = await t.db.select({ status: agents.status }).from(agents).where(eq(agents.id, target.id));
      expect(row!.status).toBe("idle");
      const [stored] = await t.db.select({ status: batchOperations.status }).from(batchOperations).where(eq(batchOperations.id, p.body.batchId));
      expect(stored!.status).toBe("previewed");
    });

    it("a removed agent is left out with a plain reason", async () => {
      const gone = await agent({ name: "Gone", status: "terminated" });
      const p = await preview(owner, { kind: "agent.pause", ids: [gone.id], change: {} });
      expect(p.body.notDecidable[0]).toMatchObject({ reasonCode: "agent_not_manageable", reason: "Gone has been removed, so it was left out." });
    });
  });

  describe("agent.transfer_steward", () => {
    it("hands an agent to a new steward with the reason; same steward is a no-op; no steward is left out", async () => {
      const from = await addUser(t.db, companyId, "member");
      const to = await addUser(t.db, companyId, "member");
      const keeper = await addUser(t.db, companyId, "member");
      const a = await agent({ name: "Paired" });
      const lonely = await agent({ name: "Lonely" });
      await t.db.insert(agentStewardships).values({ companyId, agentId: a.id, userId: from, assignedByUserId: ownerId });
      const { preview: p, batch } = await run(owner, { kind: "agent.transfer_steward", ids: [a.id, lonely.id], change: { userId: to, transferReason: "Team change" } });
      expect(p.items).toEqual([expect.objectContaining({ entityId: a.id, before: { stewardUserId: from }, after: { stewardUserId: to } })]);
      expect(p.notDecidable[0]).toMatchObject({ entityId: lonely.id, reasonCode: "no_steward_to_transfer" });
      expect(batch.items[0], batch.items[0].reason).toMatchObject({ outcome: "applied", reasonCode: null });
      const rows = await t.db.select().from(agentStewardships).where(eq(agentStewardships.agentId, a.id));
      expect(rows.find((row) => !row.endedAt)!.userId).toBe(to);
      // Same steward: a no-op.
      const same = await preview(owner, { kind: "agent.transfer_steward", ids: [a.id], change: { userId: to, transferReason: "Again" } });
      expect(same.body).toMatchObject({ batchId: null, omitted: { noop: 1 } });
      void keeper;
    });

    it("a person looks after one agent at a time: only the first agent goes to them, the rest are left out with the reason", async () => {
      const to = await addUser(t.db, companyId, "member");
      const s1 = await addUser(t.db, companyId, "member");
      const s2 = await addUser(t.db, companyId, "member");
      const first = await agent({ name: "First" });
      const second = await agent({ name: "Second" });
      await t.db.insert(agentStewardships).values([
        { companyId, agentId: first.id, userId: s1, assignedByUserId: ownerId },
        { companyId, agentId: second.id, userId: s2, assignedByUserId: ownerId },
      ]);
      const p = await preview(owner, { kind: "agent.transfer_steward", ids: [first.id, second.id], change: { userId: to, transferReason: "Reorg" } });
      expect(p.body.items.map((item: { entityId: string }) => item.entityId)).toEqual([first.id]);
      expect(p.body.notDecidable[0]).toMatchObject({ entityId: second.id, reasonCode: "steward_already_busy" });
      expect(p.body.notDecidable[0].reason).toContain("would already look after First");
    });
  });

  describe("routines", () => {
    async function routine(values: Partial<typeof routines.$inferInsert> = {}) {
      const [row] = await t.db.insert(routines).values({ companyId, title: `Daily ${randomUUID().slice(0, 4)}`, status: "active", ...values }).returning();
      return row!;
    }

    it("archives; an archived one is a no-op", async () => {
      const a = await routine();
      const b = await routine({ status: "archived" });
      const { preview: p, batch } = await run(member, { kind: "routine.archive", ids: [a.id, b.id], change: {} });
      expect(p.omitted.noop).toBe(1);
      expect(batch.items[0]).toMatchObject({ outcome: "applied", reasonCode: null });
      const [row] = await t.db.select({ status: routines.status }).from(routines).where(eq(routines.id, a.id));
      expect(row!.status).toBe("archived");
    });

    it("deletes: the routine is gone everywhere, its runs, created tasks and history are kept, and the preview says so", async () => {
      const r = await routine();
      const [made] = await t.db.insert(issues).values({ companyId, title: "Made by the routine", status: "todo", priority: "medium", originKind: "routine_execution", originId: r.id }).returning();
      await t.db.insert(routineRuns).values({ companyId, routineId: r.id, source: "schedule", status: "completed", linkedIssueId: made!.id });
      await t.db.insert(activityLog).values({ companyId, actorType: "user", actorId: ownerId, action: "routine.created", entityType: "routine", entityId: r.id, origin: "server" });
      const { preview: p, batch } = await run(member, { kind: "routine.delete", ids: [r.id], change: {} });
      expect(p.items[0].notes[0]).toBe("Deleting removes the routine for good; it cannot be restored. Its past runs, the tasks they created and its history are kept.");
      expect(batch.items[0]).toMatchObject({ outcome: "applied", reasonCode: null, actual: { state: "deleted" } });
      expect((await request(t.server).get(`/api/routines/${r.id}`).set(member)).status).toBe(404);
      const list = await request(t.server).get(`/api/companies/${companyId}/routines`).set(member);
      expect(list.body.some((row: { id: string }) => row.id === r.id)).toBe(false);
      expect(await t.db.select().from(routineRuns).where(eq(routineRuns.routineId, r.id))).toHaveLength(1);
      expect(await t.db.select().from(issues).where(eq(issues.id, made!.id))).toHaveLength(1);
      const history = await t.db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.entityId, r.id));
      expect(history.map((row) => row.action).sort()).toEqual(["routine.created", "routine.deleted"]);
      // A second delete is 404: it is gone.
      expect((await request(t.server).delete(`/api/routines/${r.id}`).set(member)).status).toBe(404);
    });

    it("DELETE /routines/:id: same guard as archive, company-scoped", async () => {
      const r = await routine();
      expect((await request(t.server).delete(`/api/routines/${r.id}`).set(outsider)).status).toBe(403);
      expect((await request(t.server).delete(`/api/routines/${randomUUID()}`).set(member)).status).toBe(404);
      const res = await request(t.server).delete(`/api/routines/${r.id}`).set(member);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: r.id, deleted: true });
    });
  });

  describe("labels", () => {
    async function label(name: string, color = "#336699", company = companyId) {
      const [row] = await t.db.insert(labels).values({ companyId: company, name: `${name} ${randomUUID().slice(0, 4)}`, color }).returning();
      return row!;
    }

    it("PATCH /labels/:labelId renames and recolors, logs it, refuses a duplicate name (409), another company (403) and a missing label (404)", async () => {
      const a = await label("Bug");
      const b = await label("UI");
      const res = await request(t.server).patch(`/api/labels/${a.id}`).set(member).send({ name: "Defect", color: "#aa0000" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: a.id, name: "Defect", color: "#aa0000" });
      const [logged] = await t.db.select().from(activityLog).where(and(eq(activityLog.action, "label.updated"), eq(activityLog.entityId, a.id)));
      expect(logged!.details).toMatchObject({ name: "Defect", previousName: a.name });
      const dup = await request(t.server).patch(`/api/labels/${b.id}`).set(member).send({ name: "Defect" });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toBe("A label with this name already exists.");
      expect((await request(t.server).patch(`/api/labels/${a.id}`).set(outsider).send({ color: "#000000" })).status).toBe(403);
      expect((await request(t.server).patch(`/api/labels/${randomUUID()}`).set(member).send({ color: "#000000" })).status).toBe(404);
      expect((await request(t.server).patch(`/api/labels/${a.id}`).set(member).send({})).status).toBe(400);
      const foreign = await label("Theirs", "#123456", otherCompanyId);
      expect((await request(t.server).patch(`/api/labels/${foreign.id}`).set(member).send({ color: "#000000" })).status).toBe(403);
    });

    it("recolors several labels in one batch", async () => {
      const a = await label("One");
      const b = await label("Two");
      const { batch } = await run(member, { kind: "label.update", ids: [a.id, b.id], change: { color: "#00aa00" } });
      expect(batch.counts).toMatchObject({ applied: 2, appliedDifferently: 0 });
    });

    it("deletes labels; the preview says how many tasks lose each label; a label put on more tasks after the preview is refused", async () => {
      const used = await label("Used");
      const busy = await label("Busy");
      const [i1] = await t.db.insert(issues).values({ companyId, title: "x", status: "todo", priority: "medium" }).returning();
      const [i2] = await t.db.insert(issues).values({ companyId, title: "y", status: "todo", priority: "medium" }).returning();
      await t.db.insert(issueLabels).values([{ issueId: i1!.id, labelId: used.id, companyId }, { issueId: i2!.id, labelId: used.id, companyId }, { issueId: i1!.id, labelId: busy.id, companyId }]);
      const { preview: p, batch } = await run(member, { kind: "label.delete", ids: [used.id, busy.id], change: {} }, async () => {
        await t.db.insert(issueLabels).values({ issueId: i2!.id, labelId: busy.id, companyId });
      });
      const notes = new Map(p.items.map((item: { entityId: string; notes: string[] }) => [item.entityId, item.notes[0]]));
      expect(notes.get(used.id)).toBe("Deleting removes the label from 2 tasks. Those tasks get no history entry for it.");
      const byId = new Map(batch.items.map((item: { entityId: string }) => [item.entityId, item]));
      expect(byId.get(used.id)).toMatchObject({ outcome: "applied", reasonCode: null });
      expect(byId.get(busy.id)).toMatchObject({ outcome: "refused", reasonCode: "changed_since_preview", reason: "This label changed after you previewed it, so nothing was done to it." });
      expect(await t.db.select().from(labels).where(eq(labels.id, used.id))).toHaveLength(0);
      expect(await t.db.select().from(labels).where(eq(labels.id, busy.id))).toHaveLength(1);
    });
  });
});
