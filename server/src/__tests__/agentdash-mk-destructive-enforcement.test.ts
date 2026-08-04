import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentGovernancePolicies,
  agentStewardships,
  agents,
  approvals,
  bridgeEndpoints,
  bridgeTasks,
  companies,
  companyMemberships,
  connectorSendExecutions,
  connections,
  createDb,
  workflowEvents,
} from "@paperclipai/db";
import {
  AGENT_POLICY_CEILING_EXCEEDED,
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  type AgentDestructiveActionMode,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { bridgeService } from "../services/bridge.js";
import { connectorSendExecutionService } from "../services/connector-send-execution.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

/**
 * AgentDash-MK T5a-2: action-time destructive-action enforcement.
 *
 * The classifier (T5a-1) says WHICH actions are destructive; this slice binds
 * the owner ceiling's `destructiveActions` mode to them at the two authorization
 * chokepoints slice E used — `bridgeService.createTask` and the connector-send
 * apply path (`connectorSendExecutionService.executeForApproval`). See
 * doc/plans/2026-08-04-t5-destructive-classifier.md.
 */
describeEmbeddedPostgres("agentdash-mk destructive-action enforcement", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-destructive-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workflowEvents);
    await db.delete(activityLog);
    await db.delete(bridgeTasks);
    await db.delete(bridgeEndpoints);
    await db.delete(connectorSendExecutions);
    await db.delete(approvals);
    await db.delete(agentGovernancePolicies);
    await db.delete(connections);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(profile: "agentdash_mk" | "default" = "agentdash_mk") {
    const company = await db
      .insert(companies)
      .values({
        name: `Destructive ${randomUUID()}`,
        issuePrefix: `DE${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: profile,
      })
      .returning()
      .then((rows) => rows[0]!);
    const owner = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "owner",
      })
      .returning()
      .then((rows) => rows[0]!);
    const steward = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
      })
      .returning()
      .then((rows) => rows[0]!);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: steward.principalId,
      assignedByUserId: owner.principalId,
    });
    return { company, owner, steward, agent };
  }

  /**
   * Set the agent's EFFECTIVE destructiveActions mode to `mode`. The effective
   * policy is `ceiling ∩ steward request` and is what runtime enforcement reads,
   * so both sides are written — setting only the ceiling to `allowed` would leave
   * the effective mode at the stricter default steward request.
   */
  async function setMode(companyId: string, agentId: string, mode: AgentDestructiveActionMode) {
    const svc = agentGovernanceService(db);
    await svc.materialize(companyId, agentId);
    const policy = {
      permissions: [AGENT_POLICY_WILDCARD],
      monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
      destructiveActions: mode,
      dataScopes: [AGENT_POLICY_WILDCARD],
      providers: [AGENT_POLICY_WILDCARD],
      minimumApproval: "steward" as const,
    };
    await db
      .update(agentGovernancePolicies)
      .set({ ownerCeiling: policy, stewardRequest: policy, effectivePolicy: policy })
      .where(
        and(
          eq(agentGovernancePolicies.companyId, companyId),
          eq(agentGovernancePolicies.agentId, agentId),
        ),
      );
  }

  async function enrolledEndpoint(companyId: string, userId: string, approverId: string) {
    const svc = bridgeService(db);
    const challenge = await svc.requestEnrollment(companyId, {
      userId,
      label: `laptop ${randomUUID().slice(0, 6)}`,
      capabilities: ["bridge:read", "bridge:act"],
    });
    const approved = await svc.approveEnrollment(companyId, challenge.enrollmentId, approverId);
    return approved.endpointId;
  }

  async function gateEvents(companyId: string) {
    return db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.companyId, companyId),
          eq(workflowEvents.eventType, "destructive_action_gated"),
        ),
      );
  }

  // -- bridge chokepoint: one test per mode -------------------------------

  it("blocked: refuses a destructive act task with a named-ceiling error", async () => {
    const { company, owner, steward, agent } = await seed();
    await setMode(company.id, agent.id, "blocked");
    const endpointId = await enrolledEndpoint(company.id, steward.principalId, owner.principalId);
    const svc = bridgeService(db);

    await expect(
      svc.createTask(company.id, {
        endpointId,
        requestedByAgentId: agent.id,
        taskClass: "act",
        instruction: "Rename the local build output directory.",
      }),
    ).rejects.toMatchObject({ code: AGENT_POLICY_CEILING_EXCEEDED, status: 422 });

    // Refused means nothing was created.
    expect(await db.select().from(bridgeTasks)).toHaveLength(0);

    const events = await gateEvents(company.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      surface: "bridge_task",
      actionClass: "local_machine_mutation",
      mode: "blocked",
      decision: "refused",
    });
    expect(events[0].actorKind).toBe("agent");
  });

  it("approval_required: routes a destructive act task through approvalService", async () => {
    const { company, owner, steward, agent } = await seed();
    await setMode(company.id, agent.id, "approval_required");
    const endpointId = await enrolledEndpoint(company.id, steward.principalId, owner.principalId);
    const svc = bridgeService(db);

    const task = await svc.createTask(company.id, {
      endpointId,
      requestedByAgentId: agent.id,
      taskClass: "act",
      instruction: "Rename the local build output directory.",
    });

    expect(task.status).toBe("awaiting_approval");
    expect(task.approvalId).toBeTruthy();
    const gatingApproval = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, task.approvalId!))
      .then((rows) => rows[0] ?? null);
    expect(gatingApproval?.status).toBe("pending");

    const events = await gateEvents(company.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      actionClass: "local_machine_mutation",
      mode: "approval_required",
      decision: "approval_raised",
    });
  });

  it("allowed: proceeds with a destructive act task without an approval", async () => {
    const { company, owner, steward, agent } = await seed();
    await setMode(company.id, agent.id, "allowed");
    const endpointId = await enrolledEndpoint(company.id, steward.principalId, owner.principalId);
    const svc = bridgeService(db);

    const task = await svc.createTask(company.id, {
      endpointId,
      requestedByAgentId: agent.id,
      taskClass: "act",
      instruction: "Rename the local build output directory.",
    });

    expect(task.status).toBe("queued");
    expect(task.approvalId).toBeNull();
    expect(await db.select().from(approvals)).toHaveLength(0);

    const events = await gateEvents(company.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      actionClass: "local_machine_mutation",
      mode: "allowed",
      decision: "allowed",
    });
  });

  // -- reads are never gated by the classifier ----------------------------

  it("reads-never-gated: a bridge read proceeds even under the strictest mode", async () => {
    const { company, owner, steward, agent } = await seed();
    await setMode(company.id, agent.id, "blocked");
    const endpointId = await enrolledEndpoint(company.id, steward.principalId, owner.principalId);
    const svc = bridgeService(db);

    const task = await svc.createTask(company.id, {
      endpointId,
      requestedByAgentId: agent.id,
      taskClass: "read",
      instruction: "Summarize the contents of README.md.",
    });

    // A read is a safe_read: blocked never touches it.
    expect(task.status).toBe("queued");
    expect(task.approvalId).toBeNull();
  });

  // -- default profile is untouched ---------------------------------------

  it("default-profile-unchanged: an act task is not newly gated or refused off-profile", async () => {
    const { company, owner, steward, agent } = await seed("default");
    const endpointId = await enrolledEndpoint(company.id, steward.principalId, owner.principalId);
    const svc = bridgeService(db);

    // The same shape that a `blocked` ceiling refuses in agentdash_mk must NOT
    // refuse here: enforcement is gated to the profile.
    const task = await svc.createTask(company.id, {
      endpointId,
      requestedByAgentId: agent.id,
      taskClass: "act",
      instruction: "Rename the local build output directory.",
    });

    // Existing behaviour: act is still gated via the ordinary approval, never
    // refused. And no destructive_action_gated row is written off-profile.
    expect(task.status).toBe("awaiting_approval");
    expect(await gateEvents(company.id)).toHaveLength(0);
  });

  // -- connector-send apply path: fail-closed + blocked -------------------

  it("fail-closed + blocked: a connector write refuses at the apply path", async () => {
    const { company, agent } = await seed();
    await setMode(company.id, agent.id, "blocked");

    // A plain HubSpot `create` is an unclassified_write — the classifier cannot
    // place it as a known-safe read, so it fails closed to destructive. Under a
    // `blocked` ceiling the apply path must refuse it before any provider call.
    const approval = await db
      .insert(approvals)
      .values({
        companyId: company.id,
        type: "connector_send",
        requestedByAgentId: agent.id,
        status: "approved",
        payload: {
          provider: "hubspot",
          operation: "create",
          objectType: "contacts",
          payloadDigest: "digest-1",
          properties: { email: "lead@example.com" },
        },
      })
      .returning()
      .then((rows) => rows[0]!);

    const connectorSend = connectorSendExecutionService(db);
    await connectorSend.executeForApproval(approval.id);

    const execution = await db
      .select()
      .from(connectorSendExecutions)
      .where(eq(connectorSendExecutions.approvalId, approval.id))
      .then((rows) => rows[0] ?? null);
    expect(execution?.reason).toBe("destructive_action_blocked");
    // Never claimed / executed.
    expect(execution?.outcome).toBe("failed");
    expect(execution?.externalId).toBeNull();

    const events = await gateEvents(company.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      surface: "connector_send",
      actionClass: "unclassified_write",
      mode: "blocked",
      decision: "refused",
    });
  });
});
