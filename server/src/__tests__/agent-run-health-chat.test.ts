import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// These fixtures inject req.actor without running the auth middleware, so no
// verified credential exists (same arrangement as agent-visibility-routes).
vi.mock("../services/issue-current-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-current-authority.js")>()),
  issueCurrentAuthority: () => undefined,
}));

import {
  agents,
  assistantConversations,
  assistantMessages,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * The PR-1002 review blocker: GET /agents/:id 500'd on a Chief of Staff agent
 * because the month filter embedded a JS Date into a raw sql template.
 * This suite walks the real router against a real database and asserts the
 * chat-turn counts the page reads.
 */
describeEmbeddedPostgres("agent run health — Chief of Staff chat turns", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const ADMIN = "admin-user";
  const COS = randomUUID();
  const TEAMMATE = randomUUID();
  const CONVERSATION = randomUUID();
  // The shared company inbox: one conversation for everyone, no owning agent —
  // assistantAgentId stays null, so only a per-message author can attribute
  // its replies (the canary bug: the tally joined on the conversation's agent
  // column and counted 0 for a CoS answering all day).
  const INBOX = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-run-health-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Chat Co", issuePrefix: "CHT" });
    await db.insert(agents).values([
      {
        id: COS,
        companyId: COMPANY,
        name: "Chief of Staff",
        role: "chief_of_staff",
        createdByUserId: ADMIN,
      },
      {
        id: TEAMMATE,
        companyId: COMPANY,
        name: "Scout",
        role: "general",
        createdByUserId: ADMIN,
      },
    ]);
    await db.insert(assistantConversations).values([
      { id: CONVERSATION, companyId: COMPANY, userId: ADMIN, assistantAgentId: COS },
      { id: INBOX, companyId: COMPANY, userId: ADMIN },
    ]);
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setUTCMonth(twoMonthsAgo.getUTCMonth() - 2);
    await db.insert(assistantMessages).values([
      { conversationId: CONVERSATION, role: "user", content: "how are we doing?", authorUserId: ADMIN },
      // Legacy rows: no author_agent_id yet, attributed through the
      // conversation's assistantAgentId.
      { conversationId: CONVERSATION, role: "agent", content: "All green." },
      { conversationId: CONVERSATION, role: "agent", content: "One caveat." },
      // An agent reply from before this month: counts toward the total but
      // not chatTurnsThisMonth — and is what makes the date filter load-bearing.
      { conversationId: CONVERSATION, role: "agent", content: "An older answer.", createdAt: twoMonthsAgo },
      // Shared-inbox rows: attributed by the message's author_agent_id. The
      // teammate's reply in the same conversation must not count for the CoS.
      { conversationId: INBOX, role: "user", content: "status?", authorUserId: ADMIN },
      { conversationId: INBOX, role: "agent", content: "On it.", authorAgentId: COS },
      { conversationId: INBOX, role: "agent", content: "Scout reporting.", authorAgentId: TEAMMATE },
    ]);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reports chatTurns and chatTurnsThisMonth on the agent detail read", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: ADMIN,
        companyIds: [COMPANY],
        memberships: [{ companyId: COMPANY, membershipRole: "admin", status: "active" }],
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const res = await request(app).get(`/api/agents/${COS}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.runHealth).toMatchObject({
      total: 0,
      neverRan: true,
      // 3 legacy replies (conversation link) + 1 shared-inbox reply
      // (author_agent_id). The teammate's inbox reply counts for Scout, not
      // the CoS.
      chatTurns: 4,
      chatTurnsThisMonth: 3,
    });
  });

  it("attributes shared-inbox replies to their own author", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: ADMIN,
        companyIds: [COMPANY],
        memberships: [{ companyId: COMPANY, membershipRole: "admin", status: "active" }],
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const res = await request(app).get(`/api/agents/${TEAMMATE}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.runHealth).toMatchObject({
      chatTurns: 1,
      chatTurnsThisMonth: 1,
    });
  });
});
