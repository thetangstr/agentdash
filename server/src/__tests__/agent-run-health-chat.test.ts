import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
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
// The migration's idempotent backfill statements — replayed here so the
// fixtures attribute legacy replies exactly as an upgraded box does, rather
// than faking author_agent_id or the dead assistantAgentId fallback.
const BACKFILL_STATEMENTS = fs
  .readFileSync(
    fileURLToPath(
      new URL(
        "../../../packages/db/src/migrations/0145_strong_triathlon.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  )
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  // Statements may open with a `--` comment before the UPDATE — judge by the
  // first non-comment line, then execute the statement whole (Postgres eats
  // the comments).
  .filter((statement) =>
    statement
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("--"))
      .at(0)
      ?.toUpperCase()
      .startsWith("UPDATE"),
  );

describeEmbeddedPostgres("agent run health — Chief of Staff chat turns", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const ADMIN = "admin-user";
  const COS = randomUUID();
  const TEAMMATE = randomUUID();
  // A /cos bootstrap thread: production conversations never set
  // assistantAgentId (conversationService.create has no such input), and the
  // bootstrap thread's title is NULL — the shape the 0145 backfill keys on.
  const CONVERSATION = randomUUID();
  // The shared company inbox: one conversation for everyone, titled
  // 'Company Inbox'.
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
      { id: CONVERSATION, companyId: COMPANY, userId: ADMIN },
      { id: INBOX, companyId: COMPANY, userId: ADMIN, title: "Company Inbox" },
    ]);
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setUTCMonth(twoMonthsAgo.getUTCMonth() - 2);
    await db.insert(assistantMessages).values([
      { conversationId: CONVERSATION, role: "user", content: "how are we doing?", authorUserId: ADMIN },
      // Legacy rows written before author_agent_id existed: the backfill
      // attributes them to the company's first chief_of_staff.
      { conversationId: CONVERSATION, role: "agent", content: "All green." },
      { conversationId: CONVERSATION, role: "agent", content: "One caveat." },
      // An agent reply from before this month: counts toward the total but
      // not chatTurnsThisMonth — and is what makes the date filter load-bearing.
      { conversationId: CONVERSATION, role: "agent", content: "An older answer.", createdAt: twoMonthsAgo },
      // Shared-inbox rows: post-column rows carry their author. The
      // teammate's reply in the same conversation must not count for the CoS.
      { conversationId: INBOX, role: "user", content: "status?", authorUserId: ADMIN },
      { conversationId: INBOX, role: "agent", content: "On it.", authorAgentId: COS },
      { conversationId: INBOX, role: "agent", content: "Scout reporting.", authorAgentId: TEAMMATE },
      // A legacy inbox reply with no author: the backfill over-attributes it
      // to the CoS — the documented trade-off for pre-column inbox rows.
      { conversationId: INBOX, role: "agent", content: "Legacy inbox reply." },
      // Not answers: a dispatch-failure card and a billing system notice must
      // not count even when they name the CoS.
      { conversationId: INBOX, role: "agent", content: "CoS couldn't reply", authorAgentId: COS, cardKind: "cos_dispatch_error_v1" },
      { conversationId: INBOX, role: "agent", content: "Your Pro trial ends in 3 days.", authorAgentId: COS, cardPayload: { systemNotice: "billing" } },
    ]);
    for (const statement of BACKFILL_STATEMENTS) {
      await db.execute(sql.raw(statement));
    }
    // Idempotent: a second pass changes nothing.
    for (const statement of BACKFILL_STATEMENTS) {
      await db.execute(sql.raw(statement));
    }
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
      // 3 backfilled legacy replies + 1 shared-inbox reply + 1 backfilled
      // legacy inbox reply = 5. The dispatch-error card and the billing
      // notice name the CoS but are not answers; the teammate's inbox reply
      // counts for Scout, not the CoS.
      chatTurns: 5,
      chatTurnsThisMonth: 4,
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
