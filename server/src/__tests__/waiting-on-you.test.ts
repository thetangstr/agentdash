import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildToolSurface } from "@agentdash/mcp-server";
import {
  agents,
  agentStewardships,
  approvals,
  companies,
  companyMemberships,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { assistantRoutes } from "../routes/assistant.js";
import { errorHandler } from "../middleware/index.js";
import { assistantDigestService } from "../services/assistant-digest.js";
import { waitingOnYouService } from "../services/waiting-on-you.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: UX-3 (#784) — ONE definition of "waiting on you".
 *
 * The web Home reads GET /assistant/pending-decisions; the assistant's
 * list_pending_decisions tool calls that same route; whats_new's
 * decisionsWaiting ranks with the same shared rule. On one set of fixtures
 * all three must name the same approvals and the same issues.
 */
describeEmbeddedPostgres("waiting on you: Home, list_pending_decisions and whats_new agree", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OTHER_COMPANY = randomUUID();
  const USER = `user-${randomUUID()}`;
  const OTHER_USER = `user-${randomUUID()}`;
  const MINE = randomUUID();
  const THEIRS = randomUUID();
  const A_MINE_HIRE = randomUUID();
  const A_MINE_REVISION = randomUUID();
  const A_BOARD = randomUUID();
  const A_THEIRS = randomUUID();
  const A_MINE_APPROVED = randomUUID();
  const A_OTHER_COMPANY = randomUUID();
  const I_OPEN = randomUUID();
  const I_REVIEW = randomUUID();
  const I_DONE = randomUUID();
  const I_HIDDEN = randomUUID();
  const I_THEIRS = randomUUID();
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-waiting-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values([
      { id: COMPANY, name: "Waiting Co", issuePrefix: "WAI" },
      { id: OTHER_COMPANY, name: "Elsewhere", issuePrefix: "ELS" },
    ]);
    for (const userId of [USER, OTHER_USER]) {
      await db.insert(companyMemberships).values({
        companyId: COMPANY,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "owner",
      });
    }
    await db.insert(agents).values([
      { id: MINE, companyId: COMPANY, name: "Maya", role: "engineer" },
      { id: THEIRS, companyId: COMPANY, name: "Theo", role: "engineer" },
    ]);
    await db.insert(agentStewardships).values([
      { companyId: COMPANY, agentId: MINE, userId: USER },
      { companyId: COMPANY, agentId: THEIRS, userId: OTHER_USER },
    ]);
    await db.insert(approvals).values([
      { id: A_MINE_HIRE, companyId: COMPANY, type: "hire_agent", requestedByAgentId: MINE, status: "pending", payload: { name: "Nova" }, createdAt: hoursAgo(5) },
      { id: A_MINE_REVISION, companyId: COMPANY, type: "send_email", requestedByAgentId: MINE, status: "revision_requested", payload: {}, createdAt: hoursAgo(4) },
      { id: A_BOARD, companyId: COMPANY, type: "budget_override", requestedByUserId: OTHER_USER, status: "pending", payload: {}, createdAt: hoursAgo(3) },
      { id: A_THEIRS, companyId: COMPANY, type: "send_email", requestedByAgentId: THEIRS, status: "pending", payload: {}, createdAt: hoursAgo(2) },
      { id: A_MINE_APPROVED, companyId: COMPANY, type: "hire_agent", requestedByAgentId: MINE, status: "approved", payload: {}, createdAt: hoursAgo(1) },
      { id: A_OTHER_COMPANY, companyId: OTHER_COMPANY, type: "hire_agent", status: "pending", payload: {}, createdAt: hoursAgo(1) },
    ]);
    await db.insert(issues).values([
      { id: I_OPEN, companyId: COMPANY, title: "Approve the pricing copy", status: "todo", assigneeUserId: USER, identifier: "WAI-1" },
      { id: I_REVIEW, companyId: COMPANY, title: "Pick the demo date", status: "in_review", assigneeUserId: USER, identifier: "WAI-2" },
      { id: I_DONE, companyId: COMPANY, title: "Already done", status: "done", assigneeUserId: USER, identifier: "WAI-3" },
      { id: I_HIDDEN, companyId: COMPANY, title: "Hidden", status: "todo", assigneeUserId: USER, identifier: "WAI-4", hiddenAt: new Date() },
      { id: I_THEIRS, companyId: COMPANY, title: "Someone else's", status: "todo", assigneeUserId: OTHER_USER, identifier: "WAI-5" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const actor = {
    type: "board",
    source: "session",
    userId: USER,
    companyIds: [COMPANY],
    memberships: [{ companyId: COMPANY, membershipRole: "owner", status: "active" }],
  };

  function app() {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    a.use("/api", assistantRoutes(db));
    a.get("/api/companies/:id", (req, res) => {
      res.json({ id: req.params.id, name: "Waiting Co", issuePrefix: "WAI" });
    });
    a.get("/api/health", (_req, res) => res.json({ publicBaseUrl: "http://agentdash.test" }));
    a.use(errorHandler);
    return a;
  }

  /** What the web Home renders: the same route the assistant calls. */
  async function homeWaitingOnYou() {
    const res = await request(app()).get(`/api/companies/${COMPANY}/assistant/pending-decisions`);
    expect(res.status).toBe(200);
    return res.body as {
      decisions: Array<{ approvalId: string }>;
      total: number;
      tasksAssignedToYou: Array<{ issueId: string }>;
      tasksAssignedToYouTotal: number;
    };
  }

  /** The assistant MCP tool, run for real, its HTTP calls answered by the real route. */
  async function mcpListPendingDecisions() {
    const server = app();
    const client = {
      appBaseUrl: "http://agentdash.test",
      hasApiKey: true,
      requestJson: async (method: string, path: string) => {
        const res = await request(server)[method.toLowerCase() as "get"](`/api${path}`);
        if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status}`);
        return res.body;
      },
    };
    const tools = buildToolSurface(client as never, { apiKey: "", apiUrl: "http://agentdash.test/api", companyId: COMPANY } as never, "assistant");
    const tool = tools.find((t) => t.name === "list_pending_decisions");
    expect(tool).toBeTruthy();
    const result = await tool!.execute({});
    return (result.structuredContent as { data: {
      decisions: Array<{ approvalId: string }>;
      total: number;
      tasksAssignedToYou: Array<{ issueId: string }>;
      tasksAssignedToYouTotal: number;
    } }).data;
  }

  it("includes the person's agents' open approvals, board-filed ones, and open issues assigned to them", async () => {
    const home = await homeWaitingOnYou();
    expect(home.decisions.map((d) => d.approvalId).sort()).toEqual([A_BOARD, A_MINE_HIRE, A_MINE_REVISION].sort());
    expect(home.total).toBe(3);
    expect(home.tasksAssignedToYou.map((t) => t.issueId).sort()).toEqual([I_OPEN, I_REVIEW].sort());
    expect(home.tasksAssignedToYouTotal).toBe(2);
  });

  it("Home equals list_pending_decisions for the same person", async () => {
    const [home, mcp] = await Promise.all([homeWaitingOnYou(), mcpListPendingDecisions()]);
    expect(mcp.decisions.map((d) => d.approvalId)).toEqual(home.decisions.map((d) => d.approvalId));
    expect(mcp.total).toBe(home.total);
    expect(mcp.tasksAssignedToYou.map((t) => t.issueId)).toEqual(home.tasksAssignedToYou.map((t) => t.issueId));
    expect(mcp.tasksAssignedToYouTotal).toBe(home.tasksAssignedToYouTotal);
  });

  it("whats_new's decisions waiting are the same approvals in the same order", async () => {
    const home = await homeWaitingOnYou();
    const digest = await assistantDigestService(db).digest({
      companyId: COMPANY,
      userId: USER,
      since: hoursAgo(48),
    });
    expect(digest.decisionsWaiting.total).toBe(home.total);
    expect((digest.decisionsWaiting.items as Array<{ approvalId: string }>).map((d) => d.approvalId)).toEqual(
      home.decisions.map((d) => d.approvalId),
    );
  });

  it("the service is the route: no second definition", async () => {
    const [home, direct] = await Promise.all([
      homeWaitingOnYou(),
      waitingOnYouService(db).list(COMPANY, actor),
    ]);
    expect(JSON.parse(JSON.stringify(direct))).toEqual(home);
  });
});
