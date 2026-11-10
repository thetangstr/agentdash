import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentStewardships, approvals, batchOperationItems, companies, issueLabels, issues, labels, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser } from "./helpers/agent-profile-fixtures.js";
import { startBatchTestApp, type BatchTestApp } from "./helpers/batch-test-app.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

/**
 * AgentDash admin powers, part 3a: the product kinds `issue.update` (status,
 * priority, assignee, labels, project) and `approval.approve` /
 * `approval.reject`, end to end against embedded Postgres. The preview must
 * say what the single route will really do, and the result must be what it
 * did.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const NO_RUN = { heartbeat: { enabled: false, wakeOnDemand: false } };

describeEmbeddedPostgres("batch kinds: issues and approvals", () => {
  let t!: BatchTestApp;
  let companyId = "";
  let ownerId = "";
  let memberId = "";
  let owner: Record<string, string> = {};
  let member: Record<string, string> = {};

  beforeAll(async () => {
    t = await startBatchTestApp("paperclip-batch-kinds-");
    companyId = (await addCompany(t.db, "Kinds", "default")).id;
    ownerId = await addUser(t.db, companyId, "owner");
    memberId = await addUser(t.db, companyId, "member");
    owner = t.browser(await t.signIn(ownerId));
    member = t.browser(await t.signIn(memberId));
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  async function issue(values: Partial<typeof issues.$inferInsert> = {}) {
    const [row] = await t.db.insert(issues).values({ companyId, title: `Task ${randomUUID().slice(0, 6)}`, status: "todo", priority: "medium", ...values }).returning();
    return row!;
  }

  async function label(name: string) {
    const [row] = await t.db.insert(labels).values({ companyId, name: `${name} ${randomUUID().slice(0, 4)}`, color: "#336699" }).returning();
    return row!;
  }

  async function preview(headers: Record<string, string>, body: Record<string, unknown>) {
    const res = await request(t.server).post(`/api/companies/${companyId}/batches/preview`).set(headers).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  async function apply(headers: Record<string, string>, p: { batchId: string; confirmHandle: string; previewDigest: string }, between?: () => Promise<void>) {
    await between?.();
    const c = await request(t.server).post(`/api/companies/${companyId}/batches/${p.batchId}/confirm`).set(headers)
      .send({ handle: p.confirmHandle, previewDigest: p.previewDigest });
    expect(c.status, JSON.stringify(c.body)).toBe(202);
    await t.batches.waitForRunner(p.batchId);
    return (await request(t.server).get(`/api/companies/${companyId}/batches/${p.batchId}`).set(headers)).body;
  }

  async function labelIdsOf(issueId: string) {
    const rows = await t.db.select({ labelId: issueLabels.labelId }).from(issueLabels).where(eq(issueLabels.issueId, issueId));
    return rows.map((row) => row.labelId).sort();
  }

  describe("issue.update", () => {
    it("adds and removes labels as each task's full label set; a label the task already has is a no-op", async () => {
      const bug = await label("Bug");
      const ui = await label("UI");
      const a = await issue();
      const b = await issue();
      await t.db.insert(issueLabels).values([{ issueId: a.id, labelId: bug.id, companyId }, { issueId: b.id, labelId: ui.id, companyId }]);
      const noop = await preview(member, { kind: "issue.update", ids: [a.id], change: { addLabelIds: [bug.id] } });
      expect(noop.batchId).toBeNull();
      expect(noop.omitted.noop).toBe(1);

      const p = await preview(member, { kind: "issue.update", ids: [a.id, b.id], change: { addLabelIds: [ui.id], removeLabelIds: [bug.id] } });
      const byId = new Map(p.items.map((item: { entityId: string }) => [item.entityId, item]));
      expect((byId.get(a.id) as { before: { labelIds: string[] }; after: { labelIds: string[] } }).before.labelIds).toEqual([bug.id]);
      expect((byId.get(a.id) as { after: { labelIds: string[] } }).after.labelIds).toEqual([ui.id]);
      // b already has `ui` and lacks `bug`: nothing changes, so it is left out.
      expect(p.items).toHaveLength(1);
      const batch = await apply(member, p);
      expect(batch.items[0]).toMatchObject({ outcome: "applied", reasonCode: null });
      expect(await labelIdsOf(a.id)).toEqual([ui.id]);
    });

    it("a label added to a task after the preview refuses it as changed", async () => {
      const x = await label("X");
      const y = await label("Y");
      const a = await issue();
      const p = await preview(member, { kind: "issue.update", ids: [a.id], change: { addLabelIds: [x.id] } });
      const batch = await apply(member, p, async () => {
        await t.db.insert(issueLabels).values({ issueId: a.id, labelId: y.id, companyId });
      });
      expect(batch.items[0]).toMatchObject({ outcome: "refused", reasonCode: "changed_since_preview", reason: "This task changed after you previewed it, so nothing was done to it." });
      expect(await labelIdsOf(a.id)).toEqual([y.id]);
    });

    it("moves tasks to another project; the route's own project check applies", async () => {
      const [target] = await t.db.insert(projects).values({ companyId, name: `Launch ${randomUUID().slice(0, 4)}` }).returning();
      const [restricted] = await t.db.insert(projects).values({ companyId, name: "Hidden", visibility: "restricted", createdByUserId: ownerId }).returning();
      const a = await issue();
      const p = await preview(member, { kind: "issue.update", ids: [a.id], change: { projectId: target!.id } });
      expect(p.items[0]).toMatchObject({ before: { projectId: null }, after: { projectId: target!.id } });
      const batch = await apply(member, p);
      expect(batch.items[0]).toMatchObject({ outcome: "applied", reasonCode: null });
      const [row] = await t.db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, a.id));
      expect(row!.projectId).toBe(target!.id);
      // A project the member cannot see: refused by the route, nothing moves.
      const b = await issue();
      const q = await preview(member, { kind: "issue.update", ids: [b.id], change: { projectId: restricted!.id } });
      const refused = await apply(member, q);
      expect(refused.items[0].outcome).toBe("refused");
      const [still] = await t.db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, b.id));
      expect(still!.projectId).toBeNull();
    });

    it("assigning a person who looks after an agent shows, and does, what the route does: the agent gets it", async () => {
      const steward = await addUser(t.db, companyId, "member");
      const agent = await addAgent(t.db, companyId, { name: "Helper", status: "idle", runtimeConfig: NO_RUN });
      await t.db.insert(agentStewardships).values({ companyId, agentId: agent.id, userId: steward, assignedByUserId: ownerId });
      const a = await issue();
      const p = await preview(owner, { kind: "issue.update", ids: [a.id], change: { assignee: { userId: steward } } });
      expect(p.items[0]).toMatchObject({ after: { assigneeAgentId: agent.id, assigneeUserId: null } });
      expect(p.items[0].notes).toEqual(["This person looks after an agent, so the task goes to that agent."]);
      const batch = await apply(owner, p);
      expect(batch.items[0]).toMatchObject({ outcome: "applied", reasonCode: null });
      const [row] = await t.db.select({ assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId }).from(issues).where(eq(issues.id, a.id));
      expect(row).toEqual({ assigneeAgentId: agent.id, assigneeUserId: null });
    });

    it("a person who stops looking after their agent between preview and apply: refused as changed, not sent", async () => {
      const steward = await addUser(t.db, companyId, "member");
      const agent = await addAgent(t.db, companyId, { name: "Helper 2", status: "idle", runtimeConfig: NO_RUN });
      const [stewardship] = await t.db.insert(agentStewardships).values({ companyId, agentId: agent.id, userId: steward, assignedByUserId: ownerId }).returning();
      const a = await issue();
      const p = await preview(owner, { kind: "issue.update", ids: [a.id], change: { assignee: { userId: steward } } });
      const batch = await apply(owner, p, async () => {
        await t.db.update(agentStewardships).set({ endedAt: new Date() }).where(eq(agentStewardships.id, stewardship!.id));
      });
      expect(batch.items[0]).toMatchObject({ outcome: "refused", reasonCode: "changed_since_preview" });
    });

    it("a done on a task with a review step is left out with a plain reason, labels or not", async () => {
      const reviewer = await addAgent(t.db, companyId, { name: "Reviewer", status: "paused" });
      const policy = { ...normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer.id }] }] })! };
      const tag = await label("Tag");
      const a = await issue({ executionPolicy: policy as never });
      const p = await preview(owner, { kind: "issue.update", ids: [a.id], change: { status: "done", addLabelIds: [tag.id] } });
      expect(p.batchId).toBeNull();
      expect(p.notDecidable[0]).toMatchObject({ entityId: a.id, reasonCode: "goes_to_review_first" });
    });

    it("moving a done task back says it reopens it, and clears its review record when it has one", async () => {
      const plain = await issue({ status: "done" });
      const reviewed = await issue({ status: "done", executionState: { status: "completed", currentStageId: null, currentStageIndex: null, currentStageType: null, currentParticipant: null, returnAssignee: null, reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null } as never });
      const p = await preview(owner, { kind: "issue.update", ids: [plain.id, reviewed.id], change: { status: "todo" } });
      const notes = new Map(p.items.map((item: { entityId: string; notes?: string[] }) => [item.entityId, item.notes]));
      expect(notes.get(plain.id)).toEqual(["Moving it out of done reopens it."]);
      expect(notes.get(reviewed.id)).toEqual(["Moving it out of done reopens it and clears its review record."]);
    });
  });

  describe("approval.approve / approval.reject", () => {
    async function boardApproval(values: Partial<typeof approvals.$inferInsert> = {}) {
      const [row] = await t.db.insert(approvals).values({
        companyId, type: "request_board_approval", requestedByUserId: ownerId, status: "pending",
        payload: { title: `Spend ${randomUUID().slice(0, 4)}` }, ...values,
      }).returning();
      return row!;
    }

    it("approves several with one shared note, sending the previewed revision and a stable idempotency key", async () => {
      const a = await boardApproval();
      const b = await boardApproval();
      const p = await preview(owner, { kind: "approval.approve", ids: [a.id, b.id], change: { decisionNote: "Fine for this quarter." } });
      expect(p.items).toHaveLength(2);
      expect(p.items[0]).toMatchObject({ entityType: "approval", before: { status: "pending", revision: 1 }, after: { status: "approved" } });
      const batch = await apply(owner, p);
      expect(batch.counts).toMatchObject({ applied: 2, appliedDifferently: 0 });
      for (const [approval, item] of [[a, batch.items.find((i: { entityId: string }) => i.entityId === a.id)], [b, batch.items.find((i: { entityId: string }) => i.entityId === b.id)]] as const) {
        const [row] = await t.db.select().from(approvals).where(eq(approvals.id, approval.id));
        expect(row).toMatchObject({ status: "approved", decisionNote: "Fine for this quarter.", decisionIdempotencyKey: `batch:${item.itemId}` });
      }
    });

    it("rejects; an approval revised after the preview is refused and nothing is decided", async () => {
      const a = await boardApproval();
      const p = await preview(owner, { kind: "approval.reject", ids: [a.id], change: {} });
      // The approval is revised by someone else after the preview, but its
      // status is unchanged: the route's own revision check refuses it.
      const batch = await apply(owner, p, async () => {
        await t.db.update(approvals).set({ revision: 2 }).where(eq(approvals.id, a.id));
      });
      expect(batch.items[0]).toMatchObject({ outcome: "refused", reasonCode: "changed_since_preview", reason: "This approval changed after you previewed it, so nothing was done to it." });
      const [row] = await t.db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, a.id));
      expect(row!.status).toBe("pending");
    });

    it("the route refuses a stale revision itself (the request carries the previewed revision)", async () => {
      // Bypass the engine's own drift check by sending the kind's request
      // directly, as the runner would with a revision that moved on.
      const a = await boardApproval({ revision: 3 });
      const res = await request(t.server).post(`/api/approvals/${a.id}/approve`).set(owner)
        .send({ revision: 2, idempotencyKey: `batch:${randomUUID()}`, channel: "web" });
      expect(res.status).toBe(409);
    });

    it("an idempotency key replays the same decision instead of deciding twice", async () => {
      const a = await boardApproval();
      const key = `batch:${randomUUID()}`;
      const first = await request(t.server).post(`/api/approvals/${a.id}/approve`).set(owner).send({ revision: 1, idempotencyKey: key, channel: "web" });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const again = await request(t.server).post(`/api/approvals/${a.id}/approve`).set(owner).send({ revision: 1, idempotencyKey: key, channel: "web" });
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      const [row] = await t.db.select({ status: approvals.status, decidedAt: approvals.decidedAt }).from(approvals).where(eq(approvals.id, a.id));
      expect(row!.status).toBe("approved");
    });

    it("approvals the person may not decide are left out as not decidable, with a reason", async () => {
      const mk = (await addCompany(t.db, "Kinds MK", "agentdash_mk")).id;
      const mkOwner = await addUser(t.db, mk, "owner");
      const steward = await addUser(t.db, mk, "member");
      const agent = await addAgent(t.db, mk, { name: "Requester", status: "idle", runtimeConfig: NO_RUN });
      await t.db.insert(agentStewardships).values({ companyId: mk, agentId: agent.id, userId: steward, assignedByUserId: mkOwner });
      const [approval] = await t.db.insert(approvals).values({
        companyId: mk, type: "request_board_approval", requestedByAgentId: agent.id, status: "pending", payload: { title: "Buy a license" },
      }).returning();
      // The owner is not the agent's steward: in this profile only the steward decides.
      const headers = t.browser(await t.signIn(mkOwner));
      const res = await request(t.server).post(`/api/companies/${mk}/batches/preview`).set(headers)
        .send({ kind: "approval.approve", ids: [approval!.id], change: {} });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.batchId).toBeNull();
      expect(res.body.omitted.notDecidable).toBe(1);
      expect(res.body.notDecidable[0].reasonCode).toMatch(/not_waiting_on_you|not_yours_to_decide/);
      // The steward can.
      const stewardHeaders = t.browser(await t.signIn(steward));
      const ok = await request(t.server).post(`/api/companies/${mk}/batches/preview`).set(stewardHeaders)
        .send({ kind: "approval.approve", ids: [approval!.id], change: {} });
      expect(ok.body.items).toHaveLength(1);
      void companies;
      void and;
      void batchOperationItems;
    });

    it("request changes is not a batch kind", async () => {
      const res = await request(t.server).post(`/api/companies/${companyId}/batches/preview`).set(owner)
        .send({ kind: "approval.request_changes", ids: [randomUUID()], change: {} });
      expect(res.status).toBe(400);
    });
  });
});
