import { describe, expect, it } from "vitest";
import type { PaperclipApiClient } from "./client.js";
import { PaperclipApiError } from "./client.js";
import { AssistantContext } from "./assistant/context.js";
import { assistantTools } from "./assistant/tools.js";
import { assistantWorkTools } from "./assistant/work.js";
import type { PaperclipMcpConfig } from "./config.js";

/**
 * AgentDash assistant MCP (M3, GH #678): pins the person-facing work
 * toolset — the five write tools' names, annotations (readOnlyHint: false,
 * destructiveHint on update_work_item), resolve-before-write behaviour, the
 * "best fit" → Chief of Staff rule, the duplicate hint, and the exact REST
 * calls each tool makes (method + path + body) against a fake client.
 */

const CONFIG: PaperclipMcpConfig = {
  apiUrl: "https://dash.example.test/api",
  apiKey: "pcpa_test",
  companyId: "company-1",
  agentId: null,
  runId: null,
};
void CONFIG;

const COMPANY = { id: "company-1", name: "Acme", issuePrefix: "ACME" };

const COS = { id: "agent-cos", name: "Marlowe", role: "chief_of_staff", title: "Chief of Staff", status: "idle" };
const PRIYA = { id: "agent-1", name: "Priya", role: "engineer", title: "Engineer", status: "idle" };
const THEO = { id: "agent-2", name: "Theo", role: "engineer", title: "Engineer", status: "idle" };

const ISSUE = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "ACME-311",
  title: "Checkout retries loop forever",
  status: "todo",
  priority: "high",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  projectId: "project-1",
  description: "Card declines are retried forever",
  updatedAt: "2026-09-25T02:14:00Z",
};

const PROJECTS = [
  { id: "project-1", companyId: "company-1", name: "Checkout", status: "active", description: null },
];

type Call = { method: string; path: string; body: unknown };
type Handler = (call: Call) => unknown;

function fakeClient(handler: Handler): { client: PaperclipApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    requestJson: async (method: string, path: string, options: { body?: unknown } = {}) => {
      const call: Call = { method, path, body: options.body };
      calls.push(call);
      const out = handler(call);
      if (out instanceof Error) throw out;
      return out;
    },
    appBaseUrl: "https://dash.example.test",
    defaults: { companyId: "company-1", agentId: null, runId: null },
  } as unknown as PaperclipApiClient;
  return { client, calls };
}

function seededClient(overrides: Handler = () => undefined) {
  return fakeClient((call) => {
    const { method, path } = call;
    const override = overrides(call);
    if (override !== undefined) return override;
    if (method !== "GET") return null;
    if (path === "/health") return { publicBaseUrl: "https://dash.example.test" };
    if (path === "/companies/company-1") return COMPANY;
    if (path.startsWith("/companies/company-1/agents")) return [COS, PRIYA, THEO];
    if (path === "/companies/company-1/people") return { people: [{ userId: "user-1", name: "Kai" }] };
    if (path.startsWith("/companies/company-1/projects")) return PROJECTS;
    if (path.startsWith("/projects/")) return PROJECTS[0];
    if (path.startsWith("/companies/company-1/issues")) return [ISSUE];
    if (path === `/issues/${ISSUE.id}` || path === `/issues/${ISSUE.identifier}`) return ISSUE;
    if (path === `/agents/${PRIYA.id}`) return PRIYA;
    if (path === `/agents/${COS.id}`) return COS;
    return null;
  });
}

function makeTools(client: PaperclipApiClient) {
  const ctx = new AssistantContext(client, "company-1");
  const byName = new Map(
    [...assistantTools(client, ctx), ...assistantWorkTools(client, ctx)].map((tool) => [tool.name, tool]),
  );
  return {
    byName,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`unknown tool ${name}`);
      return tool.execute(args);
    },
  };
}

const structured = (result: Awaited<ReturnType<ReturnType<typeof makeTools>["call"]>>) =>
  result.structuredContent as {
    status: string;
    summary: string;
    data?: Record<string, unknown>;
    candidates?: Array<{ label: string; ref: string }>;
  };

describe("assistant work toolset surface", () => {
  it("adds exactly the five work tools, none readOnly, update_work_item destructive", () => {
    const { byName } = makeTools(seededClient().client);
    const workNames = ["assign_work", "comment_on_work", "create_work_item", "start_project", "update_work_item"];
    for (const name of workNames) expect(byName.has(name), name).toBe(true);
    for (const name of workNames) {
      const tool = byName.get(name)!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: false });
      expect(tool.description).toMatch(/^AgentDash: /);
      expect(tool.outputSchema).toBeTruthy();
    }
    expect(byName.get("update_work_item")!.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.get("start_project")!.annotations).toMatchObject({ destructiveHint: false });
    // The read surface still carries its annotations.
    for (const tool of byName.values()) {
      if (workNames.includes(tool.name)) continue;
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    }
  });
});

describe("start_project", () => {
  it("creates the project and a CoS kickoff task when lead is omitted", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "POST" && call.path === "/companies/company-1/projects") {
        return { id: "project-new", companyId: "company-1", name: "Billing revamp", status: "backlog" };
      }
      if (call.method === "POST" && call.path === "/companies/company-1/issues") {
        return {
          id: "issue-new",
          companyId: "company-1",
          identifier: "ACME-400",
          title: (call.body as { title: string }).title,
          status: "todo",
          priority: "medium",
          assigneeAgentId: (call.body as { assigneeAgentId: string }).assigneeAgentId,
          projectId: "project-new",
          description: null,
        };
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("start_project", { name: "Billing revamp", goal: "Make invoicing not suck" }));

    expect(result.status).toBe("ok");
    const posts = calls.filter((c) => c.method === "POST");
    const projectPost = posts.find((c) => c.path === "/companies/company-1/projects")!;
    expect(projectPost.body).toMatchObject({ name: "Billing revamp", description: "Make invoicing not suck", leadAgentId: COS.id });
    const issuePost = posts.find((c) => c.path === "/companies/company-1/issues")!;
    expect(issuePost.body).toMatchObject({
      projectId: "project-new",
      assigneeAgentId: COS.id,
      status: "todo",
      // GH #745 review: the deterministic dedup key makes the kickoff
      // retry-safe — same project, same requestId, server returns the row.
      requestId: "start_project:project-new",
    });
    expect((issuePost.body as { title: string }).title).toContain("Billing revamp");
    expect(result.data?.wakeQueued).toBe(true);
  });

  it("reuses a replayed project and its kickoff instead of duplicating", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "POST" && call.path === "/companies/company-1/projects") {
        return { id: "project-old", companyId: "company-1", name: "Billing revamp", status: "active", replayed: true, kickoffPending: true };
      }
      if (call.method === "POST" && call.path === "/companies/company-1/issues") {
        const body = call.body as { requestId?: string };
        // The retry must carry the kickoff key for the PROJECT it adopted —
        // here the original project's id, not a new one.
        expect(body.requestId).toBe("start_project:project-old");
        return { id: "issue-old", companyId: "company-1", identifier: "ACME-9", title: "Kick off Billing revamp", status: "todo", priority: "medium", replayed: true };
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("start_project", { name: "Billing revamp" }));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("already exists");
    expect(result.data?.projectReused).toBe(true);
    expect(result.data?.kickoffReplayed).toBe(true);
    // One project POST, one issue POST — the retry finishes, never doubles.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("returns needs_clarification on an ambiguous lead and writes nothing", async () => {
    const { client, calls } = seededClient();
    const { call } = makeTools(client);
    const result = structured(await call("start_project", { name: "X", lead: "engineer" }));
    expect(result.status).toBe("needs_clarification");
    expect(result.candidates?.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
});

describe("create_work_item", () => {
  it("files a task assigned to the named agent as todo so the wake fires", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "POST" && call.path === "/companies/company-1/issues") {
        return {
          ...(call.body as Record<string, unknown>),
          id: "issue-new",
          companyId: "company-1",
          identifier: "ACME-401",
        };
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(
      await call("create_work_item", { title: "Webhooks for payouts", assignee: "Priya", project: "Checkout", priority: "high" }),
    );
    expect(result.status).toBe("ok");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      title: "Webhooks for payouts",
      projectId: "project-1",
      assigneeAgentId: "agent-1",
      priority: "high",
      status: "todo",
    });
    expect(result.data?.wakeQueued).toBe(true);
  });

  it("routes \"best fit\" to the Chief of Staff", async () => {
    const { client, calls } = seededClient((call) =>
      call.method === "POST" ? { ...(call.body as object), id: "issue-new", companyId: "company-1", identifier: "ACME-402" } : undefined,
    );
    const { call } = makeTools(client);
    const result = structured(await call("create_work_item", { title: "Plan the offsite", assignee: "best fit" }));
    expect(result.status).toBe("ok");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ assigneeAgentId: COS.id });
  });

  it("includes the duplicate hint without blocking creation", async () => {
    const { client } = seededClient((call) => {
      if (call.method === "GET" && call.path.includes("q=")) return [ISSUE];
      if (call.method === "POST") return { ...(call.body as object), id: "issue-new", companyId: "company-1", identifier: "ACME-403" };
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("create_work_item", { title: "Checkout retries loop forever" }));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("look similar");
    const dupes = result.data?.possibleDuplicates as Array<{ ref: string }>;
    expect(dupes[0].ref).toBe("ACME-311");
  });
});

describe("assign_work", () => {
  it("PATCHes the assignee and reports before/after with the wake queued", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "PATCH") return { ...ISSUE, assigneeAgentId: "agent-2" };
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("assign_work", { ref: "ACME-311", agent: "Theo" }));
    expect(result.status).toBe("ok");
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/issues/issue-1");
    // assigneeUserId is cleared too — single-assignee invariant.
    expect(patch.body).toEqual({ assigneeAgentId: "agent-2", assigneeUserId: null });
    // No explicit wakeup call — the route's assignment wake covers it.
    expect(calls.some((c) => c.path.includes("wakeup"))).toBe(false);
    const data = result.data as { before: { assignee: string | null }; after: { assignee: string | null }; wakeQueued: boolean };
    expect(data.before.assignee).toBe("Priya");
    expect(data.after.assignee).toBe("Theo");
    expect(data.wakeQueued).toBe(true);
  });

  it("with no agent, nudges the current owner via the wakeup route", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "POST" && call.path.includes("wakeup")) return { id: "run-1", status: "queued" };
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("assign_work", { ref: "ACME-311" }));
    expect(result.status).toBe("ok");
    const wake = calls.find((c) => c.path === "/agents/agent-1/wakeup")!;
    expect(wake.method).toBe("POST");
    // GH #745 review: the paid wake carries an idempotencyKey scoped to the
    // task inside an hourly bucket — a retry replays, it cannot double-wake.
    expect((wake.body as { idempotencyKey?: string }).idempotencyKey).toMatch(/^assistant_nudge:issue-1:\d+$/);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(result.data?.wakeQueued).toBe(true);
  });

  it("refuses a nudge on an unassigned task", async () => {
    const { client, calls } = seededClient();
    const { call } = makeTools(client);
    const result = structured(
      await call("assign_work", { ref: "unassigned" }),
    );
    expect(result.status).toBe("not_found");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
});

describe("comment_on_work", () => {
  it("posts the person's words as a comment and returns its id", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "POST" && call.path.includes("comments")) return { id: "comment-1" };
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("comment_on_work", { ref: "ACME-311", text: "Use the sandbox key, it's in 1Password." }));
    expect(result.status).toBe("ok");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/issues/issue-1/comments");
    expect(post.body).toEqual({ body: "Use the sandbox key, it's in 1Password." });
    expect(result.data?.commentId).toBe("comment-1");
  });
});

describe("update_work_item", () => {
  it("PATCHes only the given fields and echoes before/after", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "PATCH") return { ...ISSUE, ...(call.body as object) };
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("update_work_item", { ref: "ACME-311", status: "done" }));
    expect(result.status).toBe("ok");
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ status: "done" });
    const data = result.data as { before: { status: string }; after: { status: string } };
    expect(data.before.status).toBe("todo");
    expect(data.after.status).toBe("done");
  });

  it("refuses a call with nothing to change", async () => {
    const { client, calls } = seededClient();
    const { call } = makeTools(client);
    const result = structured(await call("update_work_item", { ref: "ACME-311" }));
    expect(result.status).toBe("refused");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
});

describe("upstream refusals map to the refused envelope", () => {
  it("403 insufficient_scope explains the missing work scope", async () => {
    const { client } = seededClient((call) => {
      if (call.method === "POST") {
        return new PaperclipApiError({
          status: 403,
          method: "POST",
          path: call.path,
          body: { error: "insufficient_scope", required_scope: "agentdash:work" },
          message: "POST failed with 403",
        });
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("create_work_item", { title: "Anything" }));
    expect(result.status).toBe("refused");
    expect(result.summary).toContain("agentdash:work");
  });

  it("429 rate limit explains the hourly budget, not a crash", async () => {
    const { client } = seededClient((call) => {
      if (call.method === "POST") {
        return new PaperclipApiError({
          status: 429,
          method: "POST",
          path: call.path,
          body: { error: "assistant_write_rate_limited", retryAfterSeconds: 600 },
          message: "POST failed with 429",
        });
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("create_work_item", { title: "Anything" }));
    expect(result.status).toBe("refused");
    expect(result.summary).toContain("hourly write limit");
  });

  it("an unmapped error answers with a generic refusal — no method, path or id", async () => {
    const { client } = seededClient((call) => {
      if (call.method === "POST") {
        return new PaperclipApiError({
          status: 500,
          method: "POST",
          path: "/companies/company-1/issues/550e8400-e29b-41d4-a716-446655440000",
          body: { error: "relation `secret_table` does not exist" },
          message: "POST failed with 500",
        });
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("create_work_item", { title: "Anything" }));
    expect(result.status).toBe("refused");
    expect(result.summary).not.toContain("550e8400");
    expect(result.summary).not.toContain("secret_table");
    expect(result.summary).not.toContain("POST");
    expect(result.summary).not.toContain("/companies/");
  });
});
