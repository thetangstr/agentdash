// AgentDash: Agent Performance Management gate 3 (P3.4) — the heartbeat.ts
// matrix rows of V2 access in `enforce` (access LLD §4):
//  - run claim and context hydration: the run is not started, the issue gets a
//    blocker note, and the owner is told through the existing path (the issue
//    is blocked, so it reaches its steward/accountable person as "stopped and
//    needs you");
//  - runtime skills: a refused skill is dropped from the run and logged;
//  - the one wake-dispatch check: the comment is kept and the wake withheld.
// Plus the escalation contacts and authority holders always reaching the
// agent, off/shadow unchanged, and the MK regression in all three modes.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentGovernancePolicies,
  agentStewardships,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_AGENT_GOVERNANCE_POLICY, buildSkillMentionHref } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { activityRows, setAccessMode, setAccessPolicy, wouldRefuseRows } from "./helpers/agent-access-fixtures.js";
import { ACCESS_POLICY_BLOCKER_NOTE_PREFIX, heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { listStoppedAgentIssues } from "../services/stopped-agent-issues.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.ts";
import { resetRunLogStoreForTests } from "../services/run-log-store.ts";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FAKE_ADAPTER = "agent_access_enforce_heartbeat_test";
const ALL_VIA = ["assign", "comment_wake", "mention", "handoff"] as const;

type Mode = "off" | "shadow" | "enforce";
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

describeEmbeddedPostgres("V2 access enforce in the heartbeat (APM gate 3, P3.4)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const receivedConfig = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY", "RUN_LOG_BASE_PATH"]) {
      saved[key] = process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), "agent-access-enforce-heartbeat-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "agent-access-enforce-heartbeat-test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "e".repeat(64);
    process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-access-enforce-heartbeat-");
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
      name: `Enforce ${companyId.slice(0, 6)}`,
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      productProfile,
      requireBoardApprovalForNewAgents: false,
    });
    await setAccessMode(db, companyId, mode);
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, values: Partial<typeof agents.$inferInsert> = {}) {
    const id = randomUUID();
    const adapterType = values.adapterType ?? "process";
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
      ...values,
    });
    return id;
  }

  async function seedMember(companyId: string, membershipRole: "member" | "admin") {
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole });
    return userId;
  }

  async function seedProject(companyId: string) {
    return db.insert(projects).values({ companyId, name: `Project ${randomUUID().slice(0, 6)}` }).returning().then((rows) => rows[0]!);
  }

  async function seedIssue(companyId: string, assigneeAgentId: string, values: { projectId?: string | null; description?: string } = {}) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Enforced access task",
      status: "todo",
      priority: "medium",
      assigneeAgentId,
      projectId: values.projectId ?? null,
      description: values.description ?? null,
    });
    return id;
  }

  function detailsOf(row: { details: unknown }) {
    return row.details as Record<string, unknown>;
  }

  async function refusedRows(companyId: string, site?: string) {
    const rows = await activityRows(db, companyId, "authz.refused");
    return site ? rows.filter((row) => detailsOf(row).site === site) : rows;
  }

  async function issueRow(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  async function notes(issueId: string) {
    return db
      .select({ body: issueComments.body, authorAgentId: issueComments.authorAgentId })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(desc(issueComments.createdAt));
  }

  // -------------------------------------------------------------------------
  // heartbeat.run_claim
  // -------------------------------------------------------------------------

  async function runClaimScenario(mode: Mode) {
    const companyId = await seedCompany(mode);
    const accountableUserId = await seedMember(companyId, "member");
    const agentId = await seedAgent(companyId, "Worker", { accountableUserId });
    const project = await seedProject(companyId);
    const issueId = await seedIssue(companyId, agentId, { projectId: project.id });
    await setAccessPolicy(db, companyId, agentId, { request: { see: { projects: { mode: "listed", ids: [] } } } });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const run = await heartbeat.wakeup(agentId, { source: "assignment", reason: "issue_assigned", contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    return { companyId, agentId, accountableUserId, project, issueId, heartbeat, runId: run!.id, stored: await runRow(db, run!.id) };
  }

  it("heartbeat.run_claim, enforce: the run is not started, the issue gets one blocker note and is blocked, and it reaches the owner as stopped-and-needs-you", async () => {
    const s = await runClaimScenario("enforce");
    expect(s.stored.status).toBe("cancelled");
    expect(s.stored.errorCode).toBe("access_policy_refused");
    expect(s.stored.startedAt ?? null).toBeNull();

    const issue = await issueRow(s.issueId);
    expect(issue.status).toBe("blocked");
    expect(issue.executionRunId).toBeNull();
    const posted = await notes(s.issueId);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.startsWith(ACCESS_POLICY_BLOCKER_NOTE_PREFIX)).toBe(true);
    expect(posted[0]!.authorAgentId).toBe(s.agentId);

    // The existing owner path: a blocked issue of an agent the person answers for.
    const stopped = await listStoppedAgentIssues(db, { companyId: s.companyId, agentIds: [s.agentId] });
    expect(stopped.items.map((item) => item.id)).toEqual([s.issueId]);

    const refused = await refusedRows(s.companyId, "heartbeat.run_claim");
    expect(refused).toHaveLength(1);
    expect(detailsOf(refused[0]!)).toMatchObject({
      reasonCode: "ACCESS_POLICY_REFUSED",
      dimension: "see.projects",
      policyMode: "enforce",
      target: { projectId: s.project.id },
      issueId: s.issueId,
    });

    // A second refused run does not stack a second note.
    const again = await s.heartbeat.wakeup(s.agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId: s.issueId } });
    if (again) expect((await runRow(db, again.id)).status).toBe("cancelled");
    expect(await notes(s.issueId)).toHaveLength(1);
  });

  it("heartbeat.run_claim, off and shadow: the run is claimed exactly as gate 2", async () => {
    for (const mode of ["off", "shadow"] as const) {
      const s = await runClaimScenario(mode);
      expect(s.stored.status, mode).toBe("running");
      expect((await issueRow(s.issueId)).status).not.toBe("blocked");
      expect(await notes(s.issueId)).toHaveLength(0);
      expect(await refusedRows(s.companyId)).toHaveLength(0);
    }
  });

  // -------------------------------------------------------------------------
  // heartbeat.context_hydration (a run claimed before the narrowing)
  // -------------------------------------------------------------------------

  it("heartbeat.context_hydration, enforce: a run claimed before enforcement never reaches the adapter — not started, noted, blocked", async () => {
    const companyId = await seedCompany("off");
    const agentId = await seedAgent(companyId, "Runner", { adapterType: FAKE_ADAPTER });
    const project = await seedProject(companyId);
    const issueId = await seedIssue(companyId, agentId, { projectId: project.id });
    await setAccessPolicy(db, companyId, agentId, { request: { see: { projects: { mode: "listed", ids: [] } } } });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const run = await heartbeat.wakeup(agentId, { source: "assignment", reason: "issue_assigned", contextSnapshot: { issueId } });
    expect((await runRow(db, run!.id)).status).toBe("running");

    await setAccessMode(db, companyId, "enforce");
    await heartbeat.executeRun(run!.id);
    const stored = await runRow(db, run!.id);
    expect(stored.status).toBe("cancelled");
    expect(stored.errorCode).toBe("access_policy_refused");
    expect(receivedConfig.has(run!.id)).toBe(false);
    expect((await issueRow(issueId)).status).toBe("blocked");
    expect((await notes(issueId))[0]?.body.startsWith(ACCESS_POLICY_BLOCKER_NOTE_PREFIX)).toBe(true);
    const wake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, stored.wakeupRequestId!)).then((rows) => rows[0]!);
    expect(wake.status).toBe("skipped");
    const refused = await refusedRows(companyId, "heartbeat.context_hydration");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.runId).toBe(run!.id);
  });

  // -------------------------------------------------------------------------
  // heartbeat.runtime_skills
  // -------------------------------------------------------------------------

  async function skillRun(mode: Mode) {
    const companyId = await seedCompany(mode);
    const agentId = await seedAgent(companyId, "Runner", { adapterType: FAKE_ADAPTER });
    const skill = await db
      .insert(companySkills)
      .values({ companyId, key: "release-notes", slug: "release-notes", name: "Release notes", markdown: "# Release notes\n\nWrite them." })
      .returning()
      .then((rows) => rows[0]!);
    const issueId = await seedIssue(companyId, agentId, {
      description: `Please use [/release-notes](${buildSkillMentionHref(skill.id, skill.slug)}) for this.`,
    });
    await setAccessPolicy(db, companyId, agentId, { request: { do: { skills: { mode: "listed", ids: [] } } } });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "assignment", reason: "issue_assigned", contextSnapshot: { issueId } });
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    return { companyId, runId: run!.id, status: finished?.status, config: receivedConfig.get(run!.id) ?? null };
  }

  it("heartbeat.runtime_skills, enforce: a mentioned skill outside do.skills is dropped from the run and logged; off and shadow still add it", async () => {
    const enforced = await skillRun("enforce");
    expect(enforced.status).toBe("succeeded");
    expect(readPaperclipSkillSyncPreference(enforced.config!).desiredSkills).not.toContain("release-notes");
    const refused = await refusedRows(enforced.companyId, "heartbeat.runtime_skills");
    expect(refused).toHaveLength(1);
    expect(detailsOf(refused[0]!)).toMatchObject({ dimension: "do.skills", target: { skillKey: "release-notes" }, policyMode: "enforce" });
    expect(refused[0]!.runId).toBe(enforced.runId);

    for (const mode of ["off", "shadow"] as const) {
      const run = await skillRun(mode);
      expect(run.status, mode).toBe("succeeded");
      expect(readPaperclipSkillSyncPreference(run.config!).desiredSkills, mode).toContain("release-notes");
      expect(await refusedRows(run.companyId)).toHaveLength(0);
    }
  }, 90_000);

  // -------------------------------------------------------------------------
  // wake.dispatch: comment kept, wake withheld
  // -------------------------------------------------------------------------

  async function agentWake(mode: Mode, reason: "issue_assigned" | "issue_commented", productProfile: "default" | "agentdash_mk" = "default") {
    const companyId = await seedCompany(mode, productProfile);
    const sourceId = await seedAgent(companyId, "Sender");
    const recipientId = await seedAgent(companyId, "Receiver");
    const issueId = await seedIssue(companyId, recipientId);
    await setAccessPolicy(db, companyId, sourceId, { request: { talk: { agents: { mode: "listed", agentIds: [], via: [...ALL_VIA] } } } });
    const comment = reason === "issue_commented"
      ? await issueService(db).addComment(issueId, "Can you take a look at this?", { agentId: sourceId })
      : null;
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const run = await heartbeat.wakeup(recipientId, {
      source: "automation",
      triggerDetail: "system",
      reason,
      payload: { issueId, ...(comment ? { commentId: comment.id } : {}) },
      requestedByActorType: "agent",
      requestedByActorId: sourceId,
      contextSnapshot: { issueId, wakeReason: reason, ...(comment ? { wakeCommentId: comment.id } : {}) },
    });
    const wakes = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, recipientId)));
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, recipientId));
    return { companyId, sourceId, recipientId, issueId, comment, run, wakes, runs };
  }

  it("wake.dispatch, enforce: an agent's comment is kept but the wake to an agent outside its talk.agents scope is withheld (skipped, no run)", async () => {
    const s = await agentWake("enforce", "issue_commented");
    expect(s.run).toBeNull();
    expect(s.runs).toHaveLength(0);
    expect(s.wakes).toEqual([{ status: "skipped", reason: "access_policy_refused" }]);
    const kept = await db.select().from(issueComments).where(eq(issueComments.id, s.comment!.id));
    expect(kept).toHaveLength(1);
    const refused = await refusedRows(s.companyId, "wake.dispatch");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.actorId).toBe(s.sourceId);
    expect(detailsOf(refused[0]!)).toMatchObject({ dimension: "talk.agents", via: "comment_wake", target: { agentId: s.recipientId }, policyMode: "enforce" });

    const assigned = await agentWake("enforce", "issue_assigned");
    expect(assigned.run).toBeNull();
    expect(assigned.wakes).toEqual([{ status: "skipped", reason: "access_policy_refused" }]);
  });

  it("wake.dispatch, off and shadow: the same wake is queued exactly as gate 2", async () => {
    for (const mode of ["off", "shadow"] as const) {
      const s = await agentWake(mode, "issue_commented");
      expect(s.run, mode).not.toBeNull();
      expect(s.runs).toHaveLength(1);
      expect(await refusedRows(s.companyId)).toHaveLength(0);
    }
  });

  async function personWake(sourceRole: "member" | "admin" | "accountable" | "steward") {
    const companyId = await seedCompany("enforce", sourceRole === "steward" ? "agentdash_mk" : "default");
    const accountableUserId = await seedMember(companyId, "member");
    const recipientId = await seedAgent(companyId, "Receiver", { accountableUserId });
    let userId: string;
    if (sourceRole === "accountable") userId = accountableUserId;
    else if (sourceRole === "steward") {
      userId = await seedMember(companyId, "member");
      await db.insert(agentStewardships).values({ companyId, agentId: recipientId, userId });
    } else userId = await seedMember(companyId, sourceRole);
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
    return { companyId, run };
  }

  it("wake.dispatch, enforce: a person outside the agent's inbound scope is withheld; admins, the steward and the accountable person always reach it", async () => {
    const outsider = await personWake("member");
    expect(outsider.run).toBeNull();
    expect(detailsOf((await refusedRows(outsider.companyId, "wake.dispatch"))[0]!)).toMatchObject({ dimension: "talk.inbound", via: "assign" });

    for (const role of ["admin", "steward", "accountable"] as const) {
      const reached = await personWake(role);
      expect(reached.run, role).not.toBeNull();
      expect(await refusedRows(reached.companyId), role).toHaveLength(0);
    }
  });

  // -------------------------------------------------------------------------
  // MK regression: V1-only policies behave the same in all three modes
  // -------------------------------------------------------------------------

  it("MK companies with a V1-only policy: claim and wake behave the same in off, shadow and enforce", async () => {
    const results: Array<{ mode: Mode; runStatus: string; wakeStatuses: string[] }> = [];
    for (const mode of ["off", "shadow", "enforce"] as const) {
      const companyId = await seedCompany(mode, "agentdash_mk");
      const stewardUserId = await seedMember(companyId, "member");
      const sourceId = await seedAgent(companyId, "Sender");
      const recipientId = await seedAgent(companyId, "Receiver");
      await db.insert(agentStewardships).values({ companyId, agentId: recipientId, userId: stewardUserId });
      for (const agentId of [sourceId, recipientId]) {
        await db.insert(agentGovernancePolicies).values({
          companyId,
          agentId,
          ownerCeiling: { ...DEFAULT_AGENT_GOVERNANCE_POLICY },
          stewardRequest: { ...DEFAULT_AGENT_GOVERNANCE_POLICY },
          effectivePolicy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY },
        });
      }
      const project = await seedProject(companyId);
      const issueId = await seedIssue(companyId, recipientId, { projectId: project.id });
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
      expect(run, mode).not.toBeNull();
      const wakes = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, recipientId));
      results.push({ mode, runStatus: (await runRow(db, run!.id)).status, wakeStatuses: wakes.map((wake) => wake.status).sort() });
      expect(await refusedRows(companyId), mode).toHaveLength(0);
      expect(await wouldRefuseRows(db, companyId), mode).toHaveLength(0);
    }
    expect(results[1]!.runStatus).toBe(results[0]!.runStatus);
    expect(results[2]!.runStatus).toBe(results[0]!.runStatus);
    expect(results[1]!.wakeStatuses).toEqual(results[0]!.wakeStatuses);
    expect(results[2]!.wakeStatuses).toEqual(results[0]!.wakeStatuses);
  });
});
