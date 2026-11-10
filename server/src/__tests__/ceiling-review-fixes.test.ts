import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Fix 1's failure injection: the company default ceiling write throws while
// `failDefaultCeiling` is set; otherwise the real service runs.
const injection = vi.hoisted(() => ({ failDefaultCeiling: false }));
vi.mock("../services/agent-governance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-governance.js")>();
  return {
    ...actual,
    agentGovernanceService: (db: Parameters<typeof actual.agentGovernanceService>[0]) => {
      const real = actual.agentGovernanceService(db);
      return {
        ...real,
        applyCompanyDefaultCeiling: async (companyId: string, agentId: string) => {
          const policy = await real.applyCompanyDefaultCeiling(companyId, agentId);
          if (injection.failDefaultCeiling) throw new Error("injected: the default ceiling write failed");
          return policy;
        },
      };
    },
  };
});

import {
  agentCeilingTemplates,
  agentGovernancePolicies,
  agents,
  companies,
} from "@paperclipai/db";
import { DEFAULT_AGENT_GOVERNANCE_POLICY, type AgentGovernancePolicy } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser } from "./helpers/agent-profile-fixtures.js";
import { startBatchTestApp, type BatchTestApp } from "./helpers/batch-test-app.js";
import { agentService } from "../services/agents.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";
import { ceilingTemplateService } from "../services/ceiling-templates.js";
import { companyService } from "../services/companies.js";

/**
 * Review of 94b9e03ee (round 3c), the three fixes, each with a regression
 * test that fails on that commit:
 * 1. a new agent and its company default ceiling are written in one
 *    transaction (a failed ceiling write leaves no agent);
 * 2. "make this template the default" and "delete this template" serialize on
 *    the company row, so the FK's ON DELETE SET NULL never clears a default
 *    silently (both interleavings, forced with row locks);
 * 3. the ceiling refusals say what is checked (permission to manage agents).
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const FAKE = "ceiling_fixes_fake";
const NO_RUN = { heartbeat: { enabled: false, wakeOnDemand: false } };
const TIGHT: AgentGovernancePolicy = {
  permissions: ["tasks:assign"],
  monthlyBudgetCents: 50_000,
  destructiveActions: "approval_required",
  dataScopes: ["*"],
  providers: ["slack"],
  minimumApproval: "steward",
};

describeEmbeddedPostgres("round 3c review fixes", () => {
  let t!: BatchTestApp;
  let mk = "";
  let owner: Record<string, string> = {};
  let member: Record<string, string> = {};

  beforeAll(async () => {
    registerServerAdapter({
      type: FAKE,
      models: [],
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "fake" }),
      testEnvironment: async () => ({ adapterType: FAKE, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    } as never);
    t = await startBatchTestApp("paperclip-ceiling-fixes-");
    mk = (await addCompany(t.db, "Fixes", "agentdash_mk")).id;
    owner = t.browser(await t.signIn(await addUser(t.db, mk, "owner")));
    member = t.browser(await t.signIn(await addUser(t.db, mk, "member")));
  }, 120_000);

  afterEach(async () => {
    injection.failDefaultCeiling = false;
    await t.db.update(companies).set({ defaultCeilingTemplateId: null }).where(eq(companies.id, mk));
  });

  afterAll(async () => {
    await t?.close();
    unregisterServerAdapter(FAKE);
  });

  async function newTemplate() {
    const [row] = await t.db.insert(agentCeilingTemplates).values({ companyId: mk, name: `T ${randomUUID().slice(0, 6)}`, ceiling: TIGHT }).returning();
    return row!;
  }
  const agentsNamed = (name: string) => t.db.select().from(agents).where(and(eq(agents.companyId, mk), eq(agents.name, name)));
  const defaultOf = async () => (await t.db.select({ id: companies.defaultCeilingTemplateId }).from(companies).where(eq(companies.id, mk)))[0]!.id;

  describe("fix 1: the agent and its default ceiling commit together", () => {
    it("a failed default ceiling write leaves no agent: the funnel, inside a caller's transaction, and the create route", async () => {
      const tpl = await newTemplate();
      await t.db.update(companies).set({ defaultCeilingTemplateId: tpl.id }).where(eq(companies.id, mk));
      injection.failDefaultCeiling = true;
      try {
        const input = { name: "Funnel hire", role: "general", adapterType: "process", adapterConfig: {}, runtimeConfig: NO_RUN, status: "idle" } as never;
        await expect(agentService(t.db).create(mk, input)).rejects.toThrow(/injected/);
        expect(await agentsNamed("Funnel hire")).toHaveLength(0);

        await expect(t.db.transaction(async (tx) => {
          await agentService(tx as never).create(mk, { ...(input as object), name: "Joined hire" } as never, { executor: tx as never, publications: [] });
        })).rejects.toThrow(/injected/);
        expect(await agentsNamed("Joined hire")).toHaveLength(0);

        const viaRoute = await request(t.server).post(`/api/companies/${mk}/agents`).set(owner)
          .send({ name: "Route hire", role: "general", adapterType: FAKE, adapterConfig: {}, runtimeConfig: NO_RUN });
        expect(viaRoute.status, JSON.stringify(viaRoute.body)).toBeGreaterThanOrEqual(500);
        expect(await agentsNamed("Route hire")).toHaveLength(0);
      } finally {
        injection.failDefaultCeiling = false;
      }
      // And the success path still writes both.
      const ok = await agentService(t.db).create(mk, { name: "Good hire", role: "general", adapterType: "process", adapterConfig: {}, runtimeConfig: NO_RUN, status: "idle" } as never);
      const [policy] = await t.db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, ok.id));
      expect(policy!.effectivePolicy).toMatchObject({ monthlyBudgetCents: 50_000, providers: ["slack"] });
      await t.db.update(companies).set({ defaultCeilingTemplateId: null }).where(eq(companies.id, mk));
    });
  });

  describe("fix 2: setting the default and deleting the template cannot interleave", () => {
    /** Backends of this database waiting on a lock right now. */
    async function lockWaiters(): Promise<number> {
      const rows = await t.db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
      return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
    }
    async function until(check: () => Promise<boolean>, what: string) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${what}`);
    }
    /** Hold a row lock on the template from another transaction until released. */
    function holdTemplateLock(templateId: string, strength: "for update" | "for no key update") {
      let release!: () => void;
      let held!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const isHeld = new Promise<void>((resolve) => { held = resolve; });
      const done = t.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`select id from agent_ceiling_templates where id = '${templateId}' ${strength}`));
        held();
        await released;
      });
      return { isHeld, release: async () => { release(); await done; } };
    }
    const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

    it("delete in flight, then 'make it the default': the default is refused, never silently cleared", async () => {
      const tpl = await newTemplate();
      // The delete passes its check, then waits at its DELETE (a NO KEY
      // UPDATE lock elsewhere blocks a delete but not the FK check of a
      // concurrent default write).
      const gate = holdTemplateLock(tpl.id, "for no key update");
      await gate.isHeld;
      const removing = settle(ceilingTemplateService(t.db).remove(mk, tpl.id));
      await until(async () => (await lockWaiters()) >= 1, "the delete to wait");
      let setDone = false;
      const setting = settle(companyService(t.db).update(mk, { defaultCeilingTemplateId: tpl.id })).finally(() => { setDone = true; });
      // Fixed: the default write waits for the company row the delete holds.
      // Before the fix it did not wait at all and committed right away.
      await until(async () => setDone || (await lockWaiters()) >= 2, "the default write to wait or finish");
      await gate.release();
      const [removed, set] = await Promise.all([removing, setting]);
      expect(removed.ok).toBe(true);
      expect(set.ok).toBe(false);
      expect(String((set as { error: unknown }).error)).toMatch(/not one of this company's templates/);
      expect(await defaultOf()).toBeNull();
      expect(await t.db.select().from(agentCeilingTemplates).where(eq(agentCeilingTemplates.id, tpl.id))).toHaveLength(0);
    });

    it("'make it the default' in flight, then delete: the delete is refused and the default stands", async () => {
      const tpl = await newTemplate();
      // The default write waits after taking the company lock (fixed) or at
      // its FK check (before the fix): a FOR UPDATE lock blocks both.
      const gate = holdTemplateLock(tpl.id, "for update");
      await gate.isHeld;
      const setting = settle(companyService(t.db).update(mk, { defaultCeilingTemplateId: tpl.id }));
      await until(async () => (await lockWaiters()) >= 1, "the default write to wait");
      const removing = settle(ceilingTemplateService(t.db).remove(mk, tpl.id));
      await until(async () => (await lockWaiters()) >= 2, "the delete to wait");
      await gate.release();
      const [set, removed] = await Promise.all([setting, removing]);
      expect(set.ok).toBe(true);
      expect(removed.ok).toBe(false);
      expect(String((removed as { error: unknown }).error)).toMatch(/ceiling for new agents/);
      expect(await defaultOf()).toBe(tpl.id);
      expect(await t.db.select().from(agentCeilingTemplates).where(eq(agentCeilingTemplates.id, tpl.id))).toHaveLength(1);
      await t.db.update(companies).set({ defaultCeilingTemplateId: null }).where(eq(companies.id, mk));
    });
  });

  describe("fix 3: the ceiling refusals say what is checked", () => {
    it("the route and the batch kind both say 'You need permission to manage agents'", async () => {
      const agent = await addAgent(t.db, mk, { name: `Worded ${randomUUID().slice(0, 4)}`, status: "idle", runtimeConfig: NO_RUN });
      const route = await request(t.server).put(`/api/companies/${mk}/agents/${agent.id}/governance/ceiling`).set(member)
        .send({ policy: DEFAULT_AGENT_GOVERNANCE_POLICY, revision: 1 });
      expect(route.status).toBe(403);
      expect(route.body.error).toBe("You need permission to manage agents to change agent policy ceilings.");
      const tpl = await newTemplate();
      const batch = await request(t.server).post(`/api/companies/${mk}/batches/preview`).set(member)
        .send({ kind: "agent.apply_ceiling", ids: [agent.id], change: { templateId: tpl.id } });
      expect(batch.status).toBe(403);
      expect(batch.body.error).toBe("You need permission to manage agents to change agent policy ceilings.");
      expect(JSON.stringify([route.body, batch.body])).not.toMatch(/owner or administrator/);
    });
  });
});
