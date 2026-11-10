import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentCeilingTemplates,
  agentGovernancePolicies,
  agents,
  agentStewardships,
  batchOperationItems,
  batchOperations,
  companies,
  companyMemberships,
} from "@paperclipai/db";
import { computeEffectiveAgentPolicy, DEFAULT_AGENT_GOVERNANCE_POLICY, type AgentGovernancePolicy } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser } from "./helpers/agent-profile-fixtures.js";
import { startBatchTestApp, type BatchTestApp } from "./helpers/batch-test-app.js";
import { agentService } from "../services/agents.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";
import { agentGovernanceService } from "../services/agent-governance.js";

/**
 * AgentDash admin powers, part 3c: ceiling templates (routes, scoping),
 * applying one to many agents (`agent.apply_ceiling`, the preview is the
 * route's own clamp), the company default ceiling for new agents (applied
 * once, at creation), and choosing new stewards when removing a member.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const NO_RUN = { heartbeat: { enabled: false, wakeOnDemand: false } };
const SECRET = "sk-live-CEILING-NOLEAK-31";
const FAKE = "ceilings_fake";

const TIGHT: AgentGovernancePolicy = {
  permissions: ["tasks:assign"],
  monthlyBudgetCents: 50_000,
  destructiveActions: "approval_required",
  dataScopes: ["*"],
  providers: ["slack"],
  minimumApproval: "steward",
};

describeEmbeddedPostgres("ceiling templates, applying them, the default for new agents, and member removal", () => {
  let t!: BatchTestApp;
  let mk = "";
  let plain = "";
  let elsewhere = "";
  let ownerId = "";
  let owner: Record<string, string> = {};
  let member: Record<string, string> = {};
  let outsider: Record<string, string> = {};

  beforeAll(async () => {
    registerServerAdapter({
      type: FAKE,
      models: [],
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "fake" }),
      testEnvironment: async () => ({ adapterType: FAKE, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    } as never);
    t = await startBatchTestApp("paperclip-ceilings-");
    mk = (await addCompany(t.db, "Ceilings", "agentdash_mk")).id;
    plain = (await addCompany(t.db, "Plain", "default")).id;
    elsewhere = (await addCompany(t.db, "Elsewhere", "agentdash_mk")).id;
    ownerId = await addUser(t.db, mk, "owner");
    owner = t.browser(await t.signIn(ownerId));
    member = t.browser(await t.signIn(await addUser(t.db, mk, "member")));
    outsider = t.browser(await t.signIn(await addUser(t.db, elsewhere, "owner")));
    await t.db.insert(companyMemberships).values({ companyId: plain, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" });
  }, 120_000);

  afterAll(async () => {
    await t?.close();
    unregisterServerAdapter(FAKE);
  });

  const base = (company = mk) => `/api/companies/${company}/ceiling-templates`;

  async function template(name = `Tight ${randomUUID().slice(0, 4)}`, ceiling = TIGHT) {
    const res = await request(t.server).post(base()).set(owner).send({ name, ceiling });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; name: string; revision: number };
  }

  describe("templates", () => {
    it("owners and admins create, edit and delete; members read; activity is logged", async () => {
      const created = await template("Contractors");
      expect((await request(t.server).post(base()).set(member).send({ name: "Mine", ceiling: TIGHT })).status).toBe(403);
      const list = await request(t.server).get(base()).set(member);
      expect(list.status).toBe(200);
      expect(list.body.templates.some((row: { id: string }) => row.id === created.id)).toBe(true);
      expect((await request(t.server).post(base()).set(owner).send({ name: "Contractors", ceiling: TIGHT })).status).toBe(409);
      const stale = await request(t.server).patch(`${base()}/${created.id}`).set(owner).send({ name: "Renamed", revision: 7 });
      expect(stale.status).toBe(409);
      const edited = await request(t.server).patch(`${base()}/${created.id}`).set(owner).send({ name: "Renamed", revision: 1 });
      expect(edited.body).toMatchObject({ name: "Renamed", revision: 2 });
      expect((await request(t.server).patch(`${base()}/${created.id}`).set(member).send({ name: "x", revision: 2 })).status).toBe(403);
      expect((await request(t.server).delete(`${base()}/${created.id}`).set(owner)).body).toEqual({ id: created.id, deleted: true });
      const actions = (await t.db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.entityId, created.id))).map((row) => row.action).sort();
      expect(actions).toEqual(["ceiling_template.created", "ceiling_template.deleted", "ceiling_template.updated"]);
    });

    it("are scoped to their company and exist only where agent ceilings do", async () => {
      const mine = await template();
      // Another company's member, or this template id under another company: not found.
      expect((await request(t.server).get(base()).set(outsider)).status).toBe(403);
      expect((await request(t.server).patch(`${base(elsewhere)}/${mine.id}`).set(outsider).send({ name: "Stolen", revision: 1 })).status).toBe(404);
      expect((await request(t.server).delete(`${base(elsewhere)}/${mine.id}`).set(outsider)).status).toBe(404);
      // Off-profile: 404, like a company that does not exist.
      expect((await request(t.server).get(base(plain)).set(owner)).status).toBe(404);
      expect((await request(t.server).post(base(plain)).set(owner).send({ name: "x", ceiling: TIGHT })).status).toBe(404);
      expect((await request(t.server).post(base()).set(owner).send({ name: "Bad", ceiling: { ...TIGHT, minimumApproval: "everyone" } })).status).toBe(400);
    });
  });

  describe("the company default for new agents", () => {
    it("is set by an admin to one of the company's own templates; another company's is refused; members cannot", async () => {
      const mine = await template();
      const theirs = (await t.db.insert(agentCeilingTemplates).values({ companyId: elsewhere, name: "Theirs", ceiling: TIGHT }).returning())[0]!;
      expect((await request(t.server).patch(`/api/companies/${mk}`).set(owner).send({ defaultCeilingTemplateId: theirs.id })).status).toBe(422);
      expect((await request(t.server).patch(`/api/companies/${mk}`).set(member).send({ defaultCeilingTemplateId: mine.id })).status).toBe(403);
      const ok = await request(t.server).patch(`/api/companies/${mk}`).set(owner).send({ defaultCeilingTemplateId: mine.id });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.defaultCeilingTemplateId).toBe(mine.id);
      // The default cannot be deleted out from under the company.
      const refused = await request(t.server).delete(`${base()}/${mine.id}`).set(owner);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/ceiling for new agents/);
      await request(t.server).patch(`/api/companies/${mk}`).set(owner).send({ defaultCeilingTemplateId: null });
    });

    it("applies once, at creation, through the create funnel and the create route; never to existing agents; a cleared default does nothing", async () => {
      const before = await addAgent(t.db, mk, { name: "Existing", status: "idle", runtimeConfig: NO_RUN });
      const mine = await template();
      await t.db.update(companies).set({ defaultCeilingTemplateId: mine.id }).where(eq(companies.id, mk));

      const direct = await agentService(t.db).create(mk, { name: "Direct hire", role: "general", adapterType: "process", adapterConfig: {}, runtimeConfig: NO_RUN, status: "idle" } as never);
      const viaRoute = await request(t.server).post(`/api/companies/${mk}/agents`).set(owner).send({ name: "Route hire", role: "general", adapterType: FAKE, adapterConfig: {}, runtimeConfig: NO_RUN });
      expect(viaRoute.status, JSON.stringify(viaRoute.body)).toBeLessThan(300);
      for (const agentId of [direct.id, viaRoute.body.id as string]) {
        const [row] = await t.db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, agentId));
        expect(row, agentId).toBeTruthy();
        expect(row!.effectivePolicy).toMatchObject({ monthlyBudgetCents: 50_000, providers: ["slack"] });
        const logged = await t.db.select().from(activityLog).where(and(eq(activityLog.agentId, agentId), eq(activityLog.action, "agent.governance_ceiling_updated")));
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ actorType: "system" });
        expect(logged[0]!.details).toMatchObject({ source: "company_default", templateId: mine.id });
      }
      // The agent that existed before keeps no ceiling row at all.
      expect(await t.db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, before.id))).toHaveLength(0);
      expect(await agentGovernanceService(t.db).applyCompanyDefaultCeiling(mk, direct.id)).toBeNull(); // never twice

      await t.db.update(companies).set({ defaultCeilingTemplateId: null }).where(eq(companies.id, mk));
      const after = await agentService(t.db).create(mk, { name: "After", role: "general", adapterType: "process", adapterConfig: {}, runtimeConfig: NO_RUN, status: "idle" } as never);
      expect(await t.db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, after.id))).toHaveLength(0);
    });

    it("every hire path reaches the one agent insert that applies it", async () => {
      // Plan-based and approval-based hires call agentService.create; this
      // guards that no other production code inserts agents directly.
      const { execSync } = await import("node:child_process");
      const out = execSync("grep -rln 'insert(agents)' src --include=*.ts", { cwd: new URL("../..", import.meta.url).pathname }).toString().trim().split("\n")
        .filter((file) => !file.includes("__tests__") && !file.endsWith(".test.ts"));
      expect(out.sort()).toEqual(["src/services/agents.ts", "src/services/handshake-demo.ts"]);
    });
  });

  describe("agent.apply_ceiling", () => {
    async function governed(name: string, request: Partial<AgentGovernancePolicy> = {}) {
      const agent = await addAgent(t.db, mk, { name, status: "idle", runtimeConfig: NO_RUN, adapterConfig: { apiKey: SECRET } });
      const stewardRequest = { ...DEFAULT_AGENT_GOVERNANCE_POLICY, ...request };
      await t.db.insert(agentGovernancePolicies).values({
        companyId: mk, agentId: agent.id, ownerCeiling: DEFAULT_AGENT_GOVERNANCE_POLICY, stewardRequest,
        effectivePolicy: computeEffectiveAgentPolicy(DEFAULT_AGENT_GOVERNANCE_POLICY, stewardRequest),
      } as never);
      return agent;
    }

    async function preview(headers: Record<string, string>, ids: string[], templateId: string, company = mk) {
      return request(t.server).post(`/api/companies/${company}/batches/preview`).set(headers).send({ kind: "agent.apply_ceiling", ids, change: { templateId } });
    }

    it("previews the route's own clamp per agent, with gains and losses, and applies exactly that; no configuration in any row", async () => {
      const tpl = await template();
      const narrow = await governed("Narrow", { monthlyBudgetCents: 10_000, providers: ["slack", "teams"] });
      const p = await preview(owner, [narrow.id], tpl.id);
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const expected = computeEffectiveAgentPolicy(TIGHT, { ...DEFAULT_AGENT_GOVERNANCE_POLICY, monthlyBudgetCents: 10_000, providers: ["slack", "teams"] });
      expect(p.body.items[0].after).toMatchObject({ monthlyBudgetCents: expected.monthlyBudgetCents, providers: expected.providers, minimumApproval: "steward" });
      expect(p.body.items[0].notes.some((note: string) => note.startsWith("Loses: Providers: loses teams"))).toBe(true);
      const c = await request(t.server).post(`/api/companies/${mk}/batches/${p.body.batchId}/confirm`).set(owner).send({ handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
      expect(c.status).toBe(202);
      await t.batches.waitForRunner(p.body.batchId);
      const view = (await request(t.server).get(`/api/companies/${mk}/batches/${p.body.batchId}`).set(owner)).body;
      expect(view.items[0], view.items[0].reason).toMatchObject({ outcome: "applied", reasonCode: null });
      const [row] = await t.db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, narrow.id));
      expect(row!.effectivePolicy).toMatchObject({ monthlyBudgetCents: expected.monthlyBudgetCents, providers: expected.providers });
      const stored = [await t.db.select().from(batchOperations).where(eq(batchOperations.id, p.body.batchId)), await t.db.select().from(batchOperationItems).where(eq(batchOperationItems.batchId, p.body.batchId)), view];
      expect(JSON.stringify(stored)).not.toContain(SECRET);
    });

    it("an agent whose effective policy would not change is a no-op", async () => {
      const tpl = await template(`Open ${randomUUID().slice(0, 4)}`, DEFAULT_AGENT_GOVERNANCE_POLICY);
      const free = await governed("Free");
      const p = await preview(owner, [free.id], tpl.id);
      expect(p.body).toMatchObject({ batchId: null, omitted: { noop: 1 } });
    });

    it("a policy changed after the preview is refused, and the route itself refuses a stale revision", async () => {
      const tpl = await template();
      const agent = await governed("Moving");
      const p = await preview(owner, [agent.id], tpl.id);
      // Someone edits the ceiling in between.
      const direct = await request(t.server).put(`/api/companies/${mk}/agents/${agent.id}/governance/ceiling`).set(owner)
        .send({ policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, monthlyBudgetCents: 90_000 }, revision: 1 });
      expect(direct.status, JSON.stringify(direct.body)).toBe(200);
      await request(t.server).post(`/api/companies/${mk}/batches/${p.body.batchId}/confirm`).set(owner).send({ handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
      await t.batches.waitForRunner(p.body.batchId);
      const [item] = await t.db.select().from(batchOperationItems).where(eq(batchOperationItems.batchId, p.body.batchId));
      expect(item).toMatchObject({ outcome: "refused", reasonCode: "changed_since_preview" });
      const stale = await request(t.server).put(`/api/companies/${mk}/agents/${agent.id}/governance/ceiling`).set(owner).send({ policy: TIGHT, revision: 1 });
      expect(stale.status).toBe(409);
    });

    it("re-checks the guard at confirm: an owner demoted in between sends nothing", async () => {
      const tpl = await template();
      const agent = await governed("Guarded");
      const demoted = await addUser(t.db, mk, "owner");
      const headers = t.browser(await t.signIn(demoted));
      const p = await preview(headers, [agent.id], tpl.id);
      expect(p.status).toBe(200);
      await t.db.update(companyMemberships).set({ membershipRole: "member" }).where(and(eq(companyMemberships.companyId, mk), eq(companyMemberships.principalId, demoted)));
      const c = await request(t.server).post(`/api/companies/${mk}/batches/${p.body.batchId}/confirm`).set(headers).send({ handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
      expect(c.status).toBe(403);
      expect((await t.db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, agent.id)))[0]!.revision).toBe(1);
    });

    it("is not available off-profile, refuses members, and never takes another company's template", async () => {
      const tpl = await template();
      const agent = await governed("Scoped");
      const off = await preview(owner, [randomUUID()], tpl.id, plain);
      expect(off.status).toBe(404);
      expect(off.body.error).toBe("Agent ceilings are not available in this workspace.");
      expect((await preview(member, [agent.id], tpl.id)).status).toBe(403);
      const theirs = (await t.db.insert(agentCeilingTemplates).values({ companyId: elsewhere, name: `Theirs ${randomUUID().slice(0, 4)}`, ceiling: TIGHT }).returning())[0]!;
      const foreign = await preview(owner, [agent.id], theirs.id);
      expect(foreign.body.batchId).toBeNull();
      expect(foreign.body.notDecidable[0]).toMatchObject({ reasonCode: "template_gone" });
    });
  });

  describe("choosing new stewards when removing a member", () => {
    async function memberWithAgents(count: number) {
      const userId = await addUser(t.db, mk, "member");
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const agent = await addAgent(t.db, mk, { name: `Theirs ${i} ${randomUUID().slice(0, 4)}`, status: "idle", runtimeConfig: NO_RUN });
        ids.push(agent.id);
      }
      if (count > 0) await t.db.insert(agentStewardships).values({ companyId: mk, agentId: ids[0]!, userId, assignedByUserId: ownerId });
      const [membership] = await t.db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, mk), eq(companyMemberships.principalId, userId)));
      return { userId, memberId: membership!.id, agentIds: ids };
    }

    it("lists the member's agents for admins only", async () => {
      const leaving = await memberWithAgents(1);
      const res = await request(t.server).get(`/api/companies/${mk}/members/${leaving.memberId}/stewarded-agents`).set(owner);
      expect(res.status).toBe(200);
      expect(res.body.agents.map((agent: { id: string }) => agent.id)).toEqual([leaving.agentIds[0]]);
      expect((await request(t.server).get(`/api/companies/${mk}/members/${leaving.memberId}/stewarded-agents`).set(member)).status).toBe(403);
    });

    it("hands the agent to the new steward before the member's access ends, logs it, and removes the member", async () => {
      const leaving = await memberWithAgents(1);
      const heir = await addUser(t.db, mk, "member");
      const res = await request(t.server).post(`/api/companies/${mk}/members/${leaving.memberId}/archive`).set(owner)
        .send({ stewardTransfers: [{ agentId: leaving.agentIds[0], toUserId: heir }] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.stewardTransfers).toEqual([{ agentId: leaving.agentIds[0], toUserId: heir }]);
      const rows = await t.db.select().from(agentStewardships).where(eq(agentStewardships.agentId, leaving.agentIds[0]!));
      expect(rows.find((row) => !row.endedAt)!.userId).toBe(heir);
      const logged = await t.db.select().from(activityLog).where(and(eq(activityLog.action, "agent.stewardship_transferred"), eq(activityLog.agentId, leaving.agentIds[0]!)));
      expect(logged.length).toBeGreaterThanOrEqual(1);
      const [membership] = await t.db.select({ status: companyMemberships.status }).from(companyMemberships).where(eq(companyMemberships.id, leaving.memberId));
      expect(membership!.status).toBe("archived");
    });

    it("a person already looking after an agent, or chosen twice, is refused plainly and nothing changes", async () => {
      const leaving = await memberWithAgents(1);
      const busy = await memberWithAgents(1);
      const res = await request(t.server).post(`/api/companies/${mk}/members/${leaving.memberId}/archive`).set(owner)
        .send({ stewardTransfers: [{ agentId: leaving.agentIds[0], toUserId: busy.userId }] });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/A person can look after only one agent/);
      const twice = await request(t.server).post(`/api/companies/${mk}/members/${leaving.memberId}/archive`).set(owner)
        .send({ stewardTransfers: [{ agentId: leaving.agentIds[0], toUserId: ownerId }, { agentId: randomUUID(), toUserId: ownerId }] });
      expect(twice.status).toBe(400);
      const [membership] = await t.db.select({ status: companyMemberships.status }).from(companyMemberships).where(eq(companyMemberships.id, leaving.memberId));
      expect(membership!.status).toBe("active");
    });

    it("refuses someone without agent management, and an agent that is not the member's", async () => {
      const leaving = await memberWithAgents(1);
      const other = await addAgent(t.db, mk, { name: "Not theirs", status: "idle", runtimeConfig: NO_RUN });
      const heir = await addUser(t.db, mk, "member");
      const notTheirs = await request(t.server).post(`/api/companies/${mk}/members/${leaving.memberId}/archive`).set(owner)
        .send({ stewardTransfers: [{ agentId: other.id, toUserId: heir }] });
      expect(notTheirs.status).toBe(422);
      expect((await request(t.server).post(`/api/companies/${mk}/members/${leaving.memberId}/archive`).set(member)
        .send({ stewardTransfers: [{ agentId: leaving.agentIds[0], toUserId: heir }] })).status).toBe(403);
    });

    it("when removing the member fails after a hand-over, the hand-over stands and the answer says so", async () => {
      // The archive itself fails after the transfer: its open issues are to go
      // to an agent that cannot take them.
      const leaving = await memberWithAgents(1);
      const heir = await addUser(t.db, mk, "member");
      const gone = await addAgent(t.db, mk, { name: "Gone", status: "terminated", runtimeConfig: NO_RUN });
      const res = await request(t.server).post(`/api/companies/${mk}/members/${leaving.memberId}/archive`).set(owner)
        .send({ stewardTransfers: [{ agentId: leaving.agentIds[0], toUserId: heir }], reassignment: { assigneeAgentId: gone.id } });
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(res.body.transferred).toEqual([{ agentId: leaving.agentIds[0], toUserId: heir }]);
      expect(res.body.error).toMatch(/already handed over and stay with their new stewards/);
      const rows = await t.db.select().from(agentStewardships).where(eq(agentStewardships.agentId, leaving.agentIds[0]!));
      expect(rows.find((row) => !row.endedAt)!.userId).toBe(heir);
      const [membership] = await t.db.select({ status: companyMemberships.status }).from(companyMemberships).where(eq(companyMemberships.id, leaving.memberId));
      expect(membership!.status).toBe("active");
      void agents;
    });
  });
});
