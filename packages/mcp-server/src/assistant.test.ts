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
];

const PROJECTS = [
  { id: "project-1", name: "Dark mode", status: "active", leadAgentId: "agent-1", description: "Add dark mode" },
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
    if (path.startsWith("/companies/company-1/projects")) return PROJECTS;
    if (path.startsWith("/projects/")) return PROJECTS[0];
    if (path.startsWith("/companies/company-1/issues")) return ISSUES;
    if (path === "/issues/issue-1" || path === "/issues/ACME-311") return ISSUES[0];
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
        blocked: { total: 1, shown: 1, items: [{ issueId: "issue-1", identifier: "ACME-311", title: "Checkout retries loop forever", agentName: "Priya" }] },
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
          "description": "AgentDash: approvals and questions from agents that are waiting on you, most urgent first.",
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
          "description": "AgentDash: what changed since a time. Finished work with PRs, new blockers, and decisions waiting for you. Start here for "what happened".",
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
    expect(assistant).toHaveLength(9);
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

  it("an ambiguous ref returns needs_clarification with ≤5 candidates", async () => {
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
    expect((structured.candidates as unknown[]).length).toBeLessThanOrEqual(5);
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
    expect((data.decisionsWaiting as Record<string, unknown>).total).toBe(1);
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

  it("list_pending_decisions surfaces canDecide and the approval link", async () => {
    const { call } = makeTools();
    const result = await call("list_pending_decisions");
    const structured = result.structuredContent as Record<string, unknown>;
    const data = structured.data as Record<string, unknown>;
    const decisions = data.decisions as Array<Record<string, unknown>>;
    expect(decisions[0].canDecide).toBe(true);
    expect(decisions[0].link).toBe("https://dash.example.test/ACME/approvals/appr-1");
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
      expect(findForbiddenPaths(result.structuredContent)).toEqual([]);
      expect(wire).not.toMatch(/adapterConfig|contextSnapshot|stdoutExcerpt|stderrExcerpt|pcp_[A-Za-z0-9_-]{8,}|mandate|directive/i);
    }
  });
});
