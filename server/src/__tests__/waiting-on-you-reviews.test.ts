import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, issues, issueWorkProducts, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assistantRoutes } from "../routes/assistant.js";
import { errorHandler } from "../middleware/index.js";
import { waitingOnYouService } from "../services/waiting-on-you.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (MVP launch lane B, item 5): a CEO created ACM-1 for an agent; the
 * agent shipped a document and moved the issue to in_review. Nothing told the
 * CEO a review was waiting. Reviews are now part of "waiting on you", scoped
 * to the company and to the projects the person can see.
 */
describeEmbeddedPostgres("waiting on you: deliverables waiting for review", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OTHER_COMPANY = randomUUID();
  const CEO = `user-${randomUUID()}`;
  const MEMBER = `user-${randomUUID()}`;
  const OTHER_USER = `user-${randomUUID()}`;
  const AGENT = randomUUID();
  const RESTRICTED = randomUUID();
  const I_CREATED = randomUUID();
  const I_WITH_DELIVERABLE = randomUUID();
  const I_OTHERS_REQUEST = randomUUID();
  const I_RESTRICTED = randomUUID();
  const I_ASSIGNED_TO_OTHER_HUMAN = randomUUID();
  const I_DONE = randomUUID();
  const I_HIDDEN = randomUUID();
  const I_OTHER_COMPANY = randomUUID();
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-waiting-reviews-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: COMPANY, name: "Acme", issuePrefix: "ACM" },
      { id: OTHER_COMPANY, name: "Elsewhere", issuePrefix: "ELS" },
    ]);
    await db.insert(companyMemberships).values([
      { companyId: COMPANY, principalType: "user", principalId: CEO, status: "active", membershipRole: "owner" },
      { companyId: COMPANY, principalType: "user", principalId: MEMBER, status: "active", membershipRole: "member" },
      { companyId: COMPANY, principalType: "user", principalId: OTHER_USER, status: "active", membershipRole: "member" },
    ]);
    await db.insert(agents).values({ id: AGENT, companyId: COMPANY, name: "Maya", role: "engineer" });
    await db.insert(projects).values({ id: RESTRICTED, companyId: COMPANY, name: "Board only", visibility: "restricted", createdByUserId: CEO });
    await db.insert(issues).values([
      // The live case: the CEO filed it for an agent, the agent moved it to review.
      { id: I_CREATED, companyId: COMPANY, title: "Write the launch brief", status: "in_review", identifier: "ACM-1",
        assigneeAgentId: AGENT, createdByUserId: CEO, updatedAt: hoursAgo(2) },
      // Filed by someone else, but a deliverable is waiting and no human is named.
      { id: I_WITH_DELIVERABLE, companyId: COMPANY, title: "Draft the FAQ", status: "in_review", identifier: "ACM-2",
        assigneeAgentId: AGENT, createdByUserId: OTHER_USER, updatedAt: hoursAgo(1) },
      // In review, no deliverable, someone else's request: theirs, not the CEO's.
      { id: I_OTHERS_REQUEST, companyId: COMPANY, title: "Someone else's ask", status: "in_review", identifier: "ACM-3",
        assigneeAgentId: AGENT, createdByUserId: OTHER_USER },
      // A deliverable in a restricted project: only admins and the access list see it.
      { id: I_RESTRICTED, companyId: COMPANY, projectId: RESTRICTED, title: "Board pack", status: "in_review", identifier: "ACM-4",
        assigneeAgentId: AGENT, createdByUserId: CEO },
      // A deliverable waiting on a named human is that human's (assigned-to-you list).
      { id: I_ASSIGNED_TO_OTHER_HUMAN, companyId: COMPANY, title: "Legal review", status: "in_review", identifier: "ACM-5",
        assigneeUserId: OTHER_USER, createdByUserId: OTHER_USER },
      { id: I_DONE, companyId: COMPANY, title: "Already accepted", status: "done", identifier: "ACM-6", assigneeAgentId: AGENT, createdByUserId: CEO },
      { id: I_HIDDEN, companyId: COMPANY, title: "Hidden", status: "in_review", identifier: "ACM-7", assigneeAgentId: AGENT, createdByUserId: CEO, hiddenAt: new Date() },
      { id: I_OTHER_COMPANY, companyId: OTHER_COMPANY, title: "Elsewhere", status: "in_review", identifier: "ELS-1", createdByUserId: CEO },
    ]);
    const product = (issueId: string, companyId = COMPANY, projectId: string | null = null) => ({
      companyId, issueId, projectId, type: "document", provider: "paperclip", title: "Deliverable", status: "ready_for_review", reviewState: "needs_board_review",
    });
    await db.insert(issueWorkProducts).values([
      product(I_CREATED),
      product(I_WITH_DELIVERABLE),
      product(I_RESTRICTED, COMPANY, RESTRICTED),
      product(I_ASSIGNED_TO_OTHER_HUMAN),
      product(I_OTHER_COMPANY, OTHER_COMPANY),
    ]);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function actorFor(userId: string, role: string) {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [COMPANY],
      memberships: [{ companyId: COMPANY, membershipRole: role, status: "active" }],
    };
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

  async function pending(actor: Record<string, unknown>) {
    const res = await request(app(actor)).get(`/api/companies/${COMPANY}/assistant/pending-decisions`);
    expect(res.status).toBe(200);
    return res.body as {
      reviewsWaiting: Array<{ issueId: string; summary: string; submittedBy: string | null; readyForReviewCount: number; requestedByYou: boolean }>;
      reviewsWaitingTotal: number;
    };
  }

  it("an issue the CEO created that an agent moved to in_review is waiting on the CEO, as a review", async () => {
    const body = await pending(actorFor(CEO, "owner"));
    const ids = body.reviewsWaiting.map((r) => r.issueId);
    expect(ids).toContain(I_CREATED);
    const brief = body.reviewsWaiting.find((r) => r.issueId === I_CREATED)!;
    expect(brief).toMatchObject({ summary: "Review: Write the launch brief", submittedBy: "Maya", readyForReviewCount: 1, requestedByYou: true });
  });

  it("lists visible in_review issues with a ready_for_review deliverable, and nothing else", async () => {
    const body = await pending(actorFor(CEO, "owner"));
    // The owner is an admin and sees the restricted project.
    expect(body.reviewsWaiting.map((r) => r.issueId).sort()).toEqual([I_CREATED, I_WITH_DELIVERABLE, I_RESTRICTED].sort());
    expect(body.reviewsWaitingTotal).toBe(3);
  });

  it("a member off a restricted project's list never sees its review", async () => {
    const body = await pending(actorFor(MEMBER, "member"));
    // Deliverables in open projects are visible to every member; the
    // restricted project's ACM-4 is not.
    expect(body.reviewsWaiting.map((r) => r.issueId).sort()).toEqual([I_CREATED, I_WITH_DELIVERABLE].sort());
    expect(body.reviewsWaitingTotal).toBe(2);
    expect(body.reviewsWaiting.every((r) => r.requestedByYou === false)).toBe(true);
  });

  it("the person who asked sees their in_review issue even without a deliverable", async () => {
    const body = await pending(actorFor(OTHER_USER, "member"));
    const ids = body.reviewsWaiting.map((r) => r.issueId).sort();
    // ACM-3 is theirs with no deliverable; ACM-5 is already assigned to them,
    // so it is in their assigned list and not counted twice; ACM-4 is
    // restricted.
    expect(ids).toEqual([I_CREATED, I_OTHERS_REQUEST, I_WITH_DELIVERABLE].sort());
    expect(body.reviewsWaiting.find((r) => r.issueId === I_OTHERS_REQUEST)?.requestedByYou).toBe(true);
  });

  it("the service and the route agree", async () => {
    const actor = actorFor(CEO, "owner");
    const [route, direct] = await Promise.all([pending(actor), waitingOnYouService(db).list(COMPANY, actor)]);
    expect(JSON.parse(JSON.stringify(direct.reviewsWaiting))).toEqual(route.reviewsWaiting);
    expect(direct.reviewsWaitingTotal).toBe(route.reviewsWaitingTotal);
  });
});
