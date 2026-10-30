// AgentDash: Agent Performance Management gate 2 (P2.3) — the heartbeat.ts
// matrix rows of the V2 access shadow mode (access LLD §4): the run-claim and
// context-hydration project checks, the runtime skill-mentions check and the
// one wake-dispatch check; plus the dispatch deferral while a profile is being
// applied, and the run-start profile delivery evidence and drift log.
//
// Every row: in `shadow` the would-be refusal is logged and the run/wake goes
// exactly as in `off`; in `off` nothing is logged.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentProfileApplications,
  agentProfileRevisions,
  agentProfiles,
  agentStewardships,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { buildSkillMentionHref } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { activityRows, setAccessMode, setAccessPolicy, wouldRefuseRows } from "./helpers/agent-access-fixtures.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { PROFILE_APPLICATION_LEASE_MS } from "../services/agent-profile-application.ts";
import { createProfileDraft } from "../services/agent-profiles.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.ts";
import { resetRunLogStoreForTests } from "../services/run-log-store.ts";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FAKE_ADAPTER = "agent_access_shadow_heartbeat_test";
const ALL_VIA = ["assign", "comment_wake", "mention", "handoff"] as const;

type Mode = "off" | "shadow";
type TestDb = ReturnType<typeof createDb>;

async function waitForRunToFinish(heartbeat: ReturnType<typeof heartbeatService>, runId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function runRow(db: TestDb, runId: string) {
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
}

describeEmbeddedPostgres("V2 access shadow mode in the heartbeat (APM gate 2, P2.3)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  const saved: Record<string, string | undefined> = {};
  /** The adapter config each fake-adapter run received, by run id. */
  const receivedConfig = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY", "RUN_LOG_BASE_PATH"]) {
      saved[key] = process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), "agent-access-shadow-heartbeat-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "agent-access-shadow-heartbeat-test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "e".repeat(64);
    process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-access-shadow-heartbeat-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: FAKE_ADAPTER,
      execute: async (ctx: AdapterExecutionContext) => {
        receivedConfig.set(ctx.runId, ctx.config);
        await ctx.onLog("stdout", "ok\n");
        return { exitCode: 0, signal: null, timedOut: false, summary: "done" };
      },
      testEnvironment: async () => ({ adapterType: FAKE_ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    } as never);
  }, 60_000);

  afterEach(async () => {
    // Let any fire-and-forget execution settle before the rows go.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await truncateWithRetry(db, sql`${companies}`);
  });

  afterAll(async () => {
    unregisterServerAdapter(FAKE_ADAPTER);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    await rm(home, { recursive: true, force: true });
  });

  async function seedCompany(mode: Mode, productProfile: "default" | "agentdash_mk" = "default") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Shadow ${companyId.slice(0, 6)}`,
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      productProfile,
      requireBoardApprovalForNewAgents: false,
    });
    await setAccessMode(db, companyId, mode);
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, adapterType = "process") {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: adapterType === "process" ? { command: "echo" } : {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedMember(companyId: string, membershipRole: "member" | "admin") {
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole });
    return userId;
  }

  async function seedProject(companyId: string) {
    return db
      .insert(projects)
      .values({ companyId, name: `Project ${randomUUID().slice(0, 6)}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedIssue(companyId: string, assigneeAgentId: string, values: { projectId?: string | null; description?: string } = {}) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Shadow access task",
      status: "todo",
      priority: "medium",
      assigneeAgentId,
      projectId: values.projectId ?? null,
      description: values.description ?? null,
    });
    return id;
  }

  /** A valid operating-profile revision for the agent, made active (state applied). */
  async function giveActiveRevision(companyId: string, agentId: string) {
    const draft = await createProfileDraft(db, { companyId, agentId, input: {} }, { type: "agent", agentId, runId: null });
    await db.update(agentProfileRevisions).set({ state: "applied" }).where(eq(agentProfileRevisions.id, draft.id));
    await db.update(agentProfiles).set({ activeRevisionId: draft.id }).where(eq(agentProfiles.id, draft.profileId));
    return draft;
  }

  function detailsOf(row: { details: unknown }) {
    return row.details as Record<string, unknown>;
  }

  /**
   * The would-refuse details. Activity redaction treats three dot-separated
   * segments as a JWT, so the rule is logged as `<dimension>:<reason>` with
   * the reason beside it (agent-access-check.ts `loggedRule`).
   */
  function refusalDetails(row: { details: unknown }, expected: { dimension: string; reason: string }) {
    const details = detailsOf(row);
    expect(details.rule).toBe(`${expected.dimension}:${expected.reason}`);
    expect(details.reason).toBe(expected.reason);
    expect(details.side).toBe("request");
    expect(typeof details.allowedSummary).toBe("string");
    return details;
  }

  // -------------------------------------------------------------------------
  // heartbeat.run_claim
  // -------------------------------------------------------------------------

  async function runClaimScenario(mode: Mode) {
    const companyId = await seedCompany(mode);
    const agentId = await seedAgent(companyId, "Worker");
    const project = await seedProject(companyId);
    const issueId = await seedIssue(companyId, agentId, { projectId: project.id });
    await setAccessPolicy(db, companyId, agentId, { request: { see: { projects: { mode: "listed", ids: [] } } } });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const run = await heartbeat.wakeup(agentId, { source: "assignment", reason: "issue_assigned", contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    const stored = await runRow(db, run!.id);
    return { companyId, agentId, project, issueId, status: stored.status, errorCode: stored.errorCode };
  }

  it("heartbeat.run_claim: shadow logs the out-of-scope project and claims the run exactly as off", async () => {
    const off = await runClaimScenario("off");
    expect(await wouldRefuseRows(db, off.companyId)).toHaveLength(0);

    const shadow = await runClaimScenario("shadow");
    expect(shadow.status).toBe(off.status);
    expect(shadow.status).toBe("running");
    expect(shadow.errorCode).toBe(off.errorCode);
    const rows = await wouldRefuseRows(db, shadow.companyId, "heartbeat.run_claim");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe(shadow.agentId);
    expect(refusalDetails(rows[0]!, { dimension: "see.projects", reason: "not_listed" })).toMatchObject({
      dimension: "see.projects",
      target: { projectId: shadow.project.id },
      site: "heartbeat.run_claim",
      policyMode: "shadow",
      issueId: shadow.issueId,
    });
  });

  // -------------------------------------------------------------------------
  // wake.dispatch
  // -------------------------------------------------------------------------

  async function agentWakeScenario(mode: Mode, productProfile: "default" | "agentdash_mk" = "default") {
    const companyId = await seedCompany(mode, productProfile);
    const sourceId = await seedAgent(companyId, "Sender");
    const recipientId = await seedAgent(companyId, "Receiver");
    if (productProfile === "agentdash_mk") {
      const stewardUserId = await seedMember(companyId, "member");
      await db.insert(agentStewardships).values({ companyId, agentId: recipientId, userId: stewardUserId });
    }
    const issueId = await seedIssue(companyId, recipientId);
    await setAccessPolicy(db, companyId, sourceId, {
      request: { talk: { agents: { mode: "listed", agentIds: [], via: [...ALL_VIA] } } },
    });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const run = await heartbeat.wakeup(recipientId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      requestedByActorType: "agent",
      requestedByActorId: sourceId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    expect(run).not.toBeNull();
    const stored = await runRow(db, run!.id);
    const wakes = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, recipientId)));
    return { companyId, sourceId, recipientId, issueId, status: stored.status, wakeStatuses: wakes.map((wake) => wake.status).sort() };
  }

  it("wake.dispatch: an agent-to-agent assignment wake logs talk.agents in shadow and is queued exactly as off", async () => {
    const off = await agentWakeScenario("off");
    expect(await wouldRefuseRows(db, off.companyId)).toHaveLength(0);

    const shadow = await agentWakeScenario("shadow");
    expect(shadow.status).toBe(off.status);
    expect(shadow.wakeStatuses).toEqual(off.wakeStatuses);
    const rows = await wouldRefuseRows(db, shadow.companyId, "wake.dispatch");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe(shadow.sourceId);
    expect(rows[0]!.actorType).toBe("agent");
    expect(rows[0]!.actorId).toBe(shadow.sourceId);
    expect(refusalDetails(rows[0]!, { dimension: "talk.agents", reason: "not_listed" })).toMatchObject({
      dimension: "talk.agents",
      target: { agentId: shadow.recipientId },
      site: "wake.dispatch",
      via: "assign",
    });
  });

  async function userWakeScenario(mode: Mode, sourceRole: "member" | "admin") {
    const companyId = await seedCompany(mode);
    const recipientId = await seedAgent(companyId, "Receiver");
    const userId = await seedMember(companyId, sourceRole);
    const issueId = await seedIssue(companyId, recipientId);
    await setAccessPolicy(db, companyId, recipientId, { request: { talk: { inbound: { mode: "listed", userIds: [] } } } });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const run = await heartbeat.wakeup(recipientId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: userId,
      requestedByActorSource: "session",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    expect(run).not.toBeNull();
    const stored = await runRow(db, run!.id);
    return { companyId, recipientId, userId, status: stored.status };
  }

  it("wake.dispatch: a person outside the recipient's inbound scope is logged as talk.inbound; an admin is not", async () => {
    const off = await userWakeScenario("off", "member");
    expect(await wouldRefuseRows(db, off.companyId)).toHaveLength(0);

    const member = await userWakeScenario("shadow", "member");
    expect(member.status).toBe(off.status);
    const rows = await wouldRefuseRows(db, member.companyId, "wake.dispatch");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe(member.recipientId);
    expect(rows[0]!.actorType).toBe("user");
    expect(rows[0]!.actorId).toBe(member.userId);
    expect(refusalDetails(rows[0]!, { dimension: "talk.inbound", reason: "not_listed" })).toMatchObject({
      dimension: "talk.inbound",
      target: { kind: "user", userId: member.userId },
      site: "wake.dispatch",
      via: "assign",
    });

    // Configuration authority over the recipient is never blocked by its inbound scope.
    const admin = await userWakeScenario("shadow", "admin");
    expect(admin.status).toBe(off.status);
    expect(await wouldRefuseRows(db, admin.companyId)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Dispatch deferral while a profile application holds the agent
  // -------------------------------------------------------------------------

  async function holdWithApplication(companyId: string, agentId: string, updatedAt: Date) {
    const profile = await db.insert(agentProfiles).values({ companyId, agentId }).returning().then((rows) => rows[0]!);
    const revision = await db
      .insert(agentProfileRevisions)
      .values({ companyId, profileId: profile.id, revisionNumber: 1, state: "approved", body: {} as never, bodyHash: "test" })
      .returning()
      .then((rows) => rows[0]!);
    return db
      .insert(agentProfileApplications)
      .values({ companyId, agentId, revisionId: revision.id, status: "in_progress", updatedAt })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("defers (never cancels) dispatch while an application is in progress, then claims once it finishes", async () => {
    const companyId = await seedCompany("off");
    const agentId = await seedAgent(companyId, "Applying");
    const application = await holdWithApplication(companyId, agentId, new Date());
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual" });
    expect(run).not.toBeNull();
    let stored = await runRow(db, run!.id);
    expect(stored.status).toBe("queued");
    expect(stored.errorCode).toBeNull();

    // Still held: a queue pass leaves it queued.
    await heartbeat.resumeQueuedRuns();
    expect((await runRow(db, run!.id)).status).toBe("queued");

    await db.update(agentProfileApplications).set({ status: "applied", updatedAt: new Date() }).where(eq(agentProfileApplications.id, application.id));
    await heartbeat.resumeQueuedRuns();
    stored = await runRow(db, run!.id);
    expect(stored.status).toBe("running");
  });

  it("does not defer for an interrupted application past its lease", async () => {
    const companyId = await seedCompany("off");
    const agentId = await seedAgent(companyId, "Interrupted");
    await holdWithApplication(companyId, agentId, new Date(Date.now() - PROFILE_APPLICATION_LEASE_MS - 60_000));
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual" });
    expect((await runRow(db, run!.id)).status).toBe("running");
  });

  // -------------------------------------------------------------------------
  // heartbeat.context_hydration + heartbeat.runtime_skills + run-start evidence + drift
  // -------------------------------------------------------------------------

  async function executedRunScenario(mode: Mode, options: { activeRevision: boolean }) {
    const companyId = await seedCompany(mode);
    const agentId = await seedAgent(companyId, "Runner", FAKE_ADAPTER);
    const project = await seedProject(companyId);
    const skill = await db
      .insert(companySkills)
      .values({ companyId, key: "release-notes", slug: "release-notes", name: "Release notes", markdown: "# Release notes\n\nWrite them." })
      .returning()
      .then((rows) => rows[0]!);
    const issueId = await seedIssue(companyId, agentId, {
      projectId: project.id,
      description: `Please use [/release-notes](${buildSkillMentionHref(skill.id, skill.slug)}) for this.`,
    });
    await setAccessPolicy(db, companyId, agentId, {
      request: { see: { projects: { mode: "listed", ids: [] } }, do: { skills: { mode: "listed", ids: [] } } },
    });
    const revision = options.activeRevision ? await giveActiveRevision(companyId, agentId) : null;
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "assignment", reason: "issue_assigned", contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    const config = receivedConfig.get(run!.id) ?? null;
    return { companyId, agentId, project, issueId, skill, revision, heartbeat, runId: run!.id, status: finished?.status, config };
  }

  it("heartbeat.context_hydration and heartbeat.runtime_skills: shadow logs both and the run still gets the mentioned skill", async () => {
    const off = await executedRunScenario("off", { activeRevision: false });
    expect(off.status).toBe("succeeded");
    expect(off.config).not.toBeNull();
    expect(readPaperclipSkillSyncPreference(off.config!).desiredSkills).toContain("release-notes");
    expect(await wouldRefuseRows(db, off.companyId)).toHaveLength(0);
    // No active revision: no delivery evidence and no drift.
    const offRow = await runRow(db, off.runId);
    expect(offRow.contextSnapshot as Record<string, unknown>).not.toHaveProperty("agentProfileDelivery");
    expect(await activityRows(db, off.companyId, "profile.block_drift")).toHaveLength(0);

    const shadow = await executedRunScenario("shadow", { activeRevision: false });
    expect(shadow.status).toBe(off.status);
    expect(readPaperclipSkillSyncPreference(shadow.config!).desiredSkills).toEqual(
      readPaperclipSkillSyncPreference(off.config!).desiredSkills,
    );

    const hydration = await wouldRefuseRows(db, shadow.companyId, "heartbeat.context_hydration");
    expect(hydration).toHaveLength(1);
    expect(refusalDetails(hydration[0]!, { dimension: "see.projects", reason: "not_listed" })).toMatchObject({
      dimension: "see.projects",
      target: { projectId: shadow.project.id },
      site: "heartbeat.context_hydration",
    });
    expect(hydration[0]!.runId).toBe(shadow.runId);

    const skills = await wouldRefuseRows(db, shadow.companyId, "heartbeat.runtime_skills");
    expect(skills).toHaveLength(1);
    expect(refusalDetails(skills[0]!, { dimension: "do.skills", reason: "not_listed" })).toMatchObject({
      dimension: "do.skills",
      target: { skillKey: "release-notes" },
      site: "heartbeat.runtime_skills",
    });
    // The claim row is logged too (its own matrix row).
    expect(await wouldRefuseRows(db, shadow.companyId, "heartbeat.run_claim")).toHaveLength(1);
  }, 60_000);

  it("writes run-start delivery evidence and logs drift once per distinct mismatch", async () => {
    const scenario = await executedRunScenario("off", { activeRevision: true });
    expect(scenario.status).toBe("succeeded");
    const stored = await runRow(db, scenario.runId);
    const evidence = (stored.contextSnapshot as Record<string, unknown>).agentProfileDelivery as Record<string, unknown>;
    expect(evidence).toMatchObject({ profileRevisionId: scenario.revision!.id, blockHashOnDisk: null });
    expect(typeof evidence.expectedHash).toBe("string");
    expect(evidence.expectedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof evidence.checkedAt).toBe("string");

    const drift = await activityRows(db, scenario.companyId, "profile.block_drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]!.agentId).toBe(scenario.agentId);
    expect(drift[0]!.runId).toBe(scenario.runId);
    expect(detailsOf(drift[0]!)).toMatchObject({
      profileRevisionId: scenario.revision!.id,
      expectedHash: evidence.expectedHash,
      blockHashOnDisk: null,
      reason: "block_missing",
    });

    // A second run with the same mismatch records evidence again but no second drift row.
    const second = await scenario.heartbeat.invoke(scenario.agentId, "on_demand", {}, "manual");
    expect(second).not.toBeNull();
    const finished = await waitForRunToFinish(scenario.heartbeat, second!.id);
    expect(finished?.status).toBe("succeeded");
    const secondRow = await runRow(db, second!.id);
    expect((secondRow.contextSnapshot as Record<string, unknown>).agentProfileDelivery).toMatchObject({
      profileRevisionId: scenario.revision!.id,
      expectedHash: evidence.expectedHash,
    });
    expect(await activityRows(db, scenario.companyId, "profile.block_drift")).toHaveLength(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  // MK regression
  // -------------------------------------------------------------------------

  it("MK companies: claim and wake behave the same in off and shadow", async () => {
    const off = await agentWakeScenario("off", "agentdash_mk");
    const shadow = await agentWakeScenario("shadow", "agentdash_mk");
    expect(shadow.status).toBe(off.status);
    expect(shadow.wakeStatuses).toEqual(off.wakeStatuses);
    expect(await wouldRefuseRows(db, off.companyId)).toHaveLength(0);
    expect(await wouldRefuseRows(db, shadow.companyId, "wake.dispatch")).toHaveLength(1);
  });
});
