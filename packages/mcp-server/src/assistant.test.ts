import { describe, expect, it } from "vitest";
import type { PaperclipApiClient } from "./client.js";
import { AssistantContext } from "./assistant/context.js";
import { assistantTools } from "./assistant/tools.js";
import { findForbiddenPaths, redactAssistantValue } from "./assistant/redact.js";
import { buildToolSurface, createAgentDashServer, parseToolset } from "./index.js";
import { PaperclipApiClient as RealClient } from "./client.js";
import type { PaperclipMcpConfig } from "./config.js";

/**
 * AgentDash assistant MCP (M1, GH #676): pins the person-facing read surface —
 * tool names and descriptions (snapshot), the §5 envelope, server-side name
 * resolution, read-only annotations, and the redaction contract over wire
 * bytes.
 */

const CONFIG: PaperclipMcpConfig = {
  apiUrl: "https://dash.example.test/api",
  apiKey: "pcp_test_key",
  companyId: "company-1",
  agentId: null,
  runId: null,
};

const COMPANY = { id: "company-1", name: "Acme", issuePrefix: "ACME" };

const PRIYA = { id: "agent-1", name: "Priya", role: "engineer", title: "Engineer", status: "running" };
const THEO = { id: "agent-2", name: "Theo", role: "engineer", title: "Engineer", status: "idle" };

const ISSUES = [
  {
    id: "issue-1",
    companyId: "company-1",
    identifier: "ACME-311",
    title: "Checkout retries loop forever",
    status: "blocked",
    priority: "high",
    assigneeAgentId: "agent-1",
    projectId: "project-1",
    description: "Card declines are retried forever",
    updatedAt: "2026-09-23T02:14:00Z",
    completedAt: null,
  },
  {
    id: "issue-2",
    companyId: "company-1",
    identifier: "ACME-312",
    title: "Checkout receipt copy",
    status: "done",
    priority: "low",
    assigneeAgentId: "agent-2",
    projectId: "project-1",
    description: "Fix the receipt wording",
    updatedAt: "2026-09-22T18:00:00Z",
    completedAt: "2026-09-22T18:00:00Z",
  },
  {
    id: "issue-3",
    companyId: "company-1",
    identifier: "ACME-313",
    title: "Pick the launch date",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: "user-1",
    projectId: "project-1",
    description: "Decide when dark mode ships",
    updatedAt: "2026-09-23T09:00:00Z",
    completedAt: null,
  },
];

const PEOPLE = {
  people: [
    { userId: "user-1", name: "Kai", email: "kai@acme.test", status: "active", membershipRole: "owner" },
    { userId: "user-2", name: "Sam", email: "sam@acme.test", status: "active", membershipRole: "member" },
  ],
};

const PROJECTS = [
  { id: "project-1", companyId: "company-1", name: "Dark mode", status: "active", leadAgentId: "agent-1", description: "Add dark mode" },
];

type Handler = (path: string) => unknown;

function fakeClient(handler: Handler): PaperclipApiClient {
  return {
    requestJson: async (_method: string, path: string) => handler(path),
    appBaseUrl: "https://dash.example.test",
    defaults: { companyId: "company-1", agentId: null, runId: null },
  } as unknown as PaperclipApiClient;
}

function seededClient(overrides: Handler = () => null): PaperclipApiClient {
  return fakeClient((path) => {
    const override = overrides(path);
    if (override !== null && override !== undefined) return override;
    if (path === "/health") return { publicBaseUrl: "https://dash.example.test" };
    if (path === "/companies/company-1") return COMPANY;
    if (path === "/cli-auth/me") {
      return {
        user: { name: "Kai", email: "kai@acme.test" },
        userId: "user-1",
        isInstanceAdmin: false,
        source: "board_key",
        keyId: "key-1",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", role: "owner" }],
      };
    }
    if (path.startsWith("/companies/company-1/agents")) return [PRIYA, THEO];
    if (path === "/companies/company-1/people") return PEOPLE;
    if (path.startsWith("/companies/company-1/projects")) return PROJECTS;
    if (path.startsWith("/projects/")) return PROJECTS[0];
    if (path.startsWith("/companies/company-1/issues")) return ISSUES;
    {
      const byRef = ISSUES.find((issue) => path === `/issues/${issue.id}` || path === `/issues/${issue.identifier}`);
      if (byRef) return byRef;
    }
    if (path.startsWith("/issues/issue-1/comments")) {
      return [
        { id: "c1", body: "BLOCKED — needs a Stripe test key from you", createdAt: "2026-09-23T02:14:00Z", authorAgentId: "agent-1" },
      ];
    }
    if (path.startsWith("/issues/issue-1/runs")) {
      return [
        { runId: "run-1", status: "failed", finishedAt: "2026-09-23T02:14:00Z", resultJson: { stopReason: "missing_stripe_key" }, livenessReason: "asked steward for a Stripe test key", nextAction: "wait_for_steward" },
      ];
    }
    if (path.startsWith("/issues/issue-1/approvals")) {
      return [{ id: "appr-1", type: "connector_send", status: "pending", createdAt: "2026-09-23T01:00:00Z" }];
    }
    if (path.startsWith("/issues/issue-1/work-products")) {
      return [{ type: "pull_request", provider: "github", title: "PR #212", url: "https://github.test/pr/212", status: "merged", reviewState: "approved", summary: "merged" }];
    }
    if (path.startsWith("/companies/company-1/assistant/digest")) {
      return {
        agentsAnsweredFor: 2,
        since: "2026-09-22T14:00:00Z",
        asOf: "2026-09-23T14:00:00Z",
        shipped: { total: 1, shown: 1, items: [{ issueId: "issue-2", identifier: "ACME-312", title: "Checkout receipt copy", agentName: "Theo", workProducts: [{ type: "pull_request", provider: "github", title: "PR #212", url: "https://github.test/pr/212", status: "merged", reviewState: "approved" }] }] },
        blockedNow: { total: 1, shown: 1, items: [{ issueId: "issue-1", identifier: "ACME-311", title: "Checkout retries loop forever", agentName: "Priya" }] },
        newlyBlocked: { total: 1, shown: 1, items: [{ issueId: "issue-1", identifier: "ACME-311", title: "Checkout retries loop forever", agentName: "Priya" }] },
        decisionsWaiting: { total: 1, shown: 1, items: [{ approvalId: "appr-1", type: "connector_send", agentName: "Priya", waitingSince: "2026-09-23T01:00:00Z" }] },
        truncated: false,
      };
    }
    if (path.startsWith("/companies/company-1/assistant/pending-decisions")) {
      return {
        decisions: [
          { approvalId: "appr-1", kind: "connector_send", askedBy: "Priya", summary: "Priya asks to send a message through a connector.", relatedItem: { identifier: "ACME-311", title: "Checkout retries loop forever" }, waitingSince: "2026-09-23T01:00:00Z", canDecide: true },
        ],
        total: 1,
        shown: 1,
        tasksAssignedToYou: [
          { issueId: "issue-3", identifier: "ACME-313", title: "Pick the launch date", status: "todo", updatedAt: "2026-09-23T09:00:00Z" },
        ],
        tasksAssignedToYouTotal: 1,
      };
    }
    return null;
  });
}

function makeTools(client: PaperclipApiClient = seededClient()) {
  const ctx = new AssistantContext(client, "company-1");
  const byName = new Map(assistantTools(client, ctx).map((tool) => [tool.name, tool]));
  return {
    byName,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`unknown tool ${name}`);
      return tool.execute(args);
    },
  };
}

describe("assistant toolset surface", () => {
  it("exposes exactly the nine read tools, all readOnlyHint, all with an output schema", () => {
    const { byName } = makeTools();
    expect([...byName.keys()].sort()).toEqual([
      "explain_blocker",
      "find_work",
      "get_project",
      "get_work_item",
      "list_pending_decisions",
      "list_projects",
      "list_team",
      "whats_new",
      "whoami",
    ]);
    for (const tool of byName.values()) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.outputSchema).toBeTruthy();
      expect(tool.description).toMatch(/^AgentDash: /);
    }
  });

  it("pins tool names and descriptions", () => {
    const { byName } = makeTools();
    const surface = [...byName.values()]
      .map((tool) => ({ name: tool.name, description: tool.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(surface).toMatchInlineSnapshot(`
      [
        {
          "description": "AgentDash: why a task is blocked or stalled, and what would unblock it (often a decision from you).",
          "name": "explain_blocker",
        },
        {
          "description": "AgentDash: find tasks by words, status, person or project. Use before creating a task, to avoid duplicates.",
          "name": "find_work",
        },
        {
          "description": "AgentDash: how one project is going. Progress, who is on it, what is blocked, and what shipped.",
          "name": "get_project",
        },
        {
          "description": "AgentDash: one task's current state. Status, owner, latest update, linked PRs and pending decisions.",
          "name": "get_work_item",
        },
        {
          "description": "AgentDash: approvals and questions waiting on you, plus open tasks assigned to you, most urgent first.",
          "name": "list_pending_decisions",
        },
        {
          "description": "AgentDash: the company's projects with a one-line status each.",
          "name": "list_projects",
        },
        {
          "description": "AgentDash: the company's agents, what each is working on, and whether they are running, idle or paused.",
          "name": "list_team",
        },
        {
          "description": "AgentDash: what changed since a time. Finished work with PRs, what is blocked now and what became blocked, and decisions waiting for you. Start here for "what happened".",
          "name": "whats_new",
        },
        {
          "description": "AgentDash: who you are connected as, which company, and what you may do.",
          "name": "whoami",
        },
      ]
    `);
  });

  it("the journey tools still list under the setup toolset, and the agent toolset is unchanged", () => {
    const client = new RealClient(CONFIG);
    const setup = buildToolSurface(client, CONFIG, "setup").map((t) => t.name);
    const assistant = buildToolSurface(client, CONFIG, "assistant").map((t) => t.name);
    const agent = buildToolSurface(client, CONFIG, "agent").map((t) => t.name);

    expect(setup).toContain("agentdash_setup_status");
    expect(setup).toContain("agentdash_pause_agent");
    expect(setup).toHaveLength(17);
    // M1's nine reads plus M3's five work tools (GH #678).
    expect(assistant).toHaveLength(14);
    expect(assistant).not.toContain("agentdash_setup_status");
    // The agent surface is the union it always was.
    expect(agent).toEqual(expect.arrayContaining(setup));
    expect(agent.length).toBeGreaterThan(setup.length + 9);
  });

  it("AGENTDASH_TOOLSET parses, defaults to agent, and rejects nonsense", () => {
    expect(parseToolset(undefined)).toBe("agent");
    expect(parseToolset("assistant")).toBe("assistant");
    expect(parseToolset(" SETUP ")).toBe("setup");
    expect(() => parseToolset("everything")).toThrow(/AGENTDASH_TOOLSET/);
    expect(() => createAgentDashServer(CONFIG, { toolset: "assistant" })).not.toThrow();
  });
});

describe("§5 envelope", () => {
  it("whoami returns content text plus structuredContent with the declared shape", async () => {
    const { call } = makeTools();
    const result = await call("whoami");
    expect(result.content[0].text.length).toBeLessThanOrEqual(600);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("ok");
    expect(structured.summary).toBe(result.content[0].text);
    expect(structured.asOf).toEqual(expect.any(String));
    const data = structured.data as Record<string, unknown>;
    expect((data.company as Record<string, unknown>).prefix).toBe("ACME");
    expect((data.links as Record<string, unknown>).home).toBe(
      "https://dash.example.test/ACME/dashboard",
    );
  });

  it("deep links come from publicBaseUrl with the company prefix", async () => {
    const { call } = makeTools();
    const result = await call("find_work", { query: "checkout" });
    const structured = result.structuredContent as Record<string, unknown>;
    const items = (structured.data as Record<string, unknown>).items as Array<Record<string, unknown>>;
    expect(items[0].link).toBe("https://dash.example.test/ACME/issues/ACME-311");
  });
});

describe("name resolution", () => {
  it("an identifier ref resolves directly to the task", async () => {
    const { call } = makeTools();
    const result = await call("get_work_item", { ref: "ACME-311" });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("ok");
  });

  it("an unknown ref returns not_found", async () => {
    const client = seededClient((path) =>
      path.startsWith("/companies/company-1/issues") ? [] : undefined,
    );
    const { call } = makeTools(client);
    const result = await call("get_work_item", { ref: "nonexistent thing" });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("not_found");
  });

  it("an ambiguous ref returns needs_clarification with ≤5 linked candidates", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `issue-${i}`,
      identifier: `ACME-${300 + i}`,
      title: `Checkout fix ${i}`,
      status: "todo",
      updatedAt: "2026-09-23T00:00:00Z",
    }));
    const client = seededClient((path) =>
      path.startsWith("/companies/company-1/issues") ? many : undefined,
    );
    const { call } = makeTools(client);
    const result = await call("get_work_item", { ref: "checkout" });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("needs_clarification");
    const candidates = structured.candidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBeLessThanOrEqual(5);
    for (const candidate of candidates) {
      expect(candidate.link).toMatch(/\/ACME\/issues\//);
    }
  });

  it("a ref that resolves in another company answers not_found, never the row", async () => {
    const client = seededClient((path) =>
      path === "/issues/ACME-311" ? { ...ISSUES[0], companyId: "company-2" } : undefined,
    );
    const { call } = makeTools(client);
    const result = await call("get_work_item", { ref: "ACME-311" });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("not_found");
    expect(JSON.stringify(result)).not.toContain("Checkout retries");
  });

  it("a project UUID that resolves in another company answers not_found", async () => {
    const foreignId = "123e4567-e89b-42d3-a456-426614174000";
    const client = seededClient((path) =>
      path === `/projects/${foreignId}` ? { ...PROJECTS[0], id: foreignId, companyId: "company-2" } : undefined,
    );
    const { call } = makeTools(client);
    const result = await call("get_project", { project: foreignId });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("not_found");
  });

  it("an ambiguous agent filter returns needs_clarification, not a guessed assignee", async () => {
    const dupes = [
      { id: "a1", name: "Priya", role: "engineer", status: "idle" },
      { id: "a2", name: "Priya", role: "qa", status: "idle" },
    ];
    const client = seededClient((path) =>
      path.startsWith("/companies/company-1/agents") ? dupes : undefined,
    );
    const { call } = makeTools(client);
    const result = await call("find_work", { agent: "Priya" });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("needs_clarification");
  });
});

describe("tool outputs", () => {
  it("whats_new summarizes shipped, blocked and decisions with a link", async () => {
    const { call } = makeTools();
    const result = await call("whats_new", { since: "12h" });
    const text = result.content[0].text;
    expect(text).toMatch(/finished/i);
    expect(text).toMatch(/blocked/i);
    expect(text).toMatch(/decision/i);
    const structured = result.structuredContent as Record<string, unknown>;
    const data = structured.data as Record<string, unknown>;
    expect((data.shipped as Record<string, unknown>).total).toBe(1);
    expect((data.blockedNow as Record<string, unknown>).total).toBe(1);
    expect((data.newlyBlocked as Record<string, unknown>).total).toBe(1);
    expect((data.decisionsWaiting as Record<string, unknown>).total).toBe(1);
  });

  it("whats_new reports a stale blocker as currently blocked even when newlyBlocked is empty", async () => {
    const client = seededClient((path) =>
      path.startsWith("/companies/company-1/assistant/digest")
        ? {
            agentsAnsweredFor: 1,
            since: "2026-09-22T14:00:00Z",
            asOf: "2026-09-23T14:00:00Z",
            shipped: { total: 0, shown: 0, items: [] },
            blockedNow: { total: 1, shown: 1, items: [{ issueId: "issue-1", identifier: "ACME-311", title: "Checkout retries loop forever", agentName: "Priya" }] },
            newlyBlocked: { total: 0, shown: 0, items: [] },
            decisionsWaiting: { total: 0, shown: 0, items: [] },
            truncated: false,
          }
        : undefined,
    );
    const { call } = makeTools(client);
    const result = await call("whats_new", { since: "12h" });
    expect(result.content[0].text).toMatch(/1 currently blocked/);
    const data = (result.structuredContent as Record<string, unknown>).data as Record<string, unknown>;
    expect((data.blockedNow as Record<string, unknown>).total).toBe(1);
    expect((data.newlyBlocked as Record<string, unknown>).total).toBe(0);
  });

  it("get_work_item quotes agent text as agent-authored under agentWrote", async () => {
    const { call } = makeTools();
    const result = await call("get_work_item", { ref: "ACME-311" });
    const structured = result.structuredContent as Record<string, unknown>;
    const data = structured.data as Record<string, unknown>;
    const comments = data.latestComments as Array<Record<string, unknown>>;
    expect(comments[0].agentWrote).toBe(true);
    expect(result.content[0].text).toMatch(/Priya wrote:/);
  });

  it("whats_new bounds digest titles and work-product text under agentWrote", async () => {
    const long = "unbounded agent text ".repeat(40);
    const client = seededClient((path) =>
      path.startsWith("/companies/company-1/assistant/digest")
        ? {
            agentsAnsweredFor: 1,
            since: "2026-09-22T14:00:00Z",
            asOf: "2026-09-23T14:00:00Z",
            shipped: {
              total: 1,
              shown: 1,
              items: [
                {
                  issueId: "issue-9",
                  identifier: "ACME-399",
                  title: long,
                  agentName: "Priya",
                  workProducts: [
                    { type: "pull_request", provider: "github", title: long, url: "https://github.test/pr/9", status: "merged", reviewState: "approved", summary: long },
                  ],
                },
              ],
            },
            blockedNow: { total: 0, shown: 0, items: [] },
            newlyBlocked: { total: 0, shown: 0, items: [] },
            decisionsWaiting: { total: 0, shown: 0, items: [] },
            truncated: false,
          }
        : undefined,
    );
    const { call } = makeTools(client);
    const result = await call("whats_new", {});
    const data = (result.structuredContent as Record<string, unknown>).data as Record<string, unknown>;
    const item = ((data.shipped as Record<string, unknown>).items as Array<Record<string, unknown>>)[0];
    expect((item.title as string).length).toBeLessThanOrEqual(120);
    const wp = (item.workProducts as Array<Record<string, unknown>>)[0];
    expect(wp.agentWrote).toBe(true);
    expect((wp.title as string).length).toBeLessThanOrEqual(120);
    expect((wp.summary as string).length).toBeLessThanOrEqual(280);
  });

  it("whats_new refuses a non-ISO since like a bare numeral", async () => {
    const { call } = makeTools();
    const result = await call("whats_new", { since: "1" });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("refused");
    expect(structured.summary).toMatch(/ISO 8601/);
  });

  it("find_work refuses a status outside the task-status enum", async () => {
    const { call } = makeTools();
    const result = await call("find_work", { status: "nonsense" });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("refused");
  });

  it("explain_blocker reports the declaration, the stop reason and options", async () => {
    const { call } = makeTools();
    const result = await call("explain_blocker", { ref: "ACME-311" });
    const structured = result.structuredContent as Record<string, unknown>;
    const data = structured.data as Record<string, unknown>;
    expect(data.status).toBe("blocked");
    const evidence = data.evidence as Array<Record<string, unknown>>;
    expect(evidence.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["blocked_declaration", "run_stop", "pending_decision"]),
    );
    const options = data.unblockOptions as Array<Record<string, unknown>>;
    expect(options.map((o) => o.tool)).toContain("list_pending_decisions");
  });

  it("explain_blocker frames a comment-derived reason with its author", async () => {
    const { call } = makeTools();
    const result = await call("explain_blocker", { ref: "ACME-311" });
    const structured = result.structuredContent as Record<string, unknown>;
    const data = structured.data as Record<string, unknown>;
    expect(data.reason).toMatch(/^Priya wrote: "/);
    expect(result.content[0].text).toMatch(/Priya wrote:/);
  });

  it("list_pending_decisions surfaces canDecide and the approval link", async () => {
    const { call } = makeTools();
    const result = await call("list_pending_decisions");
    const structured = result.structuredContent as Record<string, unknown>;
    const data = structured.data as Record<string, unknown>;
    const decisions = data.decisions as Array<Record<string, unknown>>;
    expect(decisions[0].canDecide).toBe(true);
    expect(decisions[0].link).toBe("https://dash.example.test/ACME/approvals/appr-1");
  });

  it("list_pending_decisions includes tasks assigned to the calling person", async () => {
    const { call } = makeTools();
    const result = await call("list_pending_decisions");
    const data = (result.structuredContent as Record<string, unknown>).data as Record<string, unknown>;
    const tasks = data.tasksAssignedToYou as Array<Record<string, unknown>>;
    expect(data.tasksAssignedToYouTotal).toBe(1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].identifier).toBe("ACME-313");
    expect(tasks[0].link).toBe("https://dash.example.test/ACME/issues/ACME-313");
    expect(result.content[0].text).toMatch(/1 task assigned to you/);
  });

  it("get_work_item names the person a task is assigned to", async () => {
    const { call } = makeTools();
    const result = await call("get_work_item", { ref: "ACME-313" });
    const data = (result.structuredContent as Record<string, unknown>).data as Record<string, unknown>;
    const card = data.item as Record<string, unknown>;
    expect((card.owner as Record<string, unknown>)?.name).toBe("Kai");
  });

  it("list_team reports each agent's state and current item", async () => {
    const client = seededClient((path) =>
      path.startsWith("/companies/company-1/issues?status=in_progress")
        ? [{ ...ISSUES[0], status: "in_progress" }]
        : undefined,
    );
    const { call } = makeTools(client);
    const result = await call("list_team");
    const structured = result.structuredContent as Record<string, unknown>;
    const data = structured.data as Record<string, unknown>;
    const agents = data.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe("Priya");
    expect((agents[0].currentItem as Record<string, unknown>).ref).toBe("ACME-311");
  });

  it("bounded lists report total and truncated", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `issue-${i}`,
      identifier: `ACME-${400 + i}`,
      title: `Task ${i}`,
      status: "todo",
      updatedAt: "2026-09-23T00:00:00Z",
    }));
    const client = seededClient((path) =>
      path.startsWith("/companies/company-1/issues") ? many : undefined,
    );
    const { call } = makeTools(client);
    const result = await call("find_work", { query: "Task" });
    const structured = result.structuredContent as Record<string, unknown>;
    const data = structured.data as Record<string, unknown>;
    expect(data.total).toBe(15);
    expect((data.items as unknown[]).length).toBe(10);
    expect(data.truncated).toBe(true);
  });
});

describe("redaction", () => {
  it("strips forbidden keys and secret-looking strings from serialized output", () => {
    const poisoned = {
      item: {
        title: "Deploy",
        adapterConfig: { env: { STRIPE_KEY: "sk_live_123" } },
        contextSnapshot: { secrets: true },
        env: { API_KEY: "abc" },
        note: "token is pcp_abc123XYZ789 and Bearer hunter2hunter2",
        budget: 500,
        mandate: "never email customers",
      },
    };
    const clean = redactAssistantValue(poisoned);
    expect(findForbiddenPaths(clean)).toEqual([]);
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toMatch(/sk_live|adapterConfig|contextSnapshot|hunter2|pcp_abc|mandate|budget/i);
    expect(serialized).toMatch(/\[redacted-key\]|\[redacted\]/);
  });

  it("scrubs assistant tokens, provider secrets and foreign emails, keeps the caller's own", () => {
    const poisoned = {
      note: [
        "reach teammate@other.test",
        "pcpa_abcdefgh12345678",
        "sk-abcdefghijklmnop",
        "ghp_abcdefghijklmnop",
        "github_pat_11ABCDEFG_abcdefghijklmnop",
        "xoxb-1234567890-abcdefghijkl",
        "sk_live_abcdefghijklmnop",
        "rk_live_abcdefghijklmnop",
      ].join(" "),
      mine: "kai@acme.test",
    };
    const clean = redactAssistantValue(poisoned, { allowEmails: ["kai@acme.test"] });
    expect(findForbiddenPaths(clean, { allowEmails: ["kai@acme.test"] })).toEqual([]);
    const serialized = JSON.stringify(clean);
    for (const shape of [
      /teammate@other\.test/,
      /pcpa_/,
      /sk-/,
      /ghp_/,
      /github_pat_/,
      /xoxb-/,
      /sk_live_/,
      /rk_live_/,
    ]) {
      expect(serialized).not.toMatch(shape);
    }
    expect(serialized).toContain("kai@acme.test");
    expect(serialized).toContain("[redacted-email]");
    // Without the allowance even the caller's own address is scrubbed.
    const strict = redactAssistantValue({ mine: "kai@acme.test" });
    expect(JSON.stringify(strict)).not.toContain("kai@acme.test");
  });

  it("the real tool outputs carry no forbidden paths", async () => {
    const { call } = makeTools();
    for (const [name, args] of [
      ["whoami", {}],
      ["whats_new", {}],
      ["list_projects", {}],
      ["get_project", { project: "Dark mode" }],
      ["find_work", { query: "checkout" }],
      ["get_work_item", { ref: "ACME-311" }],
      ["explain_blocker", { ref: "ACME-311" }],
      ["list_team", {}],
      ["list_pending_decisions", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await call(name, args);
      const wire = JSON.stringify(result);
      // whoami is allowed to relay the caller's own email — the same
      // allowance the tool passes to the redactor.
      expect(
        findForbiddenPaths(result.structuredContent, {
          allowEmails: name === "whoami" ? ["kai@acme.test"] : [],
        }),
      ).toEqual([]);
      expect(wire).not.toMatch(/adapterConfig|contextSnapshot|stdoutExcerpt|stderrExcerpt|pcp_[A-Za-z0-9_-]{8,}|mandate|directive/i);
    }
  });
});
