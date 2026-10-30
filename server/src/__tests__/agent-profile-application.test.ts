import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentGovernancePolicies,
  agentProfileApplications,
  agentProfileRevisions,
  agentStewardships,
  approvals,
  authUsers,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  AGENT_PROFILE_APPLICATION_STEPS,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
  type AgentOperatingProfileV1,
  type AgentProfileApplicationStep,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { agentProfileActor, editBody, seedProfileCompany, userActor, type TestDb } from "./helpers/agent-profile-fixtures.js";

const declareAgentContract = vi.hoisted(() =>
  vi.fn(async (_db: unknown, input: { profileRevisionId: string }) => ({ eventId: `contract-${input.profileRevisionId}`, inserted: true })),
);
vi.mock("../services/evaluation/agent-contract.js", () => ({
  declareAgentContract,
  agentContractSourceId: (agentId: string) => `agent:${agentId}`,
  buildAgentContractV2: vi.fn(),
}));

const { agentGovernanceService } = await import("../services/agent-governance.js");
const { approvalAuthorityService } = await import("../services/approval-authority.js");
const { approvalService } = await import("../services/approvals.js");
const {
  createProfileDraft,
  getAgentProfileView,
  proposeProfileRevision,
  saveProfileDraft,
  AgentProfileDraftConflictError,
} = await import("../services/agent-profiles.js");
const {
  PROFILE_APPLICATION_LEASE_MS,
  applyProfileRevision,
  isProfileApplicationInProgress,
  resumeProfileApplication,
} = await import("../services/agent-profile-application.js");
const { expectedProfileBlockHash, profileDeliveryEvidence, renderProfileBlock } = await import("../services/agent-profile-block.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Seed = Awaited<ReturnType<typeof seedProfileCompany>>;

/** A change that reaches every step: access (V2), model, heartbeat, environment, a routine binding, do.skills. */
function everyStepChange(s: Seed) {
  return (body: AgentOperatingProfileV1) => {
    body.identity.style.tone = "Plain and brief";
    body.runtime = { ...body.runtime, model: "test-model", heartbeat: { intervalSec: 1800, wakeOnDemand: false }, environmentId: s.environment.id };
    body.responsibilities = [
      {
        key: "weekly-report",
        title: "Weekly report",
        outcome: "Pipeline reviewed every Monday",
        stakeholders: [],
        obligation: { kind: "routine", routineTriggerId: s.trigger.id },
        deliverable: { what: "Report", destination: "Issue" },
        escalation: { toUserId: s.stewardUserId, when: "Blocked for a day" },
        performance: { criteria: [], coverage: [], outcomeLinks: [], expectedHumanSteps: [], judges: { automated: [] } },
      },
    ];
    body.access = { ...body.access, see: { projects: { mode: "listed", ids: [] } }, do: { skills: { mode: "listed", ids: [] } } };
  };
}

describeEmbeddedPostgres("agent profile application (APM gate 2, P2.2)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-profile-application-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    declareAgentContract.mockClear();
  });

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const scopeOf = (s: Seed, agentId = s.analyst.id) => ({ companyId: s.company.id, agentId });

  async function draftWith(s: Seed, actorUserId: string, mutate: (body: AgentOperatingProfileV1) => void, agentId = s.analyst.id) {
    const actor = userActor(actorUserId);
    const draft = await createProfileDraft(db, { ...scopeOf(s, agentId), input: {} }, actor);
    return saveProfileDraft(db, { ...scopeOf(s, agentId), revisionId: draft.id, ifMatch: draft.bodyHash, input: { body: editBody(draft, mutate) } }, actor);
  }

  async function decide(approvalId: string, approverUserId: string) {
    const approval = (await approvalService(db).getById(approvalId))!;
    const context = await approvalAuthorityService(db).requireDecisionAuthority(
      approval,
      { type: "board", userId: approverUserId, source: "session", isInstanceAdmin: false },
      { revision: approval.revision, idempotencyKey: randomUUID(), channel: "web" },
    );
    await approvalService(db).approve(approvalId, approverUserId, null, {
      revision: context.revision,
      channel: context.channel,
      idempotencyKey: context.idempotencyKey,
      actorRole: context.role,
    });
    return context;
  }

  async function proposeAndApprove(s: Seed, proposerUserId: string, approverUserId: string, mutate: (body: AgentOperatingProfileV1) => void, agentId = s.analyst.id) {
    const saved = await draftWith(s, proposerUserId, mutate, agentId);
    const proposal = await proposeProfileRevision(db, { ...scopeOf(s, agentId), revisionId: saved.id, input: { reason: "test" } }, userActor(proposerUserId));
    const context = await decide(proposal.approvalId, approverUserId);
    return { saved, proposal, context };
  }

  const approverActor = (userId: string) => ({ userId, path: "approval" as const, source: "session", isInstanceAdmin: false });

  async function count(table: typeof approvals | typeof agentConfigRevisions | typeof agentGovernancePolicies | typeof agentProfileApplications) {
    return db.select({ n: sql<number>`count(*)::int` }).from(table).then((rows) => rows[0]!.n);
  }

  it("keeps draft, approval and application separate: only the application changes anything", async () => {
    const s = await seedProfileCompany(db);
    const before = { approvals: await count(approvals), config: await count(agentConfigRevisions), governance: await count(agentGovernancePolicies) };

    const saved = await draftWith(s, s.ownerUserId, everyStepChange(s));
    expect(saved.state).toBe("draft");
    expect({ approvals: await count(approvals), config: await count(agentConfigRevisions), governance: await count(agentGovernancePolicies) }).toEqual(before);

    const proposal = await proposeProfileRevision(db, { ...scopeOf(s), revisionId: saved.id, input: {} }, userActor(s.ownerUserId));
    expect(proposal.revision.state).toBe("proposed");
    expect(proposal.revision.bases).toEqual({ basedOnRevisionId: null, governanceRevision: null, configRevisionId: null });
    expect(await count(approvals)).toBe(before.approvals + 1);
    expect(await count(agentProfileApplications)).toBe(0);
    expect(await count(agentConfigRevisions)).toBe(before.config);

    await decide(proposal.approvalId, s.ownerUserId);
    // Deciding records the decision; it applies nothing by itself.
    expect(await count(agentProfileApplications)).toBe(0);
    expect((await getAgentProfileView(db, scopeOf(s)))!.active).toBeNull();

    const result = await applyProfileRevision(db, proposal.approvalId, approverActor(s.ownerUserId));
    expect(result.activated).toBe(true);
    expect(result.application.status).toBe("applied");
    expect(result.application.steps.map((step) => [step.step, step.status])).toEqual([
      ["governance_request", "done"],
      ["config", "done"],
      ["environment", "done"],
      ["routine_bindings", "done"],
      // Required company skills become the explicit desired list: do.skills now lists none.
      ["skills", "done"],
      ["contract", "done"],
    ]);
    const view = (await getAgentProfileView(db, scopeOf(s)))!;
    expect(view.active?.id).toBe(saved.id);
    expect(view.active?.state).toBe("applied");
    expect(view.derived).toBeNull();
    expect(declareAgentContract).toHaveBeenCalledTimes(1);
    expect(declareAgentContract.mock.calls[0]![1]).toMatchObject({ profileRevisionId: saved.id, agentId: s.analyst.id, actor: { actorType: "user", actorId: s.ownerUserId } });

    const configRows = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, s.analyst.id));
    expect(configRows.map((row) => row.source)).toEqual(["profile_application", "profile_application", "profile_application"]);
    const governance = await agentGovernanceService(db).getForAgent(s.company.id, s.analyst.id);
    expect((governance.stewardRequest as { see?: unknown }).see).toEqual({ projects: { mode: "listed", ids: [] } });

    // A second call for the same approval returns the receipt and runs nothing.
    const again = await applyProfileRevision(db, proposal.approvalId, approverActor(s.ownerUserId));
    expect(again.application.id).toBe(result.application.id);
    expect(declareAgentContract).toHaveBeenCalledTimes(1);

    const actions = await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.companyId, s.company.id));
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "agent_profile.draft_saved",
        "agent_profile.proposed",
        "agent_profile.application_started",
        "agent_profile.application_step",
        "agent_profile.applied",
      ]),
    );
  });

  it("refuses a stale If-Match with 409 and the current draft", async () => {
    const s = await seedProfileCompany(db);
    const draft = await createProfileDraft(db, { ...scopeOf(s), input: {} }, userActor(s.stewardUserId));
    const first = await saveProfileDraft(
      db,
      { ...scopeOf(s), revisionId: draft.id, ifMatch: draft.bodyHash, input: { body: editBody(draft, (b) => (b.identity.summary = "First")) } },
      userActor(s.stewardUserId),
    );
    const stale = saveProfileDraft(
      db,
      { ...scopeOf(s), revisionId: draft.id, ifMatch: draft.bodyHash, input: { body: editBody(draft, (b) => (b.identity.summary = "Second")) } },
      userActor(s.stewardUserId),
    );
    await expect(stale).rejects.toBeInstanceOf(AgentProfileDraftConflictError);
    await expect(stale).rejects.toMatchObject({ status: 409, code: "AGENT_PROFILE_DRAFT_CONFLICT", current: { bodyHash: first.bodyHash } });
  });

  describe("field authority", () => {
    it("classifies each field and refuses a steward on runtime fields", async () => {
      const s = await seedProfileCompany(db);
      const saved = await draftWith(s, s.stewardUserId, (body) => {
        body.identity.style.tone = "Warm";
        body.runtime = { ...body.runtime, model: "bigger-model" };
      });
      const proposal = await proposeProfileRevision(db, { ...scopeOf(s), revisionId: saved.id, input: {} }, userActor(s.stewardUserId));
      expect(proposal.payload.fieldAuthority).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pointer: "/identity/style/tone", required: "steward_or_accountable" }),
          expect.objectContaining({ pointer: "/runtime/model", required: "admin" }),
        ]),
      );
      expect(proposal.payload.requiredAuthority).toBe("admin");
      await expect(decide(proposal.approvalId, s.stewardUserId)).rejects.toMatchObject({ status: 403 });
      const context = await decide(proposal.approvalId, s.ownerUserId);
      expect(context.role).toBe("admin");
    });

    it("needs an administrator for access beyond the ceiling, and records the clipping", async () => {
      const s = await seedProfileCompany(db);
      await agentGovernanceService(db).updateOwnerCeiling(s.company.id, s.analyst.id, {
        policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, providers: ["slack"], see: { projects: { mode: "listed", ids: ["p-1"] } } },
        revision: 1,
        actorUserId: s.ownerUserId,
      });
      const saved = await draftWith(s, s.stewardUserId, (body) => {
        body.access = { ...body.access, providers: ["email", "slack"], see: { projects: { mode: "all", ids: [] } } };
      });
      const proposal = await proposeProfileRevision(db, { ...scopeOf(s), revisionId: saved.id, input: {} }, userActor(s.stewardUserId));
      expect(proposal.payload.requiredAuthority).toBe("admin_ceiling");
      expect(proposal.payload.accessChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ dimension: "providers", change: "narrows", clippedByCeiling: true }),
          expect.objectContaining({ dimension: "see.projects", clippedByCeiling: true }),
        ]),
      );
      await expect(decide(proposal.approvalId, s.stewardUserId)).rejects.toMatchObject({ status: 403 });
      await decide(proposal.approvalId, s.ownerUserId);
      const result = await applyProfileRevision(db, proposal.approvalId, approverActor(s.ownerUserId));
      expect(result.activated).toBe(true);
      // Application never raises a ceiling: the V1 request is clamped to it.
      const governance = await agentGovernanceService(db).getForAgent(s.company.id, s.analyst.id);
      expect((governance.ownerCeiling as { providers: string[] }).providers).toEqual(["slack"]);
      expect((governance.stewardRequest as { providers: string[] }).providers).toEqual(["slack"]);
      expect((governance.effectivePolicy as { providers: string[] }).providers).toEqual(["slack"]);
    });

    it("lets the steward decide a text-only change and records the steward role", async () => {
      const s = await seedProfileCompany(db);
      const { context } = await proposeAndApprove(s, s.stewardUserId, s.stewardUserId, (body) => {
        body.identity.audience = "Sales leads";
      });
      expect(context.role).toBe("steward");
    });

    it("mirrors today's guards: an autonomous agent's accountable person (not steward, not admin) cannot decide skills or access, but can decide responsibilities and criteria", async () => {
      const s = await seedProfileCompany(db);
      const agentId = s.autonomous.id;
      const accountable = userActor(s.accountableUserId);
      const proposeAs = async (mutate: (body: AgentOperatingProfileV1) => void) => {
        const saved = await draftWith(s, s.accountableUserId, mutate, agentId);
        return proposeProfileRevision(db, { ...scopeOf(s, agentId), revisionId: saved.id, input: {} }, accountable);
      };
      const { withdrawProfileRevision } = await import("../services/agent-profiles.js");

      for (const mutate of [
        (body: AgentOperatingProfileV1) => (body.skills = ["research"]),
        (body: AgentOperatingProfileV1) => (body.access = { ...body.access, see: { projects: { mode: "listed", ids: [] } } }),
        (body: AgentOperatingProfileV1) => (body.access = { ...body.access, monthlyBudgetCents: 1_000 }),
      ]) {
        const proposal = await proposeAs(mutate);
        expect(proposal.payload.requiredAuthority).toBe("steward_or_accountable");
        await expect(decide(proposal.approvalId, s.accountableUserId)).rejects.toMatchObject({
          status: 403,
          message: expect.stringContaining("same authority as changing them directly"),
        });
        await withdrawProfileRevision(db, { ...scopeOf(s, agentId), revisionId: proposal.revision.id, input: {} }, accountable);
      }

      const proposal = await proposeAs((body) => {
        body.responsibilities = [
          {
            key: "ops-digest",
            title: "Ops digest",
            outcome: "Ops issues summarised daily",
            stakeholders: [],
            obligation: { kind: "assigned" },
            deliverable: { what: "Digest", destination: "Issue" },
            escalation: { toUserId: s.accountableUserId, when: "An outage" },
            performance: {
              criteria: [{ id: "c1", text: "Every open incident is listed", source: "human" }],
              coverage: [],
              outcomeLinks: [],
              expectedHumanSteps: [],
              judges: { automated: [] },
            },
          },
        ];
      });
      const context = await decide(proposal.approvalId, s.accountableUserId);
      expect(context.role).toBe("accountable");
      // The application re-check applies the same rules.
      const result = await applyProfileRevision(db, proposal.approvalId, approverActor(s.accountableUserId));
      expect(result.activated).toBe(true);
      expect(result.application.approverAuthority).toMatchObject({ role: "accountable", selfApproval: true });
    });

    it("lets the steward decide skills and access within the ceiling, as the direct routes do", async () => {
      const s = await seedProfileCompany(db);
      const { context } = await proposeAndApprove(s, s.stewardUserId, s.stewardUserId, (body) => {
        body.skills = ["research"];
        body.access = { ...body.access, see: { projects: { mode: "listed", ids: [] } } };
      });
      expect(context.role).toBe("steward");
    });

    it("applies in every company: a default-profile company's accountable person decides, an outsider cannot", async () => {
      const s = await seedProfileCompany(db, "default");
      const saved = await draftWith(s, s.accountableUserId, (body) => (body.identity.audience = "Ops"), s.autonomous.id);
      const proposal = await proposeProfileRevision(
        db,
        { ...scopeOf(s, s.autonomous.id), revisionId: saved.id, input: {} },
        userActor(s.accountableUserId),
      );
      await expect(decide(proposal.approvalId, s.outsiderUserId)).rejects.toMatchObject({ status: 403 });
      const context = await decide(proposal.approvalId, s.accountableUserId);
      expect(context.role).toBe("accountable");
      await expect(
        createProfileDraft(db, { ...scopeOf(s, s.autonomous.id), input: {} }, userActor(s.outsiderUserId)),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  it("records a self-approval", async () => {
    const s = await seedProfileCompany(db);
    const { proposal } = await proposeAndApprove(s, s.ownerUserId, s.ownerUserId, (body) => (body.identity.audience = "Board"));
    const result = await applyProfileRevision(db, proposal.approvalId, approverActor(s.ownerUserId));
    expect(result.application.approverAuthority).toMatchObject({ role: "admin", selfApproval: true, required: "steward_or_accountable" });
    const approval = (await approvalService(db).getById(proposal.approvalId))!;
    expect(approval.decisionActorRole).toBe("admin");
  });

  it("never lets an agent decide, including the agent that proposed", async () => {
    const s = await seedProfileCompany(db);
    const actor = agentProfileActor(s.chief.id);
    const draft = await createProfileDraft(db, { ...scopeOf(s), input: {} }, actor);
    const saved = await saveProfileDraft(
      db,
      { ...scopeOf(s), revisionId: draft.id, ifMatch: draft.bodyHash, input: { body: editBody(draft, (b) => (b.identity.audience = "CoS view")) } },
      actor,
    );
    const proposal = await proposeProfileRevision(db, { ...scopeOf(s), revisionId: saved.id, input: {} }, actor);
    // APM gate 4: the Chief of Staff is the default performance manager, so its proposal for another agent is marked.
    expect(proposal.payload.proposedBy).toEqual({ kind: "agent", agentId: s.chief.id, runId: null, capacity: "performance_manager" });
    const approval = (await approvalService(db).getById(proposal.approvalId))!;
    expect(approval.requestedByAgentId).toBe(s.chief.id);
    const authority = approvalAuthorityService(db);
    for (const agentActor of [
      { type: "agent", agentId: s.chief.id },
      { type: "agent", agentId: s.analyst.id },
    ]) {
      await expect(
        authority.requireDecisionAuthority(approval, agentActor, { revision: approval.revision, idempotencyKey: randomUUID(), channel: "web" }),
      ).rejects.toMatchObject({ status: 403 });
    }
    // A person with the authority decides it; it is not a self-approval.
    const context = await decide(proposal.approvalId, s.stewardUserId);
    expect(context.role).toBe("steward");
    const result = await applyProfileRevision(db, proposal.approvalId, approverActor(s.stewardUserId));
    expect(result.application.approverAuthority?.selfApproval).toBe(false);
  });

  it("serializes applications per agent; the later one is refused as stale once the first lands", async () => {
    const s = await seedProfileCompany(db);
    const first = await proposeAndApprove(s, s.ownerUserId, s.ownerUserId, everyStepChange(s));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inStep = new Promise<void>((resolve) => (entered = resolve));
    const running = applyProfileRevision(db, first.proposal.approvalId, approverActor(s.ownerUserId), {
      beforeStep: async (step) => {
        if (step === "governance_request") {
          entered();
          await gate;
        }
      },
    });
    await inStep;
    expect(await isProfileApplicationInProgress(db, s.company.id, s.analyst.id)).toBe(true);
    expect((await getAgentProfileView(db, scopeOf(s)))!.applicationInProgress).toBe(true);

    const second = await proposeAndApprove(s, s.ownerUserId, s.ownerUserId, (body) => (body.identity.audience = "Second"));
    await expect(applyProfileRevision(db, second.proposal.approvalId, approverActor(s.ownerUserId))).rejects.toMatchObject({
      status: 409,
      details: { code: "AGENT_PROFILE_APPLICATION_IN_PROGRESS" },
    });
    const [pendingSecond] = await db
      .select()
      .from(agentProfileApplications)
      .where(eq(agentProfileApplications.approvalId, second.proposal.approvalId));
    expect(pendingSecond!.status).toBe("pending");

    release();
    expect((await running).activated).toBe(true);
    expect(await isProfileApplicationInProgress(db, s.company.id, s.analyst.id)).toBe(false);

    const resumed = await resumeProfileApplication(db, pendingSecond!.id, { userId: s.ownerUserId, path: "resume" });
    expect(resumed.application.status).toBe("refused_stale");
    expect(resumed.application.failure).toMatchObject({ kind: "stale" });
    expect((await getAgentProfileView(db, scopeOf(s)))!.active?.id).toBe(first.saved.id);
  });

  it("refuses a stale base: governance changed after the proposal", async () => {
    const s = await seedProfileCompany(db);
    const { proposal, saved } = await proposeAndApprove(s, s.stewardUserId, s.stewardUserId, (body) => (body.identity.audience = "X"));
    await agentGovernanceService(db).updateStewardRequest(s.company.id, s.analyst.id, {
      policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, monthlyBudgetCents: 500 },
      revision: 1,
      actorUserId: s.stewardUserId,
    });
    const result = await applyProfileRevision(db, proposal.approvalId, approverActor(s.stewardUserId));
    expect(result.activated).toBe(false);
    expect(result.application.status).toBe("refused_stale");
    const [revision] = await db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id, saved.id));
    expect(revision!.state).toBe("refused_stale");
    expect((await getAgentProfileView(db, scopeOf(s)))!.active).toBeNull();
    const refused = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, s.company.id), eq(activityLog.action, "agent_profile.application_refused_stale")));
    expect(refused[0]!.details).toMatchObject({ reason: "governance_changed" });
    // An ended application cannot be resumed.
    await expect(resumeProfileApplication(db, result.application.id, { userId: s.ownerUserId, path: "resume" })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an approver who lost the authority since deciding", async () => {
    const s = await seedProfileCompany(db);
    const { proposal } = await proposeAndApprove(s, s.stewardUserId, s.stewardUserId, (body) => (body.identity.audience = "X"));
    await db.update(agentStewardships).set({ endedAt: new Date() }).where(eq(agentStewardships.agentId, s.analyst.id));
    const result = await applyProfileRevision(db, proposal.approvalId, approverActor(s.stewardUserId));
    expect(result.activated).toBe(false);
    expect(result.application.status).toBe("failed");
    expect(result.application.failure).toMatchObject({ kind: "authority" });
    expect(result.application.steps.every((step) => step.status === "pending")).toBe(true);
    expect(declareAgentContract).not.toHaveBeenCalled();
    await expect(resumeProfileApplication(db, result.application.id, { userId: s.ownerUserId, path: "resume" })).rejects.toMatchObject({
      status: 409,
      details: { code: "AGENT_PROFILE_APPLICATION_ENDED" },
    });
  });

  describe("failure at each step, then resume", () => {
    for (const failingStep of AGENT_PROFILE_APPLICATION_STEPS) {
      it(`fails at ${failingStep} without switching the active revision, and resumes from it`, async () => {
        const s = await seedProfileCompany(db);
        const { proposal, saved } = await proposeAndApprove(s, s.ownerUserId, s.ownerUserId, everyStepChange(s));
        const failed = await applyProfileRevision(db, proposal.approvalId, approverActor(s.ownerUserId), {
          beforeStep: (step: AgentProfileApplicationStep) => {
            if (step === failingStep) throw new Error("injected failure with secret-ish detail");
          },
        });
        expect(failed.activated).toBe(false);
        expect(failed.application.status).toBe("failed");
        expect(failed.application.failure).toMatchObject({ kind: "step", step: failingStep });
        // Plain language, never the raw error.
        expect(failed.application.failure!.detail).not.toContain("secret");
        const index = AGENT_PROFILE_APPLICATION_STEPS.indexOf(failingStep);
        for (const record of failed.application.steps) {
          const at = AGENT_PROFILE_APPLICATION_STEPS.indexOf(record.step);
          expect(record.status, record.step).toBe(at < index ? "done" : at === index ? "failed" : "pending");
        }
        expect((await getAgentProfileView(db, scopeOf(s)))!.active).toBeNull();
        const [revision] = await db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id, saved.id));
        expect(revision!.state).toBe("application_failed");

        const resumed = await resumeProfileApplication(db, failed.application.id, { userId: s.ownerUserId, path: "resume", source: "session" });
        expect(resumed.activated, JSON.stringify(resumed.application)).toBe(true);
        expect(resumed.application.status).toBe("applied");
        expect((await getAgentProfileView(db, scopeOf(s)))!.active?.id).toBe(saved.id);
        // Completed steps were not re-run: one contract, one governance write, three config writes (config, environment, skills).
        expect(declareAgentContract).toHaveBeenCalledTimes(1);
        const configRows = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, s.analyst.id));
        expect(configRows).toHaveLength(3);
        const [governance] = await db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, s.analyst.id));
        expect(governance!.revision).toBe(2);
      });
    }

    it("fails the routine-binding step for a trigger that is not this agent's", async () => {
      const s = await seedProfileCompany(db);
      const { proposal } = await proposeAndApprove(s, s.ownerUserId, s.ownerUserId, (body) => {
        everyStepChange(s)(body);
        body.responsibilities[0]!.obligation = { kind: "routine", routineTriggerId: randomUUID() };
      });
      const result = await applyProfileRevision(db, proposal.approvalId, approverActor(s.ownerUserId));
      expect(result.application.failure).toMatchObject({ kind: "step", step: "routine_bindings" });
      expect(result.application.failure!.detail).toContain("not on a routine assigned to this agent");
    });
  });

  it("treats an expired in-progress mark as interrupted and lets resume take it over", async () => {
    const s = await seedProfileCompany(db);
    const { proposal } = await proposeAndApprove(s, s.ownerUserId, s.ownerUserId, everyStepChange(s));
    const failed = await applyProfileRevision(db, proposal.approvalId, approverActor(s.ownerUserId), {
      beforeStep: (step) => {
        if (step === "environment") throw new Error("crash");
      },
    });
    // Rewind the receipt to "the process died mid-step": in progress, step not finished.
    const steps = failed.application.steps.map((record) =>
      record.step === "environment" ? { ...record, status: "pending" as const, error: null } : record,
    );
    const setMark = (updatedAt: Date) =>
      db.update(agentProfileApplications).set({ status: "in_progress", steps, updatedAt }).where(eq(agentProfileApplications.id, failed.application.id));

    await setMark(new Date());
    expect(await isProfileApplicationInProgress(db, s.company.id, s.analyst.id)).toBe(true);
    await expect(resumeProfileApplication(db, failed.application.id, { userId: s.ownerUserId, path: "resume" })).rejects.toMatchObject({ status: 409 });

    await setMark(new Date(Date.now() - PROFILE_APPLICATION_LEASE_MS - 1000));
    expect(await isProfileApplicationInProgress(db, s.company.id, s.analyst.id)).toBe(false);
    const resumed = await resumeProfileApplication(db, failed.application.id, { userId: s.ownerUserId, path: "resume" });
    expect(resumed.application.status).toBe("applied");
    expect(declareAgentContract).toHaveBeenCalledTimes(1);
  });

  it("lets only the approver or an administrator resume", async () => {
    const s = await seedProfileCompany(db);
    const { proposal } = await proposeAndApprove(s, s.stewardUserId, s.stewardUserId, (body) => (body.identity.audience = "X"));
    const failed = await applyProfileRevision(db, proposal.approvalId, approverActor(s.stewardUserId), {
      beforeStep: (step) => {
        if (step === "contract") throw new Error("down");
      },
    });
    await expect(resumeProfileApplication(db, failed.application.id, { userId: s.outsiderUserId, path: "resume" })).rejects.toMatchObject({ status: 403 });
    const resumed = await resumeProfileApplication(db, failed.application.id, { userId: s.ownerUserId, path: "resume" });
    expect(resumed.application.status).toBe("applied");
  });

  it("keeps the V2 dimensions through a later V1-shaped governance write", async () => {
    const s = await seedProfileCompany(db);
    const { proposal } = await proposeAndApprove(s, s.ownerUserId, s.ownerUserId, everyStepChange(s));
    await applyProfileRevision(db, proposal.approvalId, approverActor(s.ownerUserId));
    const governance = agentGovernanceService(db);
    const current = await governance.getForAgent(s.company.id, s.analyst.id);
    await governance.updateStewardRequest(s.company.id, s.analyst.id, {
      policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, monthlyBudgetCents: 4_000 },
      revision: current.revision,
      actorUserId: s.stewardUserId,
    });
    const after = await governance.getForAgent(s.company.id, s.analyst.id);
    expect(after.stewardRequest).toMatchObject({
      monthlyBudgetCents: 4_000,
      policyVersion: 2,
      see: { projects: { mode: "listed", ids: [] } },
      do: { skills: { mode: "listed", ids: [] } },
    });
    // V2 is never flattened into the effective (V1) policy.
    expect(after.effectivePolicy).not.toHaveProperty("see");
    expect(after.effectivePolicy.monthlyBudgetCents).toBe(4_000);

    // A side with no V2 dimension stays a plain V1 row (MK rows unchanged).
    await governance.updateStewardRequest(s.company.id, s.autonomous.id, {
      policy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, monthlyBudgetCents: 100 },
      revision: 1,
      actorUserId: s.ownerUserId,
    });
    const plain = await governance.getForAgent(s.company.id, s.autonomous.id);
    expect(Object.keys(plain.stewardRequest).sort()).toEqual(Object.keys(DEFAULT_AGENT_GOVERNANCE_POLICY).sort());
  });

  it("reports run-start delivery evidence for the active revision", async () => {
    const s = await seedProfileCompany(db);
    const agent = { id: s.analyst.id, companyId: s.company.id, adapterType: "process", adapterConfig: {} };
    expect(await profileDeliveryEvidence(db, agent, { readAgentsMd: async () => null })).toEqual({
      profileRevisionId: null,
      blockHashOnDisk: null,
      expectedHash: null,
    });
    const { proposal, saved } = await proposeAndApprove(s, s.ownerUserId, s.ownerUserId, everyStepChange(s));
    await applyProfileRevision(db, proposal.approvalId, approverActor(s.ownerUserId));
    const active = (await getAgentProfileView(db, scopeOf(s)))!.active!;
    const rendered = renderProfileBlock({ id: active.id, revisionNumber: active.revisionNumber, body: active.body });
    const guidance = "<!-- AgentDash: operating-profile-guidance — DO NOT REMOVE OR REORDER THIS BLOCK -->\nRead your profile.\n<!-- /AgentDash: operating-profile-guidance -->";
    const onDisk = `# Agent\n\n${guidance}\n\n${rendered}\n`;
    const evidence = await profileDeliveryEvidence(db, agent, { readAgentsMd: async () => onDisk });
    expect(evidence).toEqual({
      profileRevisionId: saved.id,
      blockHashOnDisk: expectedProfileBlockHash({ id: active.id, revisionNumber: active.revisionNumber, body: active.body }),
      expectedHash: expectedProfileBlockHash({ id: active.id, revisionNumber: active.revisionNumber, body: active.body }),
    });
    const drifted = await profileDeliveryEvidence(db, agent, { readAgentsMd: async () => onDisk.replace("Plain and brief", "Edited by hand") });
    expect(drifted.blockHashOnDisk).not.toBe(drifted.expectedHash);
    const onlyGuidance = await profileDeliveryEvidence(db, agent, { readAgentsMd: async () => guidance });
    expect(onlyGuidance.blockHashOnDisk).toBeNull();
    const unreadable = await profileDeliveryEvidence(db, agent, {
      readAgentsMd: async () => {
        throw new Error("EACCES");
      },
    });
    expect(unreadable).toMatchObject({ profileRevisionId: saved.id, blockHashOnDisk: null });
  });
});
