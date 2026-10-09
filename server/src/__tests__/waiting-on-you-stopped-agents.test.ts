import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentStewardships, companies, companyMemberships, createDb, issueRelations, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assistantRoutes } from "../routes/assistant.js";
import { errorHandler } from "../middleware/index.js";
import { stewardInboxService } from "../services/steward-inbox.js";
import { waitingOnYouService } from "../services/waiting-on-you.js";
import { listStoppedAgentIssues } from "../services/stopped-agent-issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: an agent that needs its steward comments and blocks the issue.
 * The bridge digest listed that under "Stopped and needs you"; the web
 * "waiting on you" did not, so a steward working in the browser never saw it.
 * Both now read one definition: blocked, not hidden, assigned to an agent the
 * person answers for.
 */
describeEmbeddedPostgres("waiting on you: issues a person's agent has blocked", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-waiting-stopped-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** One company per test: a steward, their agent, and another steward's agent. */
  async function fixture() {
    const companyId = randomUUID();
    const stewardA = `user-${randomUUID()}`;
    const stewardB = `user-${randomUUID()}`;
    const agentA = randomUUID();
    const agentB = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped Co", issuePrefix: `S${companyId.slice(0, 4).toUpperCase()}` });
    await db.insert(companyMemberships).values([stewardA, stewardB].map((principalId) => ({
      companyId, principalType: "user", principalId, status: "active", membershipRole: "member",
    })));
    await db.insert(agents).values([
      { id: agentA, companyId, name: "Agent A", role: "general" },
      { id: agentB, companyId, name: "Agent B", role: "general" },
    ]);
    await db.insert(agentStewardships).values([
      { companyId, agentId: agentA, userId: stewardA },
      { companyId, agentId: agentB, userId: stewardB },
    ]);
    const actor = (userId: string) => ({
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "member", status: "active" }],
    });
    return { companyId, stewardA, stewardB, agentA, agentB, actor };
  }

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    a.use("/api", assistantRoutes(db));
    a.use(errorHandler);
    return a;
  }

  async function pending(companyId: string, actor: Record<string, unknown>) {
    const res = await request(app(actor)).get(`/api/companies/${companyId}/assistant/pending-decisions`);
    expect(res.status).toBe(200);
    return res.body as {
      stoppedAgentIssues: Array<{ issueId: string; title: string; agentName: string | null; identifier: string | null; waitingSince: string }>;
      stoppedAgentIssuesTotal: number;
    };
  }

  it("lists an issue the steward's own agent blocked, and not another steward's or a non-blocked one", async () => {
    const f = await fixture();
    const mine = randomUUID();
    const theirs = randomUUID();
    const working = randomUUID();
    const hidden = randomUUID();
    await db.insert(issues).values([
      { id: mine, companyId: f.companyId, title: "Needs Steward A", status: "blocked", assigneeAgentId: f.agentA },
      { id: theirs, companyId: f.companyId, title: "Needs Steward B", status: "blocked", assigneeAgentId: f.agentB },
      { id: working, companyId: f.companyId, title: "Still going", status: "in_progress", assigneeAgentId: f.agentA },
      { id: hidden, companyId: f.companyId, title: "Hidden", status: "blocked", assigneeAgentId: f.agentA, hiddenAt: new Date() },
    ]);

    const body = await pending(f.companyId, f.actor(f.stewardA));
    expect(body.stoppedAgentIssues.map((item) => item.issueId)).toEqual([mine]);
    expect(body.stoppedAgentIssuesTotal).toBe(1);
    expect(body.stoppedAgentIssues[0]).toMatchObject({ title: "Needs Steward A", agentName: "Agent A" });
  });

  it("agrees with the bridge digest's stopped list for the same person", async () => {
    const f = await fixture();
    const older = randomUUID();
    const newer = randomUUID();
    await db.insert(issues).values([
      { id: older, companyId: f.companyId, title: "First stop", status: "blocked", assigneeAgentId: f.agentA, updatedAt: new Date(Date.now() - 3_600_000) },
      { id: newer, companyId: f.companyId, title: "Second stop", status: "blocked", assigneeAgentId: f.agentA },
      { id: randomUUID(), companyId: f.companyId, title: "Steward B's stop", status: "blocked", assigneeAgentId: f.agentB },
    ]);

    const web = await waitingOnYouService(db).list(f.companyId, f.actor(f.stewardA));
    const digest = await stewardInboxService(db).buildDigest({ id: null, companyId: f.companyId, userId: f.stewardA });
    const digestIds = (digest.blockers.items as Array<{ issueId: string }>).map((item) => item.issueId);
    expect(web.stoppedAgentIssues.map((item) => item.issueId)).toEqual([older, newer]);
    expect(digestIds).toEqual([older, newer]);
    expect(web.stoppedAgentIssuesTotal).toBe(digest.blockers.total);
  });

  it("keeps a blocked issue in a restricted project off a member's web list", async () => {
    const f = await fixture();
    const project = randomUUID();
    const restricted = randomUUID();
    await db.insert(projects).values({ id: project, companyId: f.companyId, name: "Board only", visibility: "restricted", createdByUserId: f.stewardB });
    await db.insert(issues).values({ id: restricted, companyId: f.companyId, projectId: project, title: "Restricted stop", status: "blocked", assigneeAgentId: f.agentA });

    const body = await pending(f.companyId, f.actor(f.stewardA));
    expect(body.stoppedAgentIssues.map((item) => item.issueId)).not.toContain(restricted);
    expect(JSON.stringify(body)).not.toContain("Restricted stop");
  });

  it("leaves out an issue still waiting on an unresolved blocker issue, in both lists", async () => {
    const f = await fixture();
    const dependent = randomUUID();
    const blocker = randomUUID();
    const unblocked = randomUUID();
    const doneBlocker = randomUUID();
    await db.insert(issues).values([
      { id: blocker, companyId: f.companyId, title: "Upstream work", status: "in_progress", assigneeAgentId: f.agentB },
      { id: dependent, companyId: f.companyId, title: "Waits on upstream", status: "blocked", assigneeAgentId: f.agentA },
      { id: doneBlocker, companyId: f.companyId, title: "Finished upstream", status: "done", assigneeAgentId: f.agentB },
      { id: unblocked, companyId: f.companyId, title: "Needs Steward A now", status: "blocked", assigneeAgentId: f.agentA },
    ]);
    await db.insert(issueRelations).values([
      { companyId: f.companyId, issueId: blocker, relatedIssueId: dependent, type: "blocks" },
      // A finished blocker no longer holds anything up: the stop is the person's.
      { companyId: f.companyId, issueId: doneBlocker, relatedIssueId: unblocked, type: "blocks" },
    ]);

    const web = await waitingOnYouService(db).list(f.companyId, f.actor(f.stewardA));
    const digest = await stewardInboxService(db).buildDigest({ id: null, companyId: f.companyId, userId: f.stewardA });
    expect(web.stoppedAgentIssues.map((item) => item.issueId)).toEqual([unblocked]);
    expect((digest.blockers.items as Array<{ issueId: string }>).map((item) => item.issueId)).toEqual([unblocked]);
  });

  it("leaves out issues the server blocked for recovery, in both lists", async () => {
    const f = await fixture();
    const exhausted = randomUUID();
    const recoveryIssue = randomUUID();
    const needsPerson = randomUUID();
    await db.insert(issues).values([
      {
        id: exhausted, companyId: f.companyId, title: "Retries ran out", status: "blocked", assigneeAgentId: f.agentA,
        executionState: { recoveryBudget: { status: "exhausted", exhaustedAt: new Date().toISOString() } },
      },
      { id: recoveryIssue, companyId: f.companyId, title: "Recover stranded work", status: "blocked", assigneeAgentId: f.agentA, originKind: "stranded_issue_recovery" },
      { id: needsPerson, companyId: f.companyId, title: "Needs Steward A", status: "blocked", assigneeAgentId: f.agentA },
    ]);

    const web = await waitingOnYouService(db).list(f.companyId, f.actor(f.stewardA));
    const digest = await stewardInboxService(db).buildDigest({ id: null, companyId: f.companyId, userId: f.stewardA });
    expect(web.stoppedAgentIssues.map((item) => item.issueId)).toEqual([needsPerson]);
    expect((digest.blockers.items as Array<{ issueId: string }>).map((item) => item.issueId)).toEqual([needsPerson]);
    expect(web.stoppedAgentIssuesTotal).toBe(1);
  });

  it("caps the rows it reads but still reports the full count", async () => {
    const f = await fixture();
    const count = 30;
    await db.insert(issues).values(Array.from({ length: count }, (_, index) => ({
      id: randomUUID(), companyId: f.companyId, title: `Stop ${index}`, status: "blocked", assigneeAgentId: f.agentA,
    })));
    const rows = await listStoppedAgentIssues(db, { companyId: f.companyId, agentIds: [f.agentA], limit: 5 });
    expect(rows.items).toHaveLength(5);
    expect(rows.total).toBe(count);
    const digest = await stewardInboxService(db).buildDigest({ id: null, companyId: f.companyId, userId: f.stewardA });
    expect(digest.blockers.total).toBe(count);
    expect(digest.blockers.shown).toBe(10);
  });
});
