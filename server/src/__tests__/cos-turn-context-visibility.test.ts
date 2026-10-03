import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  assistantConversations,
  assistantMessages,
  companies,
  companyMemberships,
  createDb,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cosIssueActionForDb } from "../services/cos-issue-action.js";
import { cosTurnContextMessage, steadyStatePrompt } from "../services/cos-replier.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * The CoS reply lands in the company-wide shared inbox — every member can
 * read it. The turn context behind that reply must therefore describe only
 * what the least-privileged reader may see: company-visible projects and
 * agents, with no per-user grants. An admin asking "what's open?" must not
 * leak a restricted project's issue titles or a hidden agent's name to an
 * off-list member reading the reply.
 *
 * Falsification: scoping the context to the sender (as before) makes every
 * restricted-titled assertion below fail — the admin sees everything.
 */
describeEmbeddedPostgres("cos turn context visibility (shared inbox)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OPEN_PROJECT = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const OPEN_ISSUE = randomUUID();
  const SECRET_ISSUE = randomUUID();
  const HIDDEN_ISSUE = randomUUID();
  const VISIBLE_AGENT = randomUUID();
  const HIDDEN_AGENT = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cos-context-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Shared Inbox Co" });
    for (const [principalId, role] of [
      ["admin-user", "admin"],
      ["plain-member", "member"],
    ] as const) {
      await db.insert(companyMemberships).values({
        companyId: COMPANY,
        principalType: "user",
        principalId,
        status: "active",
        membershipRole: role,
      });
    }
    await db.insert(agents).values([
      { id: VISIBLE_AGENT, companyId: COMPANY, name: "Ellie", role: "general", status: "active" },
      { id: HIDDEN_AGENT, companyId: COMPANY, name: "Ghost", role: "general", status: "active", visibility: "owner" },
    ]);
    await db.insert(projects).values([
      { id: OPEN_PROJECT, companyId: COMPANY, name: "Open project", createdByUserId: "admin-user" },
      {
        id: SECRET_PROJECT,
        companyId: COMPANY,
        name: "Secret project",
        createdByUserId: "admin-user",
        visibility: "restricted",
      },
    ]);
    await db.insert(issues).values([
      {
        id: OPEN_ISSUE,
        companyId: COMPANY,
        projectId: OPEN_PROJECT,
        identifier: "SIN-1",
        title: "Open roadmap task",
        status: "in_progress",
        assigneeAgentId: VISIBLE_AGENT,
      },
      {
        id: SECRET_ISSUE,
        companyId: COMPANY,
        projectId: SECRET_PROJECT,
        identifier: "SIN-2",
        title: "Secret acquisition plan",
        status: "todo",
      },
      {
        id: HIDDEN_ISSUE,
        companyId: COMPANY,
        projectId: OPEN_PROJECT,
        identifier: "SIN-3",
        title: "Task for the hidden agent",
        status: "todo",
        assigneeAgentId: HIDDEN_AGENT,
      },
    ]);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The sender is an admin: their own visibility resolves to "everything",
  // which is exactly the leak the shared inbox must not inherit.
  const adminRequester = { userId: "admin-user", source: "session", isInstanceAdmin: false, visibleAgentIds: null };

  it("describes only company-visible issues to an admin sender", async () => {
    const context = await cosIssueActionForDb(db).turnContext(COMPANY, adminRequester);
    const titles = context.openIssues.map((issue) => issue.title);
    expect(titles).toContain("Open roadmap task");
    expect(titles).not.toContain("Secret acquisition plan");
    // The open-project issue assigned to an owner-visible agent is invisible
    // to a grantless member, so it is absent too — not merely name-masked.
    expect(titles).not.toContain("Task for the hidden agent");
    const open = context.openIssues.find((issue) => issue.title === "Open roadmap task");
    expect(open?.assigneeName).toBe("Ellie");
  });

  it("lists only company-visible agents in the roster for an admin sender", async () => {
    const roster = await cosIssueActionForDb(db).roster(COMPANY, adminRequester, null);
    const names = roster.map((agent) => agent.name);
    expect(names).toContain("Ellie");
    expect(names).not.toContain("Ghost");
  });

  it("builds a facts message with no restricted titles or hidden names", async () => {
    const action = cosIssueActionForDb(db);
    const [context, roster] = await Promise.all([
      action.turnContext(COMPANY, adminRequester),
      action.roster(COMPANY, adminRequester, null),
    ]);
    // The facts travel as a separate context message, never in the system
    // prompt — user-authored titles must not sit where instructions live.
    const facts = cosTurnContextMessage(context, "facts-visibilitytest");
    expect(facts?.role).toBe("user");
    expect(facts?.content).toContain("Open roadmap task");
    expect(facts?.content).not.toContain("Secret acquisition plan");
    expect(facts?.content).not.toContain("Task for the hidden agent");
    const prompt = steadyStatePrompt(roster, null);
    expect(prompt).not.toContain("Open roadmap task");
    expect(prompt).not.toContain("Secret acquisition plan");
    expect(prompt).not.toContain("Task for the hidden agent");
    expect(prompt).not.toContain("Ghost");
  });

  it("serves pending proposal titles credential-clean to the LLM context", async () => {
    // GH #992: a proposal card's title is model output quoted into the CoS
    // prompt. Rows written before persist-time redaction must not reach the
    // LLM raw.
    const canary = "provk-proposal-canary-4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a";
    const conversationId = randomUUID();
    await db.insert(assistantConversations).values({
      id: conversationId,
      companyId: COMPANY,
      userId: "admin-user",
    });
    await db.insert(assistantMessages).values({
      conversationId,
      role: "agent",
      content: "",
      cardKind: "issue_proposal_v1",
      cardPayload: {
        status: "pending",
        title: `rotate api_key=${canary} next week`,
        description: null,
        assigneeAgentId: VISIBLE_AGENT,
        assigneeName: "Ellie",
        requesterUserId: "admin-user",
        triggerMessageId: randomUUID(),
        cosAgentId: randomUUID(),
      },
    });
    const context = await cosIssueActionForDb(db).turnContext(COMPANY, adminRequester);
    const titles = context.pendingProposals.map((proposal) => proposal.title);
    expect(titles).toHaveLength(1);
    expect(titles[0]).not.toContain(canary);
    expect(titles[0]).toContain("***REDACTED***");
  });
});
