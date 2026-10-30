import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentGovernancePolicies, agents, companies, createDb } from "@paperclipai/db";
import { DEFAULT_AGENT_GOVERNANCE_POLICY } from "@paperclipai/shared";
import {
  checkAgentAccess,
  checkAgentAccessAll,
  connectorSendAccessChecks,
  createAgentAccessCheckCache,
  getAgentAccessEnforcementMode,
  loadAgentAccessV2Context,
} from "../services/agent-access-check.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { buildAgentAccessInventory, loadAgentAccessInventoryInput } from "../services/agent-access-inventory.js";
import { viewerProjectScope } from "../services/agent-performance-authz.js";
import { projects } from "@paperclipai/db";
import type { Request } from "express";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { addAgent, addUser, boardActor, seedProfileCompany } from "./helpers/agent-profile-fixtures.js";
import { activityRows, setAccessMode, setAccessPolicy, wouldRefuseRows } from "./helpers/agent-access-fixtures.js";

/**
 * AgentDash: APM gate 2 (P2.3) — `checkAgentAccess`, the one helper every
 * access LLD §4 matrix row calls, and the governance write integration
 * (`access.policy_changed`, V1-shaped writes keep V2).
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("checkAgentAccess (APM gate 2, P2.3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-check-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const projectCheck = (companyId: string, agentId: string, projectId: string | null = randomUUID()) => ({
    companyId,
    agentId,
    dimension: "see.projects" as const,
    target: { projectId },
  });

  it("off: allows without evaluating or logging, even when V2 would refuse", async () => {
    const s = await seedProfileCompany(db, "default");
    await setAccessPolicy(db, s.company.id, s.analyst.id, { request: { see: { projects: { mode: "listed", ids: [] } } } });
    expect(await getAgentAccessEnforcementMode(db, s.company.id)).toBe("off");
    expect(await checkAgentAccess(db, projectCheck(s.company.id, s.analyst.id), { site: "visibility.project_read" })).toBe("allow");
    expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
  });

  it("shadow: a refusal answers would_refuse and logs { dimension, rule, target, site }", async () => {
    const s = await seedProfileCompany(db, "default");
    await setAccessMode(db, s.company.id, "shadow");
    await setAccessPolicy(db, s.company.id, s.analyst.id, { request: { see: { projects: { mode: "listed", ids: [] } } } });
    const projectId = randomUUID();
    const outcome = await checkAgentAccess(db, projectCheck(s.company.id, s.analyst.id, projectId), { site: "heartbeat.run_claim" });
    expect(outcome).toBe("would_refuse");
    const rows = await wouldRefuseRows(db, s.company.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "agent", actorId: s.analyst.id, agentId: s.analyst.id, entityType: "agent", entityId: s.analyst.id });
    expect(rows[0]!.details).toMatchObject({
      dimension: "see.projects",
      // `<dimension>:<reason>`: the dotted form reads as a JWT to the activity redaction.
      rule: "see.projects:not_listed",
      reason: "not_listed",
      target: { projectId },
      site: "heartbeat.run_claim",
      side: "request",
      policyMode: "shadow",
    });
  });

  it("shadow: allows (no row) when the target is in scope, when no policy is stored, and for a project-less issue", async () => {
    const s = await seedProfileCompany(db, "default");
    await setAccessMode(db, s.company.id, "shadow");
    const projectId = randomUUID();
    await setAccessPolicy(db, s.company.id, s.analyst.id, { request: { see: { projects: { mode: "listed", ids: [projectId] } } } });
    expect(await checkAgentAccess(db, projectCheck(s.company.id, s.analyst.id, projectId))).toBe("allow");
    expect(await checkAgentAccess(db, projectCheck(s.company.id, s.analyst.id, null))).toBe("allow");
    expect(await checkAgentAccess(db, projectCheck(s.company.id, s.autonomous.id))).toBe("allow");
    expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
  });

  it("enforce (not selectable in gate 2): the branch answers refuse and records authz.refused", async () => {
    const s = await seedProfileCompany(db, "default");
    await setAccessMode(db, s.company.id, "enforce");
    await setAccessPolicy(db, s.company.id, s.analyst.id, { ceiling: { do: { skills: { mode: "listed", ids: [] } } } });
    const outcome = await checkAgentAccess(
      db,
      { companyId: s.company.id, agentId: s.analyst.id, dimension: "do.skills", target: { skillKey: "x/y" } },
      { site: "agents.skill_sync" },
    );
    expect(outcome).toBe("refuse");
    const [row] = await activityRows(db, s.company.id, "authz.refused");
    expect(row?.details).toMatchObject({ dimension: "do.skills", site: "agents.skill_sync", side: "ceiling", policyMode: "enforce" });
  });

  it("is company-scoped: another company's agent id has no policy here", async () => {
    const a = await seedProfileCompany(db, "default");
    const b = await seedProfileCompany(db, "default");
    await setAccessMode(db, a.company.id, "shadow");
    await setAccessPolicy(db, b.company.id, b.analyst.id, { request: { see: { projects: { mode: "listed", ids: [] } } } });
    expect(await checkAgentAccess(db, projectCheck(a.company.id, b.analyst.id))).toBe("allow");
    expect(await wouldRefuseRows(db, a.company.id)).toHaveLength(0);
  });

  it("an unreadable stored side is no restriction, never a refusal", async () => {
    const s = await seedProfileCompany(db, "default");
    await setAccessMode(db, s.company.id, "shadow");
    await setAccessPolicy(db, s.company.id, s.analyst.id, {});
    await db
      .update(agentGovernancePolicies)
      .set({ stewardRequest: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, see: { projects: { mode: "bogus" } } } as never })
      .where(eq(agentGovernancePolicies.agentId, s.analyst.id));
    expect(await checkAgentAccess(db, projectCheck(s.company.id, s.analyst.id))).toBe("allow");
    expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
  });

  it("never throws into the caller: an internal failure answers allow", async () => {
    const broken = {
      select: () => {
        throw new Error("database is down");
      },
    } as unknown as ReturnType<typeof createDb>;
    await expect(checkAgentAccess(broken, projectCheck(randomUUID(), randomUUID()))).resolves.toBe("allow");
  });

  it("a cache reads the mode once and logs a repeated refusal once per scope", async () => {
    const s = await seedProfileCompany(db, "default");
    await setAccessMode(db, s.company.id, "shadow");
    await setAccessPolicy(db, s.company.id, s.analyst.id, { request: { see: { projects: { mode: "listed", ids: [] } } } });
    const cache = createAgentAccessCheckCache();
    const projectId = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      expect(await checkAgentAccess(db, projectCheck(s.company.id, s.analyst.id, projectId), { site: "visibility.project_read", cache })).toBe("would_refuse");
    }
    expect(cache.modes.size).toBe(1);
    expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(1);
    // A cached mode is per scope: a new scope sees a mode change.
    await setAccessMode(db, s.company.id, "off");
    expect(await checkAgentAccess(db, projectCheck(s.company.id, s.analyst.id, projectId), { cache })).toBe("would_refuse");
    expect(await checkAgentAccess(db, projectCheck(s.company.id, s.analyst.id, projectId), { cache: createAgentAccessCheckCache() })).toBe("allow");
  });

  it("evaluates contact predicates from the live reportsTo chain and the escalation contacts", async () => {
    const s = await seedProfileCompany(db, "default");
    await setAccessMode(db, s.company.id, "shadow");
    const report = await addAgent(db, s.company.id, { name: "Report", reportsTo: s.analyst.id });
    const context = await loadAgentAccessV2Context(db, { companyId: s.company.id, agentId: s.analyst.id });
    expect(context.reportsChain).toEqual({ managerAgentIds: [s.chief.id], directReportAgentIds: [report.id] });
    expect(context.escalation.adminUserIds).toEqual([s.ownerUserId]);

    await setAccessPolicy(db, s.company.id, s.analyst.id, {
      request: { talk: { agents: { mode: "reports_chain", via: ["assign"] }, people: { mode: "listed", userIds: [] } } },
    });
    const talk = (agentId: string) =>
      checkAgentAccess(db, { companyId: s.company.id, agentId: s.analyst.id, dimension: "talk.agents", target: { agentId }, via: "assign" });
    expect(await talk(s.chief.id)).toBe("allow");
    expect(await talk(report.id)).toBe("allow");
    expect(await talk(s.autonomous.id)).toBe("would_refuse");
    // A different channel than the scope allows.
    expect(
      await checkAgentAccess(db, { companyId: s.company.id, agentId: s.analyst.id, dimension: "talk.agents", target: { agentId: s.chief.id }, via: "mention" }),
    ).toBe("would_refuse");
    // The escalation path is always open; an outsider is not.
    const people = (userId: string) =>
      checkAgentAccess(db, { companyId: s.company.id, agentId: s.analyst.id, dimension: "talk.people", target: { userId, purpose: "question" } });
    expect(await people(s.ownerUserId)).toBe("allow");
    expect(await people(s.outsiderUserId)).toBe("would_refuse");
  });

  it("talk.inbound never blocks a person with configuration authority over the agent", async () => {
    const s = await seedProfileCompany(db, "default");
    await setAccessMode(db, s.company.id, "shadow");
    const creator = await addUser(db, s.company.id, "member");
    const created = await addAgent(db, s.company.id, { name: "Created", createdByUserId: creator });
    await setAccessPolicy(db, s.company.id, created.id, { request: { talk: { inbound: { mode: "listed", agentIds: [], userIds: [] } } } });
    const inbound = (userId: string) =>
      checkAgentAccess(db, { companyId: s.company.id, agentId: created.id, dimension: "talk.inbound", target: { kind: "user", userId }, via: "assign" });
    expect(await inbound(s.ownerUserId)).toBe("allow"); // admin
    expect(await inbound(creator)).toBe("allow"); // its creator
    expect(await inbound(s.outsiderUserId)).toBe("would_refuse");
    const [row] = await wouldRefuseRows(db, s.company.id);
    // The attempt is attributed to its source; the row belongs to the agent whose scope refused.
    expect(row).toMatchObject({ actorType: "user", actorId: s.outsiderUserId, agentId: created.id });
  });

  it("bridge tasks: steward or accountable machines only, always — even with no stored policy", async () => {
    const s = await seedProfileCompany(db, "agentdash_mk");
    await setAccessMode(db, s.company.id, "shadow");
    const bridge = (agentId: string, userId: string) =>
      checkAgentAccess(db, { companyId: s.company.id, agentId, dimension: "talk.people", target: { userId, purpose: "bridge_task" } }, { site: "bridge.task" });
    expect(await bridge(s.analyst.id, s.stewardUserId)).toBe("allow");
    expect(await bridge(s.autonomous.id, s.accountableUserId)).toBe("allow");
    expect(await bridge(s.analyst.id, s.ownerUserId)).toBe("would_refuse");
    const [row] = await wouldRefuseRows(db, s.company.id, "bridge.task");
    expect(row?.details).toMatchObject({ rule: "talk.people:bridge_owner_only", side: "fixed" });
  });

  it("connector_send: V2 adds only `never` on the approval path, and checks every external target", async () => {
    const s = await seedProfileCompany(db, "agentdash_mk");
    await setAccessMode(db, s.company.id, "shadow");
    const connectionId = randomUUID();
    await setAccessPolicy(db, s.company.id, s.analyst.id, {
      request: {
        do: { connections: [{ connectionId, draft: "approve", send: "approve" }] },
        talk: { external: [{ connectionId, targets: { mode: "domains", values: ["example.test"] } }] },
      },
    });
    const allowed = connectorSendAccessChecks({ companyId: s.company.id, agentId: s.analyst.id, connectionId, properties: { email: "a@example.test" } });
    expect(allowed.inputs.map((input) => input.dimension)).toEqual(["do.connections", "talk.external"]);
    expect(await checkAgentAccessAll(db, allowed.inputs, { site: "connector_send.create", context: allowed.context })).toBe("allow");
    const outside = connectorSendAccessChecks({ companyId: s.company.id, agentId: s.analyst.id, connectionId, properties: { email: "a@elsewhere.test" } });
    expect(await checkAgentAccessAll(db, outside.inputs, { site: "connector_send.create", context: outside.context })).toBe("would_refuse");
    expect((await wouldRefuseRows(db, s.company.id)).map((row) => (row.details as { rule: string }).rule)).toEqual(["talk.external:domain_not_listed"]);
  });

  it("MK: shadow changes nothing the legacy policy decides (resolveAgentPolicy is untouched)", async () => {
    const s = await seedProfileCompany(db, "agentdash_mk");
    const governance = agentGovernanceService(db);
    const before = await governance.resolveAgentPolicy(s.company.id, s.analyst.id);
    await setAccessMode(db, s.company.id, "shadow");
    await setAccessPolicy(db, s.company.id, s.analyst.id, { request: { see: { projects: { mode: "listed", ids: [] } } } });
    expect(await governance.resolveAgentPolicy(s.company.id, s.analyst.id)).toEqual(before);
  });
});

describeEmbeddedPostgres("access inventory shadow summary (APM gate 2, P2.3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-shadow-summary-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("counts would-be refusals by dimension, lists the newest with labels, and hides projects the viewer can't see", async () => {
    const s = await seedProfileCompany(db, "default");
    const [open, restricted] = await db
      .insert(projects)
      .values([
        { companyId: s.company.id, name: "Open work" },
        { companyId: s.company.id, name: "Board only", visibility: "restricted" },
      ])
      .returning();
    await setAccessPolicy(db, s.company.id, s.analyst.id, {
      request: { see: { projects: { mode: "listed", ids: [] } }, talk: { agents: { mode: "listed", agentIds: [], via: ["assign"] } } },
    });

    // Off: no summary at all.
    const offInput = await loadAgentAccessInventoryInput(db, { companyId: s.company.id, agentId: s.analyst.id });
    expect(buildAgentAccessInventory(offInput!).shadow).toBeNull();

    await setAccessMode(db, s.company.id, "shadow");
    for (const projectId of [open!.id, restricted!.id]) {
      await checkAgentAccess(
        db,
        { companyId: s.company.id, agentId: s.analyst.id, dimension: "see.projects", target: { projectId } },
        { site: "heartbeat.run_claim" },
      );
    }
    await checkAgentAccess(
      db,
      { companyId: s.company.id, agentId: s.analyst.id, dimension: "talk.agents", target: { agentId: s.autonomous.id }, via: "assign" },
      { site: "wake.dispatch" },
    );

    // The window ends at the read; read a moment later than the rows were written
    // (row timestamps carry microseconds, the window's end milliseconds).
    const asOf = new Date(Date.now() + 1000);
    const all = buildAgentAccessInventory((await loadAgentAccessInventoryInput(db, { companyId: s.company.id, agentId: s.analyst.id, asOf }))!);
    expect(all.shadow).toMatchObject({ wouldRefuseTotal: 3, byDimension: { "see.projects": 2, "talk.agents": 1 } });
    expect(all.shadow!.recent[0]).toMatchObject({ dimension: "talk.agents", rule: "talk.agents.not_listed", site: "wake.dispatch", targetLabel: "Solo" });
    expect(all.shadow!.recent.map((row) => row.targetLabel)).toEqual(["Solo", "Board only", "Open work"]);

    // A plain member can't see the restricted project: its row is not counted or listed.
    const memberReq = { actor: boardActor(s.company.id, s.outsiderUserId) } as unknown as Request;
    const member = buildAgentAccessInventory(
      (await loadAgentAccessInventoryInput(db, { companyId: s.company.id, agentId: s.analyst.id, asOf, viewer: viewerProjectScope(memberReq, s.company.id) }))!,
    );
    expect(member.shadow).toMatchObject({ wouldRefuseTotal: 2, byDimension: { "see.projects": 1, "talk.agents": 1 } });
    expect(member.shadow!.recent.map((row) => row.targetLabel)).toEqual(["Solo", "Open work"]);
    // Shadow refuses nothing: the enforced summary is present and empty.
    expect(all.enforced).toEqual({ refusedTotal: 0, recent: [] });
  });

  it("P3.7: lists what enforce refused, labelled like shadow, kept apart from would-be refusals, hiding projects the viewer can't see", async () => {
    const s = await seedProfileCompany(db, "default");
    const [open, restricted] = await db
      .insert(projects)
      .values([
        { companyId: s.company.id, name: "Open work" },
        { companyId: s.company.id, name: "Board only", visibility: "restricted" },
      ])
      .returning();
    await setAccessPolicy(db, s.company.id, s.analyst.id, {
      request: { see: { projects: { mode: "listed", ids: [] } }, talk: { agents: { mode: "listed", agentIds: [], via: ["assign"] } } },
    });
    const offInput = await loadAgentAccessInventoryInput(db, { companyId: s.company.id, agentId: s.analyst.id });
    expect(buildAgentAccessInventory(offInput!).enforced).toBeNull();

    // One would-be refusal while in shadow, then three refusals once enforced.
    await setAccessMode(db, s.company.id, "shadow");
    await checkAgentAccess(db, { companyId: s.company.id, agentId: s.analyst.id, dimension: "see.projects", target: { projectId: open!.id } }, { site: "heartbeat.run_claim" });
    await setAccessMode(db, s.company.id, "enforce");
    for (const projectId of [open!.id, restricted!.id]) {
      expect(
        await checkAgentAccess(db, { companyId: s.company.id, agentId: s.analyst.id, dimension: "see.projects", target: { projectId } }, { site: "heartbeat.run_claim" }),
      ).toBe("refuse");
    }
    await checkAgentAccess(
      db,
      { companyId: s.company.id, agentId: s.analyst.id, dimension: "talk.agents", target: { agentId: s.autonomous.id }, via: "assign" },
      { site: "wake.dispatch" },
    );

    const asOf = new Date(Date.now() + 1000);
    const all = buildAgentAccessInventory((await loadAgentAccessInventoryInput(db, { companyId: s.company.id, agentId: s.analyst.id, asOf }))!);
    expect(all.enforced!.refusedTotal).toBe(3);
    expect(all.enforced!.recent[0]).toMatchObject({ dimension: "talk.agents", rule: "talk.agents.not_listed", site: "wake.dispatch", targetLabel: "Solo" });
    expect(all.enforced!.recent.map((row) => row.targetLabel)).toEqual(["Solo", "Board only", "Open work"]);
    expect(all.shadow!.wouldRefuseTotal).toBe(1); // the shadow-era row stays a would-be refusal

    const memberReq = { actor: boardActor(s.company.id, s.outsiderUserId) } as unknown as Request;
    const member = buildAgentAccessInventory(
      (await loadAgentAccessInventoryInput(db, { companyId: s.company.id, agentId: s.analyst.id, asOf, viewer: viewerProjectScope(memberReq, s.company.id) }))!,
    );
    expect(member.enforced!.refusedTotal).toBe(2);
    expect(member.enforced!.recent.map((row) => row.targetLabel)).toEqual(["Solo", "Open work"]);
    expect(JSON.stringify(member.enforced)).not.toContain("Board only");
  });
});

describeEmbeddedPostgres("governance writes (APM gate 2, P2.3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-governance-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function storedRow(agentId: string) {
    return db
      .select()
      .from(agentGovernancePolicies)
      .where(eq(agentGovernancePolicies.agentId, agentId))
      .then((rows) => rows[0]!);
  }

  it("a V1-shaped request write keeps the V2 dimensions and logs access.policy_changed as a steward edit", async () => {
    const s = await seedProfileCompany(db, "agentdash_mk");
    const v2 = { see: { projects: { mode: "listed" as const, ids: ["p1"] } } };
    await setAccessPolicy(db, s.company.id, s.analyst.id, { request: v2 });
    const governance = agentGovernanceService(db);
    const current = await governance.getForAgent(s.company.id, s.analyst.id);
    await governance.updateStewardRequest(s.company.id, s.analyst.id, {
      policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, monthlyBudgetCents: 5000 },
      revision: current.revision,
      actorUserId: s.stewardUserId,
    });
    const row = await storedRow(s.analyst.id);
    expect(row.stewardRequest).toMatchObject({ monthlyBudgetCents: 5000, policyVersion: 2, see: v2.see });
    const [changed] = await activityRows(db, s.company.id, "access.policy_changed");
    expect(changed?.details).toMatchObject({
      source: "steward_request_edit",
      target: "steward_request",
      changed: ["monthlyBudgetCents"],
      v2Dimensions: ["see.projects"],
    });
  });

  it("a ceiling write is an admin ceiling edit; a no-op write and the profile's own write log nothing", async () => {
    const s = await seedProfileCompany(db, "agentdash_mk");
    const governance = agentGovernanceService(db);
    let current = await governance.materialize(s.company.id, s.analyst.id);
    await governance.updateOwnerCeiling(s.company.id, s.analyst.id, {
      policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, providers: ["hubspot"] },
      revision: current.revision,
      actorUserId: s.ownerUserId,
    });
    current = await governance.materialize(s.company.id, s.analyst.id);
    // Same values again: a write, but no access change.
    await governance.updateOwnerCeiling(s.company.id, s.analyst.id, {
      policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, providers: ["hubspot"] },
      revision: current.revision,
      actorUserId: s.ownerUserId,
    });
    current = await governance.materialize(s.company.id, s.analyst.id);
    await governance.updateStewardRequest(s.company.id, s.analyst.id, {
      policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, providers: ["hubspot"], policyVersion: 2, do: { skills: { mode: "listed", ids: [] } } },
      revision: current.revision,
      actorUserId: s.ownerUserId,
      channel: "system",
      source: "profile_application",
    });
    const rows = await activityRows(db, s.company.id, "access.policy_changed");
    expect(rows.map((row) => (row.details as { source: string }).source)).toEqual(["admin_ceiling_edit"]);
    expect((await storedRow(s.analyst.id)).stewardRequest).toMatchObject({ do: { skills: { mode: "listed", ids: [] } } });
  });

  it("a harness push is recorded as harness narrowing", async () => {
    const s = await seedProfileCompany(db, "agentdash_mk");
    const governance = agentGovernanceService(db);
    await governance.pushHarnessStewardRequest(s.company.id, s.analyst.id, {
      policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, permissions: [] },
      actorUserId: s.stewardUserId,
    });
    const [row] = await activityRows(db, s.company.id, "access.policy_changed");
    expect(row?.details).toMatchObject({ source: "harness_narrowing", changed: ["permissions"] });
  });

  it("a V1 row written through the legacy path stays V1 (no policyVersion, no V2 keys)", async () => {
    const s = await seedProfileCompany(db, "agentdash_mk");
    const governance = agentGovernanceService(db);
    const current = await governance.materialize(s.company.id, s.analyst.id);
    await governance.updateStewardRequest(s.company.id, s.analyst.id, {
      policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, dataScopes: ["crm"] },
      revision: current.revision,
      actorUserId: s.stewardUserId,
    });
    const request = (await storedRow(s.analyst.id)).stewardRequest as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["dataScopes", "destructiveActions", "minimumApproval", "monthlyBudgetCents", "permissions", "providers"]);
    void agents;
  });
});
