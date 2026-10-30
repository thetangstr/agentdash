import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issueResponsibilities,
  issues,
  projects,
  routineTriggers,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { profileBody, responsibility, seedActiveProfile } from "./helpers/responsibility-fixtures.js";
import { routineService } from "../services/routines.ts";

// The real hook, with a switch that makes it throw, to prove a failure never changes dispatch.
const hook = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("../services/issue-responsibilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-responsibilities.js")>();
  return {
    ...actual,
    recordRoutineDispatchResponsibility: async (...args: Parameters<typeof actual.recordRoutineDispatchResponsibility>) => {
      hook.calls += 1;
      if (hook.fail) throw new Error("responsibility hook failure");
      return actual.recordRoutineDispatchResponsibility(...args);
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: Agent Performance Management gate 2 (P2.4) — the routine dispatch
 * hook. A run whose trigger is bound to a responsibility in the assignee's
 * ACTIVE profile maps the created issue to it (`mapped_by = routine`); any
 * other run writes nothing; and nothing the hook does changes the dispatch.
 */
describeEmbeddedPostgres("routine dispatch responsibility hook", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-responsibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    hook.fail = false;
    hook.calls = 0;
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Routines", issuePrefix: `RH${randomUUID().slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Reporter", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Reports", status: "in_progress" }).returning();
    const svc = routineService(db, {
      heartbeat: {
        // The production wake contract, as routines-service.test.ts fakes it: a queued run that holds the issue.
        wakeup: async (wakeAgentId, opts) => {
          const issueId =
            (typeof opts.payload?.issueId === "string" && opts.payload.issueId) ||
            (typeof opts.contextSnapshot?.issueId === "string" && opts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const runId = randomUUID();
          await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: wakeAgentId, invocationSource: opts.source ?? "assignment", status: "queued", contextSnapshot: { ...(opts.contextSnapshot ?? {}), issueId } });
          await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
          return { id: runId };
        },
      },
    });
    const routine = await svc.create(
      companyId,
      {
        projectId: project!.id,
        goalId: null,
        parentIssueId: null,
        title: "Weekly report",
        description: "Write the weekly report",
        assigneeAgentId: agent!.id,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    const [bound, unbound] = await db
      .insert(routineTriggers)
      .values([
        { companyId, routineId: routine.id, kind: "api", label: "bound" },
        { companyId, routineId: routine.id, kind: "api", label: "unbound" },
      ])
      .returning();
    const { revisionId } = await seedActiveProfile(db, {
      companyId,
      agentId: agent!.id,
      body: profileBody([
        responsibility("weekly-report", { obligation: { kind: "routine", routineTriggerId: bound!.id } }),
        responsibility("ad-hoc"),
      ]),
    });
    return { companyId, agentId: agent!.id, routine, svc, bound: bound!, unbound: unbound!, revisionId };
  }

  const rowsFor = (issueId: string) => db.select().from(issueResponsibilities).where(eq(issueResponsibilities.issueId, issueId));
  /** One open live execution issue per routine is allowed; close each before the next dispatch. */
  const close = (issueId: string | null) =>
    db.update(issues).set({ status: "done", executionRunId: null, executionLockedAt: null }).where(eq(issues.id, issueId!));

  it("maps the created issue when the dispatched trigger is bound in the assignee's active profile", async () => {
    const s = await seed();
    const run = await s.svc.runRoutine(s.routine.id, { source: "manual", triggerId: s.bound.id });
    expect(run.status).toBe("issue_created");
    const rows = await rowsFor(run.linkedIssueId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: s.agentId, responsibilityKey: "weekly-report", profileRevisionId: s.revisionId, mappedBy: "routine", mappedByActorId: null, validTo: null });
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "issue.responsibility_mapped")));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: "system", actorId: "routine-dispatch", entityType: "issue", entityId: run.linkedIssueId });
  });

  it("writes nothing for an unbound trigger, a run without a trigger, or an assignee with no active profile", async () => {
    const s = await seed();
    const unbound = await s.svc.runRoutine(s.routine.id, { source: "manual", triggerId: s.unbound.id });
    await close(unbound.linkedIssueId);
    const manual = await s.svc.runRoutine(s.routine.id, { source: "manual" });
    await close(manual.linkedIssueId);
    expect([unbound.status, manual.status]).toEqual(["issue_created", "issue_created"]);
    expect(await rowsFor(unbound.linkedIssueId!)).toHaveLength(0);
    expect(await rowsFor(manual.linkedIssueId!)).toHaveLength(0);

    // The trigger is bound in the OTHER agent's profile only: the assignee's own profile decides.
    const [other] = await db
      .insert(agents)
      .values({ companyId: s.companyId, name: "Other", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    const reassigned = await s.svc.runRoutine(s.routine.id, { source: "manual", triggerId: s.bound.id, assigneeAgentId: other!.id });
    expect(reassigned.status).toBe("issue_created");
    expect(await rowsFor(reassigned.linkedIssueId!)).toHaveLength(0);
    expect(await db.select().from(issueResponsibilities)).toHaveLength(0);
  });

  it("never changes the dispatch when the hook fails", async () => {
    const s = await seed();
    hook.fail = true;
    const run = await s.svc.runRoutine(s.routine.id, { source: "manual", triggerId: s.bound.id });
    expect(hook.calls).toBe(1);
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    const [issue] = await db.select().from(issues).where(eq(issues.id, run.linkedIssueId!));
    expect(issue).toMatchObject({ assigneeAgentId: s.agentId, status: "todo", originKind: "routine_execution" });
    expect(issue!.executionRunId).toBeTruthy(); // the wake still happened
    expect(await rowsFor(run.linkedIssueId!)).toHaveLength(0);
  });
});
