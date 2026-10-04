import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildToolSurface } from "@agentdash/mcp-server";
import {
  agents,
  agentStewardships,
  approvals,
  authUsers,
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
  const I_ROUTINE = randomUUID();
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
      { id: A_BOARD, companyId: COMPANY, type: "budget_override_required", requestedByUserId: OTHER_USER, status: "pending", payload: {}, createdAt: hoursAgo(3) },
      { id: A_THEIRS, companyId: COMPANY, type: "send_email", requestedByAgentId: THEIRS, status: "pending", payload: {}, createdAt: hoursAgo(2) },
      { id: A_MINE_APPROVED, companyId: COMPANY, type: "hire_agent", requestedByAgentId: MINE, status: "approved", payload: {}, createdAt: hoursAgo(1) },
      { id: A_OTHER_COMPANY, companyId: OTHER_COMPANY, type: "hire_agent", status: "pending", payload: {}, createdAt: hoursAgo(1) },
    ]);
    await db.insert(issues).values([
      { id: I_OPEN, companyId: COMPANY, title: "Approve the pricing copy", status: "todo", assigneeUserId: USER, identifier: "WAI-1" },
      { id: I_REVIEW, companyId: COMPANY, title: "Pick the demo date", status: "in_review", assigneeUserId: USER, identifier: "WAI-2" },
      // UX-7 (#788): machine-filed work waits on the person too — the row
      // carries its originKind so the Decisions page can group it under
      // "Other activity" instead of the main list.
      { id: I_ROUTINE, companyId: COMPANY, title: "Weekly metrics snapshot", status: "todo", assigneeUserId: USER, identifier: "WAI-6", originKind: "routine_execution" },
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
      otherTasksAssignedToYou: Array<{ issueId: string }>;
      otherTasksAssignedToYouTotal: number;
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
      otherTasksAssignedToYou?: Array<{ issueId: string }>;
      otherTasksAssignedToYouTotal?: number;
    } }).data;
  }

  it("includes the person's agents' open approvals, board-filed ones, and open issues assigned to them", async () => {
    const home = await homeWaitingOnYou();
    expect(home.decisions.map((d) => d.approvalId).sort()).toEqual([A_BOARD, A_MINE_HIRE, A_MINE_REVISION].sort());
    expect(home.total).toBe(3);
    // The server splits before the item cap: manual origins are the main
    // list, the routine-filed issue is other activity.
    expect(home.tasksAssignedToYou.map((t) => t.issueId).sort()).toEqual([I_OPEN, I_REVIEW].sort());
    expect(home.tasksAssignedToYouTotal).toBe(2);
    expect(home.otherTasksAssignedToYou.map((t) => t.issueId)).toEqual([I_ROUTINE]);
    expect(home.otherTasksAssignedToYouTotal).toBe(1);
  });

  it("decisions say what yes and no do, and tasks carry their origin for grouping", async () => {
    const home = await homeWaitingOnYou();
    const hire = home.decisions.find((d) => d.approvalId === A_MINE_HIRE) as
      | { effects?: { approve: string; reject: string } }
      | undefined;
    // A hire approval with no payload agentId creates the agent on approve.
    // The wording is #780's effectsFor — the same sentence the assistant's
    // confirm read-back says.
    expect(hire?.effects?.approve).toContain("created");
    expect(hire?.effects?.reject).toBeTruthy();
    const budget = home.decisions.find((d) => d.approvalId === A_BOARD) as
      | { effects?: { approve: string; reject: string } }
      | undefined;
    // Non-hire kinds get the canonical generic wording — this page used to
    // carry a second copy that claimed the limit rises; that was not what
    // the decision path does.
    expect(budget?.effects?.approve).toBe("The request is approved and whatever it was gating proceeds.");
    expect(budget?.effects?.reject).toBe("The request is rejected and does not proceed.");
    const routine = home.otherTasksAssignedToYou.find((t) => t.issueId === I_ROUTINE) as
      | { originKind?: string }
      | undefined;
    expect(routine?.originKind).toBe("routine_execution");
    const manual = home.tasksAssignedToYou.find((t) => t.issueId === I_OPEN) as
      | { originKind?: string }
      | undefined;
    expect(manual?.originKind).toBe("manual");
  });

  it("the manual count is the true total, not the length of the 25-item page", async () => {
    // UX-7 review: the badge reads these totals, so the split must happen
    // before the slice — a person with 30 manual assignments gets 30, not
    // however many rows fit in the payload.
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Busy Co", issuePrefix: "BSY" });
    await db.insert(issues).values(
      Array.from({ length: 30 }, (_, i) => ({
        id: randomUUID(),
        companyId,
        title: `Manual ask ${i}`,
        status: "todo",
        assigneeUserId: USER,
        identifier: `BSY-${i + 1}`,
      })),
    );
    await db.insert(issues).values([
      { id: randomUUID(), companyId, title: "Routine one", status: "todo", assigneeUserId: USER, identifier: "BSY-31", originKind: "routine_execution" },
      { id: randomUUID(), companyId, title: "Routine two", status: "todo", assigneeUserId: USER, identifier: "BSY-32", originKind: "routine_execution" },
    ]);

    const direct = await waitingOnYouService(db).list(companyId, actor);
    expect(direct.tasksAssignedToYouTotal).toBe(30);
    expect(direct.tasksAssignedToYou).toHaveLength(25);
    expect(direct.otherTasksAssignedToYouTotal).toBe(2);
    expect(direct.otherTasksAssignedToYou).toHaveLength(2);
  });

  it("Home equals list_pending_decisions for the same person", async () => {
    const [home, mcp] = await Promise.all([homeWaitingOnYou(), mcpListPendingDecisions()]);
    expect(mcp.decisions.map((d) => d.approvalId)).toEqual(home.decisions.map((d) => d.approvalId));
    expect(mcp.total).toBe(home.total);
    expect(mcp.tasksAssignedToYou.map((t) => t.issueId)).toEqual(home.tasksAssignedToYou.map((t) => t.issueId));
    expect(mcp.tasksAssignedToYouTotal).toBe(home.tasksAssignedToYouTotal);
    expect(mcp.otherTasksAssignedToYouTotal).toBe(home.otherTasksAssignedToYouTotal);
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

  // AgentDash (c4-hire-ux): a person who confirmed a CoS plan card is named as
  // the asker — "Dana (via Chief of Staff) asks to hire Bea as Bookkeeper." —
  // not lumped under "The board" with no title. Inserted here rather than in
  // the shared fixture so the earlier total/list assertions are untouched.
  it("names the person behind a cos_plan hire, with the hire's title", async () => {
    await db.insert(authUsers).values({
      id: OTHER_USER,
      name: "Dana Whitfield",
      email: "dana@waiting.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const userHire = randomUUID();
    await db.insert(approvals).values({
      id: userHire,
      companyId: COMPANY,
      type: "hire_agent",
      requestedByUserId: OTHER_USER,
      status: "pending",
      payload: { name: "Bea", title: "Bookkeeper", role: "finance", agentId: randomUUID(), source: "cos_plan" },
      createdAt: hoursAgo(10),
    });

    const res = await request(app()).get(`/api/companies/${COMPANY}/assistant/pending-decisions`);
    expect(res.status).toBe(200);
    const decision = (res.body.decisions as Array<{ approvalId: string; summary: string; askedBy: string | null }>)
      .find((d) => d.approvalId === userHire);
    expect(decision?.summary).toBe("Dana Whitfield (via Chief of Staff) asks to hire Bea as Bookkeeper.");
    expect(decision?.askedBy).toBe("Dana Whitfield");
    // The same user's plain (non-CoS) filing names them without the qualifier.
    const board = (res.body.decisions as Array<{ approvalId: string; summary: string }>)
      .find((d) => d.approvalId === A_BOARD);
    expect(board?.summary).toBe("Dana Whitfield asks to approve spending past a budget limit.");
  });
});
