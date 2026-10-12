import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentCorrections,
  agents,
  approvals,
  authUsers,
  bridgeEndpoints,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  issueApprovals,
  issueComments,
  issues,
  issueThreadInteractions,
  projectAccess,
  projects,
  stewardInboxActionHandles,
} from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { bridgeRoutes } from "../routes/bridge.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { documentService } from "../services/documents.js";
import { featureFlagsService } from "../services/feature-flags.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { truncateWithRetry } from "./helpers/truncate.js";

/**
 * AgentDash-MK: the send-back. The person's own Claude sends back what the
 * person approved, as them, in one bundle.
 *
 * Properties defended, each against a real Postgres:
 *
 * - propose writes nothing and returns the full read-back and who will see it;
 * - confirm applies answer, document revision, comment and lessons in one
 *   transaction as the person, every activity row carrying
 *   `channel: "bridge_work"` and the same `replyId`, and wakes the agent once;
 * - a stale document refuses the whole bundle; a spent handle refuses;
 * - files are refused until file send-back exists;
 * - the gates of the reads hold here too (bridge:work, the company flag,
 *   404 for an issue off the person's page);
 * - the send-back leaves a "what changed" correction for the agent's next wake;
 * - a decision in the bundle goes through the decision path after the rest.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

describeEmbeddedPostgres("bridge work: the send-back bundle", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bridge-reply-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function person(companyId: string, role: string, name: string) {
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name, email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
    return userId;
  }

  async function stewardedAgent(companyId: string, name: string, stewardUserId: string, ownerUserId: string) {
    const agent = await db
      .insert(agents)
      .values({ companyId, name, role: "general", status: "idle", adapterType: "process" })
      .returning()
      .then((rows) => rows[0]!);
    await agentStewardshipService(db).assign(companyId, { agentId: agent.id, userId: stewardUserId, assignedByUserId: ownerUserId });
    return agent;
  }

  async function seed(opts: { flag?: boolean } = {}) {
    const prefix = `RP${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z]/g, "X")}`;
    const company = await db
      .insert(companies)
      .values({ name: `Reply ${randomUUID()}`, issuePrefix: prefix, productProfile: "agentdash_mk" })
      .returning()
      .then((rows) => rows[0]!);
    const owner = await person(company.id, "owner", "Owner O");
    const personA = await person(company.id, "operator", "Person A");
    const personB = await person(company.id, "operator", "Person B");
    const agentA = await stewardedAgent(company.id, "Agent A", personA, owner);
    const agentB = await stewardedAgent(company.id, "Agent B", personB, owner);
    if (opts.flag !== false) await featureFlagsService(db).set(company.id, FEATURE_FLAG_KEYS.COWORKER_BRIDGE, true);
    return { company, prefix, owner, personA, personB, agentA, agentB };
  }

  async function endpointFor(
    companyId: string,
    userId: string,
    capabilities = ["bridge:read", "bridge:inbox", "bridge:work"],
    label = "person-a-laptop",
  ) {
    return db
      .insert(bridgeEndpoints)
      .values({
        companyId,
        userId,
        label,
        tokenHash: `hash-${randomUUID()}`,
        capabilities,
        enrolledAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  let issueCounter = 0;
  async function makeIssue(companyId: string, prefix: string, values: Partial<typeof issues.$inferInsert>) {
    issueCounter += 1;
    return db
      .insert(issues)
      .values({ companyId, title: "Draft the quarterly note", status: "blocked", identifier: `${prefix}-${issueCounter}`, ...values })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** A first draft written by the agent, as the agent writes documents. */
  async function agentDraft(issueId: string, agentId: string, body: string) {
    const result = await documentService(db).upsertIssueDocument({
      issueId,
      key: "note",
      title: "Quarterly note",
      format: "markdown",
      body,
      createdByAgentId: agentId,
    });
    return result.document;
  }

  async function askQuestion(issue: typeof issues.$inferSelect, agentId: string) {
    return issueThreadInteractionService(db).create(
      issue,
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          questions: [
            {
              id: "framing",
              prompt: "Which framing should the note use?",
              selectionMode: "single",
              options: [
                { id: "headline", label: "Headline and two drivers (recommended)" },
                { id: "table", label: "Full table" },
              ],
            },
          ],
        },
      } as never,
      { agentId },
    );
  }

  function app(endpoint: { id: string; companyId: string }, wakeup = vi.fn(async () => ({ id: randomUUID() }))) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "bridge_endpoint", companyId: endpoint.companyId, bridgeEndpointId: endpoint.id };
      next();
    });
    server.use("/api", bridgeRoutes(db, { autoDispatchQueuedRuns: false, heartbeat: { wakeup } as never }));
    server.use(errorHandler);
    return { server, wakeup };
  }

  /** A blocked hand-off with a draft and an open question, from Agent A to Person A. */
  async function handoff() {
    const seeded = await seed();
    const issue = await makeIssue(seeded.company.id, seeded.prefix, { assigneeAgentId: seeded.agentA.id });
    const draft = await agentDraft(issue.id, seeded.agentA.id, "Line one\nThe second driver is 14%.\nLine three");
    const question = await askQuestion(issue, seeded.agentA.id);
    const endpoint = await endpointFor(seeded.company.id, seeded.personA);
    return { ...seeded, issue, draft, question, endpoint };
  }

  const fullBundle = (issueId: string, interactionId: string, baseRevisionId: string | null) => ({
    issueId,
    answer: { interactionId, optionId: "q1.o2" },
    document: {
      key: "note",
      body: "Line one\nThe second driver comes from the Q3 workbook.\nLine three\nMethod: modeled, not measured.",
      baseRevisionId,
      changeSummary: "Corrected driver 2; added a method note",
    },
    comment: "Revised the note. Please proofread it and move it to review.",
    lessons: ["Lead with the recommendation.", "Label every figure as measured or modeled."],
  });

  // -------------------------------------------------------------------------

  it("refuses an endpoint without bridge:work with 403, and refuses while the company flag is off", async () => {
    const { company, prefix, personA, agentA } = await seed();
    const issue = await makeIssue(company.id, prefix, { assigneeAgentId: agentA.id });
    const inboxOnly = await endpointFor(company.id, personA, ["bridge:read", "bridge:inbox"], "person-a-desktop");
    for (const [route, body] of [
      ["propose", { issueId: issue.id, comment: "hi" }],
      ["confirm", { token: "x" }],
    ] as const) {
      const res = await request(app(inboxOnly).server).post(`/api/bridge/work/${route}`).send(body);
      expect(res.status, route).toBe(403);
      expect(res.body.error).toContain("bridge:work");
    }

    await featureFlagsService(db).set(company.id, FEATURE_FLAG_KEYS.COWORKER_BRIDGE, false);
    const endpoint = await endpointFor(company.id, personA);
    const res = await request(app(endpoint).server).post("/api/bridge/work/propose").send({ issueId: issue.id, comment: "hi" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, code: "coworker_bridge_disabled" });
  });

  it("answers 404 for an issue off the person's page or someone else's work", async () => {
    const { company, prefix, owner, personA, agentA, agentB } = await seed();
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Restricted work", visibility: "restricted", createdByUserId: owner })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(projectAccess).values({
      companyId: company.id,
      projectId: project.id,
      principalType: "agent",
      principalId: agentA.id,
      grantedByUserId: owner,
    });
    const hidden = await makeIssue(company.id, prefix, { assigneeAgentId: agentA.id, projectId: project.id });
    const othersWork = await makeIssue(company.id, prefix, { assigneeAgentId: agentB.id });
    const endpoint = await endpointFor(company.id, personA);
    for (const issue of [hidden, othersWork]) {
      const res = await request(app(endpoint).server).post("/api/bridge/work/propose").send({ issueId: issue.id, comment: "hi" });
      expect(res.status).toBe(404);
    }
  });

  it("reads the whole bundle back, says who will see it, and writes nothing", async () => {
    const { issue, draft, question, endpoint } = await handoff();
    const res = await request(app(endpoint).server)
      .post("/api/bridge/work/propose")
      .send(fullBundle(issue.identifier!, question.id, draft.latestRevisionId));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.handle).toBe("string");
    const readback = (res.body.readback as string[]).join("\n");
    expect(readback).toContain(`Send back to Agent A on ${issue.identifier}, as you, via bridge (person-a-laptop)`);
    expect(readback).toContain('answer q1 "Which framing should the note use?" -> q1.o2 "Full table"');
    expect(readback).toContain('document "note" -> new revision 2 on top of revision 1');
    expect(readback).toContain('comment "Revised the note. Please proofread it and move it to review."');
    expect(readback).toContain("  - Lead with the recommendation.");
    expect(res.body.audience).toBe(`Everyone in the company who can see ${issue.identifier} will see these.`);
    expect(res.body.wakes).toContain("Agent A is woken once");

    // Nothing written.
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, draft.id))).toHaveLength(1);
    const interaction = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, question.id));
    expect(interaction[0]!.status).toBe("pending");
  });

  it("refuses files, an empty bundle, and a document built on an old revision, minting no handle", async () => {
    const { issue, draft, question, endpoint } = await handoff();
    const { server } = app(endpoint);

    const withFiles = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, comment: "see attached", files: [{ name: "a.csv", sha256: "0".repeat(64), size: 10 }] });
    expect(withFiles.body).toMatchObject({ ok: false, code: "files_not_supported_yet" });
    expect(withFiles.body.reason).toContain("restricted access");

    const empty = await request(server).post("/api/bridge/work/propose").send({ issueId: issue.id, lessons: ["Be brief."] });
    expect(empty.body).toMatchObject({ ok: false, code: "empty_reply" });

    const noBase = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, document: { key: "note", body: "new" } });
    expect(noBase.body).toMatchObject({ ok: false, code: "base_revision_required" });

    const stale = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, document: { key: "note", body: "new", baseRevisionId: randomUUID() } });
    expect(stale.body).toMatchObject({ ok: false, code: "document_moved_on" });

    const badAnswer = await request(server)
      .post("/api/bridge/work/propose")
      .send({ issueId: issue.id, answer: { interactionId: question.id, optionId: "q1.o9" } });
    expect(badAnswer.body).toMatchObject({ ok: false, code: "invalid_answer" });

    expect(draft.latestRevisionNumber).toBe(1);
    expect(await db.select().from(stewardInboxActionHandles)).toHaveLength(0);
  });

  it("sends the bundle in one go as the person, one activity group, and wakes the agent once", async () => {
    const { issue, draft, question, endpoint, personA, agentA } = await handoff();
    const { server, wakeup } = app(endpoint);
    const proposed = await request(server)
      .post("/api/bridge/work/propose")
      .send(fullBundle(issue.id, question.id, draft.latestRevisionId));
    expect(proposed.body.ok).toBe(true);

    const confirmed = await request(server).post("/api/bridge/work/confirm").send({ token: proposed.body.handle });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      ok: true,
      identifier: issue.identifier,
      sent: { answer: { interactionId: question.id }, document: { key: "note", revisionNumber: 2 }, lessons: 2 },
      agentWoken: true,
    });

    // The comment, as the person.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorUserId: personA, authorAgentId: null, body: "Revised the note. Please proofread it and move it to review." });
    expect(confirmed.body.sent.comment.commentId).toBe(comments[0]!.id);

    // The document revision, as the person.
    const revisions = await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, draft.id));
    expect(revisions).toHaveLength(2);
    expect(revisions.find((row) => row.revisionNumber === 2)).toMatchObject({ createdByUserId: personA, createdByAgentId: null });

    // The answer, as the person.
    const [answered] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, question.id));
    expect(answered!.status).toBe("answered");
    expect((answered!.result as { answers: Array<{ optionIds: string[] }> }).answers[0]!.optionIds).toEqual(["table"]);

    // One group: every row of the bundle names the channel, the endpoint and the same reply id.
    const group = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issue.id), sql`${activityLog.details} ->> 'channel' = 'bridge_work'`));
    const actions = group.map((row) => row.action).sort();
    expect(actions).toEqual(
      expect.arrayContaining([
        "issue.bridge_reply_sent",
        "issue.comment_added",
        "issue.document_updated",
        "issue.thread_interaction_answered",
      ]),
    );
    const replyIds = new Set(group.map((row) => (row.details as { replyId?: string }).replyId));
    expect(replyIds.size).toBe(1);
    for (const row of group) {
      expect(row).toMatchObject({ actorType: "user", actorId: personA });
      expect(row.details).toMatchObject({ bridgeEndpointId: endpoint.id, bridgeEndpointLabel: "person-a-laptop" });
    }

    // Woken once, with the bundle's comment.
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      agentA.id,
      expect.objectContaining({
        contextSnapshot: expect.objectContaining({ issueId: issue.id, wakeCommentId: comments[0]!.id, source: "bridge.work.reply" }),
      }),
    );

    // What changed, waiting for the agent's next wake.
    const [correction] = await db.select().from(agentCorrections).where(eq(agentCorrections.agentId, agentA.id));
    expect(correction).toMatchObject({ kind: "steward_send_back", issueId: issue.id, sourceActorType: "user", sourceActorId: personA });
    expect(correction!.summary).toContain(`Person A reviewed your work on ${issue.identifier} in their own Claude session (person-a-laptop)`);
    expect(correction!.summary).toContain('Document "note": revision 1 (by you, 9 words) became their revision 2 (16 words): 1 line removed, 2 added, 2 unchanged.');
    expect(correction!.summary).toContain("- The second driver is 14%.");
    expect(correction!.summary).toContain('+ Method: modeled, not measured.');
    expect(correction!.summary).toContain('they chose "Full table"; you recommended "Headline and two drivers (recommended)"');
    expect(correction!.details).toMatchObject({ lessons: ["Lead with the recommendation.", "Label every figure as measured or modeled."] });
  });

  it("refuses a spent handle, and writes nothing the second time", async () => {
    const { issue, endpoint } = await handoff();
    const { server, wakeup } = app(endpoint);
    const proposed = await request(server).post("/api/bridge/work/propose").send({ issueId: issue.id, comment: "Looks right; finish it." });
    const first = await request(server).post("/api/bridge/work/confirm").send({ token: proposed.body.handle });
    expect(first.body.ok).toBe(true);
    const second = await request(server).post("/api/bridge/work/confirm").send({ token: proposed.body.handle });
    expect(second.body).toMatchObject({ ok: false, code: "handle_not_valid" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("refuses the whole bundle when the document moved on after the read-back", async () => {
    const { issue, draft, question, endpoint, agentA } = await handoff();
    const { server, wakeup } = app(endpoint);
    const proposed = await request(server)
      .post("/api/bridge/work/propose")
      .send(fullBundle(issue.id, question.id, draft.latestRevisionId));
    expect(proposed.body.ok).toBe(true);

    // The agent writes another revision in between.
    await documentService(db).upsertIssueDocument({
      issueId: issue.id,
      key: "note",
      format: "markdown",
      body: "The agent's second pass.",
      baseRevisionId: draft.latestRevisionId,
      createdByAgentId: agentA.id,
    });

    const confirmed = await request(server).post("/api/bridge/work/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: false, code: "document_moved_on" });
    expect(confirmed.body.reason).toContain("Nothing was sent");

    // Nothing from the bundle landed: no comment, the question still open, no correction, no wake.
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, question.id));
    expect(interaction!.status).toBe("pending");
    expect(await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, draft.id))).toHaveLength(2);
    expect(await db.select().from(agentCorrections)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("refuses at confirm when the issue stopped being the person's work", async () => {
    const { issue, endpoint, agentB } = await handoff();
    const { server } = app(endpoint);
    const proposed = await request(server).post("/api/bridge/work/propose").send({ issueId: issue.id, comment: "Go ahead." });
    await db.update(issues).set({ assigneeAgentId: agentB.id }).where(eq(issues.id, issue.id));
    const confirmed = await request(server).post("/api/bridge/work/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: false, code: "no_longer_yours" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
  });

  it("applies a decision in the bundle after the rest, and the rejection is the agent's correction", async () => {
    const { issue, endpoint, company, agentA, personA } = await handoff();
    const approval = await db
      .insert(approvals)
      .values({
        companyId: company.id,
        type: "request_board_approval",
        status: "pending",
        requestedByAgentId: agentA.id,
        payload: { title: "Send the note to the ops lead" },
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(issueApprovals).values({ companyId: company.id, issueId: issue.id, approvalId: approval.id });

    const { server } = app(endpoint);
    const proposed = await request(server)
      .post("/api/bridge/work/propose")
      .send({
        issueId: issue.id,
        decision: { approvalId: approval.id, decision: "reject", note: "Not until the figures are checked." },
        comment: "Rejected for now; check driver 2 first.",
      });
    expect(proposed.body.ok).toBe(true);
    expect(proposed.body.readback.join("\n")).toContain(
      'decision reject "Send the note to the ops lead" (revision 1), note: "Not until the figures are checked."',
    );

    const confirmed = await request(server).post("/api/bridge/work/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: true, sent: { decision: "rejected" } });
    const [decided] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(decided).toMatchObject({ status: "rejected", decidedByUserId: personA, decisionChannel: "bridge_work" });

    const corrections = await db.select().from(agentCorrections).where(eq(agentCorrections.agentId, agentA.id));
    expect(corrections.map((row) => row.kind).sort()).toEqual(["approval_rejected", "steward_send_back"]);
    expect(corrections.find((row) => row.kind === "approval_rejected")!.summary).toContain(
      'Their reason: "Not until the figures are checked."',
    );
  });
});
