import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentStewardships, companies, companyMemberships, createDb, issues, issueWorkProducts, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assistantRoutes } from "../routes/assistant.js";
import { errorHandler } from "../middleware/index.js";
import { waitingOnYouService } from "../services/waiting-on-you.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (MVP launch lane B, item 5): a CEO created ACM-1 for an agent; the
 * agent shipped a document and moved the issue to in_review. Nothing told the
 * CEO a review was waiting. Reviews are now part of "waiting on you":
 *   - the person who asked for the work sees it;
 *   - agent-filed work with a deliverable goes to the agent's steward or
 *     accountable person, and to company admins only when it has neither;
 *   - the composed issue visibility rule applies (restricted projects and
 *     owner-only agents), and so does the agent visibility of the name shown.
 */
describeEmbeddedPostgres("waiting on you: deliverables waiting for review", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OTHER_COMPANY = randomUUID();
  const CEO = `user-${randomUUID()}`;
  const MEMBER = `user-${randomUUID()}`;
  const OTHER_USER = `user-${randomUUID()}`;
  const MAYA = randomUUID(); // company-visible, no steward
  const THEO = randomUUID(); // company-visible, stewarded by MEMBER
  const CIPHER = randomUUID(); // owner-only, created by the CEO
  const RESTRICTED = randomUUID();
  const I_CREATED = randomUUID();
  const I_OTHERS_REQUEST = randomUUID();
  const I_OTHERS_DELIVERABLE = randomUUID();
  const I_AGENT_FILED_STEWARDED = randomUUID();
  const I_AGENT_FILED_UNOWNED = randomUUID();
  const I_RESTRICTED = randomUUID();
  const I_SECRET = randomUUID();
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
    await db.insert(agents).values([
      { id: MAYA, companyId: COMPANY, name: "Maya", role: "engineer" },
      { id: THEO, companyId: COMPANY, name: "Theo", role: "engineer" },
      { id: CIPHER, companyId: COMPANY, name: "Cipher", role: "engineer", visibility: "owner", createdByUserId: CEO },
    ]);
    await db.insert(agentStewardships).values({ companyId: COMPANY, agentId: THEO, userId: MEMBER });
    await db.insert(projects).values({ id: RESTRICTED, companyId: COMPANY, name: "Board only", visibility: "restricted", createdByUserId: CEO });
    await db.insert(issues).values([
      // The live case: the CEO filed it for an agent, the agent moved it to review.
      { id: I_CREATED, companyId: COMPANY, title: "Write the launch brief", status: "in_review", identifier: "ACM-1",
        assigneeAgentId: MAYA, createdByUserId: CEO, updatedAt: hoursAgo(2) },
      // Someone else's requests are theirs, with or without a deliverable.
      { id: I_OTHERS_REQUEST, companyId: COMPANY, title: "Someone else's ask", status: "in_review", identifier: "ACM-2",
        assigneeAgentId: MAYA, createdByUserId: OTHER_USER },
      { id: I_OTHERS_DELIVERABLE, companyId: COMPANY, title: "Draft the FAQ", status: "in_review", identifier: "ACM-3",
        assigneeAgentId: MAYA, createdByUserId: OTHER_USER },
      // Agent-filed work: the steward reviews it; admins only when nobody answers for the agent.
      { id: I_AGENT_FILED_STEWARDED, companyId: COMPANY, title: "Theo's weekly report", status: "in_review", identifier: "ACM-4",
        assigneeAgentId: THEO, createdByAgentId: THEO },
      { id: I_AGENT_FILED_UNOWNED, companyId: COMPANY, title: "Maya's cleanup", status: "in_review", identifier: "ACM-5",
        assigneeAgentId: MAYA, createdByAgentId: MAYA },
      // A deliverable in a restricted project: only admins and the access list see it.
      { id: I_RESTRICTED, companyId: COMPANY, projectId: RESTRICTED, title: "Board pack", status: "in_review", identifier: "ACM-6",
        assigneeAgentId: MAYA, createdByUserId: CEO },
      // The member asked an owner-only agent they cannot see: no row, no name.
      { id: I_SECRET, companyId: COMPANY, title: "Compensation memo", status: "in_review", identifier: "ACM-7",
        assigneeAgentId: CIPHER, createdByUserId: MEMBER },
      // Waiting on a named human: their assigned list, not counted twice.
      { id: I_ASSIGNED_TO_OTHER_HUMAN, companyId: COMPANY, title: "Legal review", status: "in_review", identifier: "ACM-8",
        assigneeUserId: OTHER_USER, createdByUserId: OTHER_USER },
      { id: I_DONE, companyId: COMPANY, title: "Already accepted", status: "done", identifier: "ACM-9", assigneeAgentId: MAYA, createdByUserId: CEO },
      { id: I_HIDDEN, companyId: COMPANY, title: "Hidden", status: "in_review", identifier: "ACM-10", assigneeAgentId: MAYA, createdByUserId: CEO, hiddenAt: new Date() },
      { id: I_OTHER_COMPANY, companyId: OTHER_COMPANY, title: "Elsewhere", status: "in_review", identifier: "ELS-1", createdByUserId: CEO },
    ]);
    const product = (issueId: string, companyId = COMPANY, projectId: string | null = null) => ({
      companyId, issueId, projectId, type: "document", provider: "paperclip", title: "Deliverable", status: "ready_for_review", reviewState: "needs_board_review",
    });
    await db.insert(issueWorkProducts).values([
      product(I_CREATED),
      product(I_OTHERS_DELIVERABLE),
      product(I_AGENT_FILED_STEWARDED),
      product(I_AGENT_FILED_UNOWNED),
      product(I_RESTRICTED, COMPANY, RESTRICTED),
      product(I_SECRET),
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

  const ids = (body: Awaited<ReturnType<typeof pending>>) => body.reviewsWaiting.map((r) => r.issueId).sort();

  it("an issue the CEO created that an agent moved to in_review is waiting on the CEO, as a review", async () => {
    const body = await pending(actorFor(CEO, "owner"));
    const brief = body.reviewsWaiting.find((r) => r.issueId === I_CREATED);
    expect(brief).toMatchObject({ summary: "Review: Write the launch brief", submittedBy: "Maya", readyForReviewCount: 1, requestedByYou: true });
  });

  it("an admin sees their own requests and agent-filed work nobody answers for, not other people's requests", async () => {
    const body = await pending(actorFor(CEO, "owner"));
    // ACM-3 is OTHER_USER's request; ACM-4's agent has a steward.
    expect(ids(body)).toEqual([I_CREATED, I_AGENT_FILED_UNOWNED, I_RESTRICTED].sort());
    expect(body.reviewsWaitingTotal).toBe(3);
  });

  it("a steward sees agent-filed work from the agent they steward, and nothing from an owner-only agent they cannot see", async () => {
    const body = await pending(actorFor(MEMBER, "member"));
    // ACM-7 is the member's own request, but its agent is owner-only and the
    // member does not answer for it: the composed rule hides the row.
    expect(ids(body)).toEqual([I_AGENT_FILED_STEWARDED]);
    expect(body.reviewsWaitingTotal).toBe(1);
    expect(body.reviewsWaiting[0]).toMatchObject({ submittedBy: "Theo", requestedByYou: false });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(I_SECRET);
    expect(raw).not.toContain("Cipher");
    expect(raw).not.toContain("Compensation memo");
  });

  it("the person who asked sees their in_review issues, with or without a deliverable", async () => {
    const body = await pending(actorFor(OTHER_USER, "member"));
    // ACM-8 is already assigned to them (assigned list); ACM-5 has no steward
    // but they are not an admin; ACM-6 is restricted.
    expect(ids(body)).toEqual([I_OTHERS_REQUEST, I_OTHERS_DELIVERABLE].sort());
    expect(body.reviewsWaiting.every((r) => r.requestedByYou)).toBe(true);
  });

  it("the service and the route agree", async () => {
    const actor = actorFor(CEO, "owner");
    const [route, direct] = await Promise.all([pending(actor), waitingOnYouService(db).list(COMPANY, actor)]);
    expect(JSON.parse(JSON.stringify(direct.reviewsWaiting))).toEqual(route.reviewsWaiting);
    expect(direct.reviewsWaitingTotal).toBe(route.reviewsWaitingTotal);
  });

  it("the service called without a request still applies agent visibility", async () => {
    const direct = await waitingOnYouService(db).list(COMPANY, actorFor(MEMBER, "member"));
    expect(direct.reviewsWaiting.map((r) => r.issueId)).toEqual([I_AGENT_FILED_STEWARDED]);
  });
});
