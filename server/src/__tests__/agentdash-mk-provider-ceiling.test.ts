import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentGovernancePolicies,
  agentStewardships,
  agents,
  channelCallbackTokens,
  companies,
  approvals,
  companyMemberships,
  connections,
  createDb,
  humanChannelBindings,
} from "@paperclipai/db";
import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  type AgentGovernancePolicy,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { approvalAuthorityService } from "../services/approval-authority.js";
import { connectorService } from "../services/connectors.js";
import { humanChannelService } from "../services/human-channels.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

/**
 * AgentDash-MK criterion 5, the two dimensions that were computed and stored
 * but had no runtime consumer.
 *
 * `providers` and `dataScopes` were inert: `assertAgentMutationWithinCeiling`
 * was never called with either, so an owner could narrow them and nothing
 * downstream would notice. A ceiling that no enforcement point reads is a
 * setting, not a control. These tests are the enforcement points.
 */
describeEmbeddedPostgres("agentdash-mk provider and data-scope ceilings", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-provider-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(channelCallbackTokens);
    await db.delete(humanChannelBindings);
    await db.delete(connections);
    await db.delete(agentGovernancePolicies);
    await db.delete(agentStewardships);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(profile: "agentdash_mk" | "default" = "agentdash_mk") {
    return db
      .insert(companies)
      .values({
        name: `Ceiling ${randomUUID()}`,
        issuePrefix: `CL${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: profile,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createAgent(companyId: string) {
    return db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createConnection(
    companyId: string,
    agentId: string,
    input: { provider: string; scopes?: string[]; visibility?: string },
  ) {
    return db
      .insert(connections)
      .values({
        companyId,
        ownerType: "agent",
        ownerId: agentId,
        provider: input.provider,
        scopes: input.scopes ?? [],
        visibility: input.visibility ?? "private",
        status: "active",
        autonomy: { read: "full", draft: "full", send: "draft_only" },
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** Materialize a ceiling by writing it through the service, as a route would. */
  async function setCeiling(
    companyId: string,
    agentId: string,
    overrides: Partial<AgentGovernancePolicy>,
  ) {
    const svc = agentGovernanceService(db);
    const current = await svc.getForAgent(companyId, agentId);
    return svc.updateOwnerCeiling(companyId, agentId, {
      policy: {
        permissions: [AGENT_POLICY_WILDCARD],
        monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
        destructiveActions: "approval_required",
        dataScopes: [AGENT_POLICY_WILDCARD],
        providers: [AGENT_POLICY_WILDCARD],
        minimumApproval: "steward",
        ...overrides,
      },
      revision: current.revision,
      actorUserId: "owner-1",
      channel: "web",
    });
  }

  describe("providers", () => {
    it("refuses a provider the owner ceiling does not allow", async () => {
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await createConnection(company.id, agent.id, { provider: "hubspot" });
      await setCeiling(company.id, agent.id, { providers: ["telegram"] });

      const result = await connectorService(db).resolveActingAs(
        company.id,
        agent.id,
        "read",
        "hubspot",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.blocked.reason).toBe("provider_not_allowed");
    });

    it("refuses before reporting whether a connection exists", async () => {
      // Order matters. If `no_connection` were checked first, a disallowed
      // provider with no connection would answer "no connection available",
      // which reads as "set one up" rather than "you may not use this".
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await setCeiling(company.id, agent.id, { providers: ["telegram"] });

      const result = await connectorService(db).resolveActingAs(
        company.id,
        agent.id,
        "read",
        "hubspot",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.blocked.reason).toBe("provider_not_allowed");
    });

    it("allows a provider the ceiling permits", async () => {
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await createConnection(company.id, agent.id, { provider: "telegram" });
      await setCeiling(company.id, agent.id, { providers: ["telegram"] });

      const result = await connectorService(db).resolveActingAs(
        company.id,
        agent.id,
        "read",
        "telegram",
      );

      expect(result.ok).toBe(true);
    });

    it("leaves default-profile companies unenforced", async () => {
      const company = await createCompany("default");
      const agent = await createAgent(company.id);
      await createConnection(company.id, agent.id, { provider: "hubspot" });
      // Even with a narrow policy row present, a non-profile company must not
      // acquire enforcement it never opted into.
      await db.insert(agentGovernancePolicies).values({
        companyId: company.id,
        agentId: agent.id,
        ownerCeiling: { providers: ["telegram"] },
        stewardRequest: { providers: ["telegram"] },
        effectivePolicy: {
          permissions: [AGENT_POLICY_WILDCARD],
          monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
          destructiveActions: "approval_required",
          dataScopes: [AGENT_POLICY_WILDCARD],
          providers: ["telegram"],
          minimumApproval: "steward",
        },
      });

      const result = await connectorService(db).resolveActingAs(
        company.id,
        agent.id,
        "read",
        "hubspot",
      );

      expect(result.ok).toBe(true);
    });

    it("permits everything under the unrestricted default ceiling", async () => {
      // Enabling the profile must not, by itself, take authority away.
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await createConnection(company.id, agent.id, { provider: "hubspot" });

      const result = await connectorService(db).resolveActingAs(
        company.id,
        agent.id,
        "read",
        "hubspot",
      );

      expect(result.ok).toBe(true);
    });
  });

  describe("dataScopes", () => {
    it("refuses a connection granted more scope than the ceiling allows", async () => {
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await createConnection(company.id, agent.id, {
        provider: "hubspot",
        scopes: ["crm.objects.contacts.read", "crm.objects.deals.write"],
      });
      await setCeiling(company.id, agent.id, {
        dataScopes: ["crm.objects.contacts.read"],
      });

      const result = await connectorService(db).resolveActingAs(
        company.id,
        agent.id,
        "read",
        "hubspot",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.blocked.reason).toBe("data_scope_not_allowed");
    });

    it("prefers a within-ceiling connection over refusing outright", async () => {
      // Refusing when ANY connection is over-scoped would make one over-broad
      // credential disable an otherwise compliant one.
      //
      // Uses `google` rather than `hubspot` on purpose. The filter is
      // provider-agnostic, but HubSpot carries a partial unique index allowing
      // only one active connection per owner, so two agent-owned HubSpot rows
      // cannot coexist. Writing this against HubSpot would couple a general
      // behavior to one provider's uniqueness rule — and it did, until that
      // index landed and broke this test.
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await createConnection(company.id, agent.id, {
        provider: "google",
        scopes: ["drive.readonly", "drive.file"],
      });
      const compliant = await createConnection(company.id, agent.id, {
        provider: "google",
        scopes: ["drive.readonly"],
      });
      await setCeiling(company.id, agent.id, { dataScopes: ["drive.readonly"] });

      const result = await connectorService(db).resolveActingAs(
        company.id,
        agent.id,
        "read",
        "google",
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolution.connectionId).toBe(compliant.id);
    });

    it("treats a connection with no recorded scopes as within any ceiling", async () => {
      // Most existing rows predate scope recording. Failing them closed would
      // turn narrowing dataScopes into an outage for every legacy connection,
      // which is the opposite of an opt-in control.
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await createConnection(company.id, agent.id, { provider: "hubspot", scopes: [] });
      await setCeiling(company.id, agent.id, { dataScopes: ["crm.objects.contacts.read"] });

      const result = await connectorService(db).resolveActingAs(
        company.id,
        agent.id,
        "read",
        "hubspot",
      );

      expect(result.ok).toBe(true);
    });
  });

  describe("channel bindings", () => {
    async function seedSteward(companyId: string, agentId: string, userId: string) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        membershipRole: "operator",
        status: "active",
      });
      await db.insert(agentStewardships).values({
        companyId,
        agentId,
        userId,
        assignedByUserId: "owner-1",
      });
    }

    it("refuses to bind a channel the stewarded agent's ceiling excludes", async () => {
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await seedSteward(company.id, agent.id, "user-1");
      await setCeiling(company.id, agent.id, { providers: ["teams"] });

      await expect(
        humanChannelService(db).verifyBinding(company.id, {
          userId: "user-1",
          provider: "telegram",
          externalUserId: "tg-1",
        }),
      ).rejects.toThrow(/ceiling|not allowed/i);
    });

    it("binds a channel the ceiling permits", async () => {
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await seedSteward(company.id, agent.id, "user-1");
      await setCeiling(company.id, agent.id, { providers: ["telegram"] });

      const binding = await humanChannelService(db).verifyBinding(company.id, {
        userId: "user-1",
        provider: "telegram",
        externalUserId: "tg-1",
      });

      expect(binding.provider).toBe("telegram");
      expect(binding.verifiedAt).not.toBeNull();
    });

    it("revokes existing bindings when the ceiling stops allowing their provider", async () => {
      // A ceiling that only gates NEW bindings is not a ceiling: the standing
      // binding keeps delivering approval cards over the channel the owner
      // just disallowed.
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await seedSteward(company.id, agent.id, "user-1");
      await setCeiling(company.id, agent.id, { providers: ["telegram", "teams"] });
      await humanChannelService(db).verifyBinding(company.id, {
        userId: "user-1",
        provider: "telegram",
        externalUserId: "tg-1",
      });

      await setCeiling(company.id, agent.id, { providers: ["teams"] });

      const stillActive = await db
        .select()
        .from(humanChannelBindings)
        .where(
          and(
            eq(humanChannelBindings.companyId, company.id),
            eq(humanChannelBindings.provider, "telegram"),
            isNull(humanChannelBindings.revokedAt),
          ),
        );
      expect(stillActive).toHaveLength(0);

      const clamped = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "agent.governance_configuration_clamped"));
      expect(
        clamped.some((row) => (row.details as { field?: string } | null)?.field === "channel:telegram"),
      ).toBe(true);
    });

    it("leaves bindings for still-allowed providers alone", async () => {
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await seedSteward(company.id, agent.id, "user-1");
      await setCeiling(company.id, agent.id, { providers: ["telegram", "teams"] });
      await humanChannelService(db).verifyBinding(company.id, {
        userId: "user-1",
        provider: "telegram",
        externalUserId: "tg-1",
      });

      await setCeiling(company.id, agent.id, { providers: ["telegram"] });

      const stillActive = await db
        .select()
        .from(humanChannelBindings)
        .where(
          and(
            eq(humanChannelBindings.companyId, company.id),
            isNull(humanChannelBindings.revokedAt),
          ),
        );
      expect(stillActive).toHaveLength(1);
    });
  });

  describe("pending connector sends", () => {
    async function pendingSend(companyId: string, agentId: string, provider = "hubspot") {
      return db
        .insert(approvals)
        .values({
          companyId,
          type: "connector_send",
          requestedByAgentId: agentId,
          status: "pending",
          payload: { provider, objectType: "contacts", operation: "create", properties: {} },
        })
        .returning()
        .then((rows) => rows[0]!);
    }

    it("cancels a pending write when the ceiling stops allowing its provider", async () => {
      // A pending connector_send is an act waiting for a human. Leaving it
      // decidable after the owner disallowed the provider means the ceiling can
      // be defeated simply by approving something filed before it narrowed.
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await setCeiling(company.id, agent.id, { providers: ["hubspot"] });
      const approval = await pendingSend(company.id, agent.id);

      await setCeiling(company.id, agent.id, { providers: ["telegram"] });

      const stored = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approval.id))
        .then((rows) => rows[0]!);
      expect(stored.status).toBe("cancelled");

      const clamped = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "agent.governance_configuration_clamped"));
      expect(
        clamped.some(
          (row) => (row.details as { field?: string } | null)?.field === "connector_send:hubspot",
        ),
      ).toBe(true);
    });

    it("leaves a pending write for a still-allowed provider alone", async () => {
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await setCeiling(company.id, agent.id, { providers: ["hubspot", "telegram"] });
      const approval = await pendingSend(company.id, agent.id);

      await setCeiling(company.id, agent.id, { providers: ["hubspot"] });

      const stored = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approval.id))
        .then((rows) => rows[0]!);
      expect(stored.status).toBe("pending");
    });

    it("does not touch an already-decided write", async () => {
      // Cancelling a decided approval would rewrite history: the human's
      // decision happened, and the execution record is the place that says
      // whether it was honoured.
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await setCeiling(company.id, agent.id, { providers: ["hubspot"] });
      const approval = await pendingSend(company.id, agent.id);
      await db
        .update(approvals)
        .set({ status: "approved" })
        .where(eq(approvals.id, approval.id));

      await setCeiling(company.id, agent.id, { providers: ["telegram"] });

      const stored = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approval.id))
        .then((rows) => rows[0]!);
      expect(stored.status).toBe("approved");
    });
  });

  describe("minimumApproval", () => {
    /**
     * Set BOTH sides to the same value.
     *
     * `minimumApproval` is the one dimension where the ceiling is a floor, so
     * the effective value is the STRICTER of ceiling and steward request.
     * Lowering only the ceiling changes nothing — the standing request still
     * asks for steward approval, and enforcement reads the effective policy.
     * That is the intended semantics: relaxing takes an owner AND the steward.
     */
    async function setBothSides(
      companyId: string,
      agentId: string,
      overrides: Partial<AgentGovernancePolicy>,
    ) {
      await setCeiling(companyId, agentId, overrides);
      const svc = agentGovernanceService(db);
      const current = await svc.getForAgent(companyId, agentId);
      await svc.updateStewardRequest(companyId, agentId, {
        policy: {
          permissions: [AGENT_POLICY_WILDCARD],
          monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
          destructiveActions: "approval_required",
          dataScopes: [AGENT_POLICY_WILDCARD],
          providers: [AGENT_POLICY_WILDCARD],
          minimumApproval: "steward",
          ...overrides,
        },
        revision: current.revision,
        actorUserId: "steward-1",
        channel: "web",
      });
    }

    async function seedSteward(companyId: string, agentId: string, userId: string) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        membershipRole: "operator",
        status: "active",
      });
      await db.insert(agentStewardships).values({
        companyId,
        agentId,
        userId,
        assignedByUserId: "owner-1",
      });
    }

    async function createApproval(companyId: string, requestedByAgentId: string) {
      return db
        .insert(approvals)
        .values({
          companyId,
          type: "request_board_approval",
          requestedByAgentId,
          status: "pending",
          payload: { summary: "Ship it" },
        })
        .returning()
        .then((rows) => rows[0]!);
    }

    /** A real administrator, but explicitly NOT the local bootstrap board. */
    function adminActor(companyId: string, userId: string) {
      return {
        type: "board" as const,
        userId,
        source: "session",
        isInstanceAdmin: true,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      };
    }

    function memberActor(companyId: string, userId: string) {
      return {
        type: "board" as const,
        userId,
        source: "session",
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      };
    }

    it("keeps the steward-only rule under the default ceiling", async () => {
      // Criterion 7 regression guard. `steward` is the default and the floor,
      // so an owner who is not the steward still has to use the override.
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await seedSteward(company.id, agent.id, "steward-1");
      const approval = await createApproval(company.id, agent.id);

      await expect(
        approvalAuthorityService(db).requireDecisionActor(
          approval,
          adminActor(company.id, "owner-9"),
        ),
      ).rejects.toThrow(/steward/i);
    });

    it("lets an administrator decide on the ordinary path when the ceiling asks for no approval floor", async () => {
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await seedSteward(company.id, agent.id, "steward-1");
      await setBothSides(company.id, agent.id, { minimumApproval: "none" });
      const approval = await createApproval(company.id, agent.id);

      const role = await approvalAuthorityService(db).requireDecisionActor(
        approval,
        adminActor(company.id, "owner-9"),
      );

      expect(role).toBe("admin");
    });

    it("does not open the ordinary path to non-administrators", async () => {
      // The relaxation removes the override ceremony for people who could
      // already override. It must not add a new class of decider.
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await seedSteward(company.id, agent.id, "steward-1");
      await setBothSides(company.id, agent.id, { minimumApproval: "none" });
      const approval = await createApproval(company.id, agent.id);

      await expect(
        approvalAuthorityService(db).requireDecisionActor(
          approval,
          memberActor(company.id, "bystander-1"),
        ),
      ).rejects.toThrow(/steward/i);
    });

    it("still attributes the steward's own decision to the steward", async () => {
      const company = await createCompany();
      const agent = await createAgent(company.id);
      await seedSteward(company.id, agent.id, "steward-1");
      await setBothSides(company.id, agent.id, { minimumApproval: "none" });
      const approval = await createApproval(company.id, agent.id);

      const role = await approvalAuthorityService(db).requireDecisionActor(
        approval,
        memberActor(company.id, "steward-1"),
      );

      expect(role).toBe("steward");
    });
  });

  describe("binding regression", () => {
    async function seedSteward(companyId: string, agentId: string, userId: string) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        membershipRole: "operator",
        status: "active",
      });
      await db.insert(agentStewardships).values({
        companyId,
        agentId,
        userId,
        assignedByUserId: "owner-1",
      });
    }

    it("binds any provider in a default-profile company", async () => {
      // The gate is a profile feature. A default-profile company must be able
      // to pair a channel even with a narrow policy row sitting in the table.
      const company = await createCompany("default");
      const agent = await createAgent(company.id);
      await seedSteward(company.id, agent.id, "user-1");
      await db.insert(agentGovernancePolicies).values({
        companyId: company.id,
        agentId: agent.id,
        ownerCeiling: { providers: ["teams"] },
        stewardRequest: { providers: ["teams"] },
        effectivePolicy: {
          permissions: [AGENT_POLICY_WILDCARD],
          monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
          destructiveActions: "approval_required",
          dataScopes: [AGENT_POLICY_WILDCARD],
          providers: ["teams"],
          minimumApproval: "steward",
        },
      });

      const binding = await humanChannelService(db).verifyBinding(company.id, {
        userId: "user-1",
        provider: "telegram",
        externalUserId: "tg-1",
      });

      expect(binding.provider).toBe("telegram");
    });
  });
});
