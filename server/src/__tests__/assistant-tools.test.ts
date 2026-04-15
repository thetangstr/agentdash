import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertToolAccess,
  executeTool,
  getAssistantTools,
  getToolDefinitions,
  type Tool,
  type ToolContext,
} from "../services/assistant-tools.js";

// ── Mocks ──────────────────────────────────────────────────────────────

const mockAgentSvc = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}));

const mockIssueSvc = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}));

const mockGoalSvc = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentSvc,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueSvc,
}));

vi.mock("../services/goals.js", () => ({
  goalService: () => mockGoalSvc,
}));

// ── Fixtures ───────────────────────────────────────────────────────────

const mockDb = {} as any;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "user-1",
    companyId: "company-1",
    companyIds: ["company-1"],
    isInstanceAdmin: false,
    source: "jwt",
    ...overrides,
  };
}

// ── Tests: getToolDefinitions ──────────────────────────────────────────

describe("getToolDefinitions", () => {
  it("returns exactly 6 tools", () => {
    const defs = getToolDefinitions(mockDb);
    expect(defs).toHaveLength(6);
  });

  it("has the correct tool names", () => {
    const defs = getToolDefinitions(mockDb);
    const names = defs.map((d) => d.name);
    expect(names).toEqual([
      "create_agent",
      "list_agents",
      "create_issue",
      "list_issues",
      "set_goal",
      "get_dashboard_summary",
    ]);
  });

  it("each tool has a non-empty description and input_schema", () => {
    const defs = getToolDefinitions(mockDb);
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.input_schema).toBeDefined();
    }
  });
});

// ── Tests: executeTool ─────────────────────────────────────────────────

describe("executeTool", () => {
  let tools: Tool[];
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    tools = getAssistantTools(mockDb);
    ctx = makeCtx();
  });

  it("throws on unknown tool name", async () => {
    await expect(executeTool(tools, "nonexistent_tool", {}, ctx, mockDb)).rejects.toThrow(
      "Unknown tool: nonexistent_tool",
    );
  });

  it("delegates create_agent to agentService.create", async () => {
    const mockAgent = { id: "agent-1", name: "Test Agent" };
    mockAgentSvc.create.mockResolvedValue(mockAgent);

    const result = await executeTool(
      tools,
      "create_agent",
      { name: "Test Agent", adapterType: "claude" },
      ctx,
      mockDb,
    );

    expect(mockAgentSvc.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      name: "Test Agent",
      adapterType: "claude",
    }));
    expect(result).toEqual(mockAgent);
  });

  it("delegates list_agents to agentService.list", async () => {
    const mockAgents = [{ id: "agent-1", status: "idle", role: "engineer" }];
    mockAgentSvc.list.mockResolvedValue(mockAgents);

    const result = await executeTool(tools, "list_agents", {}, ctx, mockDb);

    expect(mockAgentSvc.list).toHaveBeenCalledWith("company-1", expect.any(Object));
    expect(result).toEqual(mockAgents);
  });

  it("filters list_agents by status when provided", async () => {
    const mockAgents = [
      { id: "agent-1", status: "idle", role: "engineer" },
      { id: "agent-2", status: "paused", role: "manager" },
    ];
    mockAgentSvc.list.mockResolvedValue(mockAgents);

    const result = await executeTool(tools, "list_agents", { status: "idle" }, ctx, mockDb) as any[];

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("agent-1");
  });

  it("delegates create_issue to issueService.create", async () => {
    const mockIssue = { id: "issue-1", title: "Fix bug" };
    mockIssueSvc.create.mockResolvedValue(mockIssue);

    const result = await executeTool(
      tools,
      "create_issue",
      { title: "Fix bug", priority: "high" },
      ctx,
      mockDb,
    );

    expect(mockIssueSvc.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      title: "Fix bug",
      priority: "high",
    }));
    expect(result).toEqual(mockIssue);
  });

  it("delegates list_issues to issueService.list", async () => {
    const mockIssues = [{ id: "issue-1", status: "todo" }];
    mockIssueSvc.list.mockResolvedValue(mockIssues);

    const result = await executeTool(tools, "list_issues", {}, ctx, mockDb);

    expect(mockIssueSvc.list).toHaveBeenCalledWith("company-1", expect.any(Object));
    expect(result).toEqual(mockIssues);
  });

  it("delegates set_goal to goalService.create", async () => {
    const mockGoal = { id: "goal-1", title: "Q1 Revenue" };
    mockGoalSvc.create.mockResolvedValue(mockGoal);

    const result = await executeTool(
      tools,
      "set_goal",
      { title: "Q1 Revenue", level: "company" },
      ctx,
      mockDb,
    );

    expect(mockGoalSvc.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      title: "Q1 Revenue",
      level: "company",
    }));
    expect(result).toEqual(mockGoal);
  });

  it("get_dashboard_summary returns agent + issue counts", async () => {
    mockAgentSvc.list.mockResolvedValue([
      { id: "a1", status: "idle" },
      { id: "a2", status: "paused" },
    ]);
    mockIssueSvc.list.mockResolvedValue([
      { id: "i1", status: "todo" },
      { id: "i2", status: "done" },
      { id: "i3", status: "in_progress" },
    ]);

    const result = await executeTool(tools, "get_dashboard_summary", {}, ctx, mockDb) as any;

    expect(result.agents.total).toBe(2);
    expect(result.issues.total).toBe(3);
    expect(result.issues.open).toBe(2); // todo + in_progress
  });
});

// ── Tests: assertToolAccess ────────────────────────────────────────────

describe("assertToolAccess", () => {
  it("allows instance admin for any company", () => {
    const ctx = makeCtx({ isInstanceAdmin: true, companyIds: [], companyId: "company-x" });
    expect(() => assertToolAccess(ctx, "any-company")).not.toThrow();
  });

  it("allows local_implicit source for any company", () => {
    const ctx = makeCtx({ source: "local_implicit", companyIds: [], companyId: "company-x" });
    expect(() => assertToolAccess(ctx, "other-company")).not.toThrow();
  });

  it("allows jwt source when targetCompanyId is in companyIds", () => {
    const ctx = makeCtx({ source: "jwt", companyIds: ["company-1", "company-2"] });
    expect(() => assertToolAccess(ctx, "company-1")).not.toThrow();
    expect(() => assertToolAccess(ctx, "company-2")).not.toThrow();
  });

  it("rejects jwt source when targetCompanyId is not in companyIds", () => {
    const ctx = makeCtx({ source: "jwt", companyIds: ["company-1"] });
    expect(() => assertToolAccess(ctx, "company-99")).toThrow("Access denied");
  });

  it("rejects cross-company access with statusCode 403", () => {
    const ctx = makeCtx({ source: "jwt", companyIds: ["company-1"] });
    let thrown: any;
    try {
      assertToolAccess(ctx, "company-other");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.statusCode).toBe(403);
  });
});
