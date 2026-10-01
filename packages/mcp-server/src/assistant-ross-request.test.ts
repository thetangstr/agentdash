import { describe, expect, it } from "vitest";
import type { PaperclipApiClient } from "./client.js";
import { PaperclipApiError } from "./client.js";
import { createAssistantToolDefinitions } from "./assistant/index.js";
import { stripRossRequestMentions } from "@paperclipai/shared";

describe("stripRossRequestMentions (keeps a request scoped to the assignee)", () => {
  it("removes @-mention syntax and mention links but leaves emails and text", () => {
    expect(stripRossRequestMentions("@Priya should we ship? cc @Theo")).toBe("Priya should we ship? cc Theo");
    expect(stripRossRequestMentions("Ask [@Echo](agent://11111111-1111-4111-8111-111111111111) and [Kai](user://u-1)")).toBe("Ask Echo and Kai");
    expect(stripRossRequestMentions("mail ops@example.com")).toBe("mail ops@example.com");
    expect(stripRossRequestMentions("plain question")).toBe("plain question");
  });
});

/**
 * AgentDash (Ross launch M2): the assistant's governed Ross request. Pins the
 * scope split (filing is work-class, status is read-class), the exact REST
 * call, and that every contract status is reported honestly — a request is
 * never described as an answer or as a started model run.
 */

const ISSUE = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "ACME-7",
  title: "Pricing page rewrite",
  status: "in_progress",
  assigneeAgentId: "agent-ross",
  assigneeUserId: null,
  projectId: "project-1",
};

type Call = { method: string; path: string; body: unknown };
type Handler = (call: Call) => unknown;

function fakeClient(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const client = {
    requestJson: async (method: string, path: string, options: { body?: unknown } = {}) => {
      const call: Call = { method, path, body: options.body };
      calls.push(call);
      const override = handler(call);
      if (override instanceof Error) throw override;
      if (override !== undefined) return override;
      if (path === "/health") return { publicBaseUrl: "https://dash.example.test" };
      if (path === "/companies/company-1") return { id: "company-1", name: "Acme", issuePrefix: "ACME" };
      if (path === `/issues/${ISSUE.identifier}` || path === `/issues/${ISSUE.id}`) return ISSUE;
      if (path.startsWith("/companies/company-1/issues")) return [ISSUE];
      return null;
    },
    appBaseUrl: "https://dash.example.test",
    defaults: { companyId: "company-1", agentId: null, runId: null },
  } as unknown as PaperclipApiClient;
  return { client, calls };
}

function tools(client: PaperclipApiClient, scopes?: string[]) {
  const defs = createAssistantToolDefinitions(client, { companyId: "company-1", assistantScopes: scopes });
  return new Map(defs.map((tool) => [tool.name, tool]));
}

async function call(client: PaperclipApiClient, name: string, args: Record<string, unknown>) {
  const tool = tools(client, ["agentdash:read", "agentdash:work"]).get(name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  const result = await tool.execute(args);
  return result.structuredContent as { status: string; summary: string; data?: Record<string, any> };
}

function apiError(status: number, body: unknown) {
  return new PaperclipApiError({ status, method: "POST", path: "/x", body, message: `failed ${status}` });
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("Ross request tool surface", () => {
  it("files requests only on a work grant; the status read is on every grant", () => {
    const { client } = fakeClient();
    const readOnly = tools(client, ["agentdash:read"]);
    expect(readOnly.has("request_ross_assessment")).toBe(false);
    expect(readOnly.has("ross_request_status")).toBe(true);
    expect(readOnly.get("ross_request_status")!.annotations).toMatchObject({ readOnlyHint: true });

    const work = tools(client, ["agentdash:read", "agentdash:work"]);
    const request = work.get("request_ross_assessment")!;
    expect(request.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(request.description).toMatch(/^AgentDash: /);
    expect(request.outputSchema).toBeTruthy();
  });
});

describe("request_ross_assessment", () => {
  it("posts exactly one request to the governed route with a fresh unguessable key", async () => {
    const { client, calls } = fakeClient((c) =>
      c.method === "POST"
        ? {
            status: "submitted",
            reason: null,
            requestKey: (c.body as { requestKey: string }).requestKey,
            receipt: { commentId: "comment-1", requestedAt: "2026-10-01T10:00:00.000Z", reused: false },
            baselineRevisionId: null,
            reopened: false,
            attribution: { actorUserId: "user-1", authorUserId: "user-1", verified: true, credential: "assistant_grant", limits: "API attribution only" },
            wake: { assignee: "requested", automatic: true },
          }
        : undefined,
    );
    const out = await call(client, "request_ross_assessment", { ref: "ACME-7", question: "Should we ship the new pricing page this week?" });
    const posts = writes(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/issues/${ISSUE.id}/ross-requests`);
    const body = posts[0]!.body as { requestKey: string; question: string };
    expect(Object.keys(body).sort()).toEqual(["question", "requestKey"]);
    expect(body.requestKey).toMatch(/^req-[0-9a-f-]{36}$/);
    expect(out.status).toBe("ok");
    expect(out.data?.requestStatus).toBe("submitted");
    expect(out.data?.requestKey).toBe(body.requestKey);
    expect(out.data?.receipt).toMatchObject({ commentId: "comment-1" });
    expect(out.data?.inference).toMatchObject({ state: "delegated-to-native-run-gates", runAdmission: "not_observed" });
    expect(out.data?.wake).toEqual({ assignee: "requested", automatic: true });
    expect(out.data?.attribution).toMatchObject({ verified: true, credential: "assistant_grant" });
    expect(out.summary).toMatch(/request, not an answer/);
    expect(out.summary).not.toMatch(/answered|started|running/i);
  });

  it("reuses a caller-supplied key and reports a coalesced re-delivery without claiming a new post", async () => {
    const { client, calls } = fakeClient((c) =>
      c.method === "POST"
        ? { status: "coalesced", reason: "identical-request-already-recorded", requestKey: "req-retry-0001", receipt: { commentId: "comment-1", requestedAt: "2026-10-01T10:00:00.000Z", reused: true } }
        : undefined,
    );
    const out = await call(client, "request_ross_assessment", { ref: "ACME-7", question: "Same question", requestKey: "req-retry-0001" });
    expect((writes(calls)[0]!.body as { requestKey: string }).requestKey).toBe("req-retry-0001");
    expect(out.status).toBe("ok");
    expect(out.data?.requestStatus).toBe("coalesced");
    expect(out.summary).toMatch(/did not post it again/);
  });

  it.each([
    [409, { status: "refused", reason: "recovery-exhausted" }, "refused", "recovery-exhausted", "refused"],
    [409, { status: "refused", reason: "task-closed" }, "refused", "task-closed", "refused"],
    [409, { status: "refused", reason: "task-blocked" }, "refused", "task-blocked", "refused"],
    [422, { status: "refused", reason: "question-mentions-agents" }, "refused", "question-mentions-agents", "refused"],
    [409, { status: "conflict", reason: "request-key-carries-different-question" }, "conflict", "request-key-carries-different-question", "refused"],
    [409, { status: "conflict", reason: "request-key-contested-by-foreign-comment" }, "conflict", "request-key-contested-by-foreign-comment", "refused"],
    [422, { status: "unavailable", reason: "no-assigned-agent" }, "unavailable", "no-assigned-agent", "refused"],
    [403, { error: "insufficient_scope", required_scope: "agentdash:work" }, "denied", "grant-lacks-work-scope", "refused"],
    [403, { error: "ross_request_person_only", status: "denied", reason: "person-actor-required" }, "denied", "person-actor-required", "refused"],
    [404, { error: "Issue not found" }, "unavailable", "target-unavailable", "not_found"],
    [429, { error: "assistant_write_rate_limited", retryAfterSeconds: 60 }, "refused", "write-rate-limited", "refused"],
  ])("maps HTTP %s %j to %s/%s and says nothing was posted", async (httpStatus, body, requestStatus, reason, envelopeStatus) => {
    const { client } = fakeClient((c) => (c.method === "POST" ? apiError(httpStatus, body) : undefined));
    const out = await call(client, "request_ross_assessment", { ref: "ACME-7", question: "Why is this late?" });
    expect(out.status).toBe(envelopeStatus);
    expect(out.data?.requestStatus).toBe(requestStatus);
    expect(out.data?.reason).toBe(reason);
    expect(out.data?.posted).toBe(false);
    expect(out.summary).toMatch(/Nothing was posted|nothing was posted|did not post|cannot file requests/);
    if (reason === "task-closed") expect(out.summary).toMatch(/Reopen it first if you mean to/);
    expect(out.data?.inference).toMatchObject({ runAdmission: "not_observed", state: "not-requested" });
  });

  it("an ambiguous write is uncertain, never a refusal that hides a possible post", async () => {
    for (const failure of [apiError(500, { error: "ross_request_uncertain", status: "uncertain", reason: "acceptance-uncertain-read-before-retry" }), apiError(502, null), new Error("socket hang up")]) {
      const { client } = fakeClient((c) => (c.method === "POST" ? failure : undefined));
      const out = await call(client, "request_ross_assessment", { ref: "ACME-7", question: "Status?", requestKey: "req-uncertain-1" });
      expect(out.data?.requestStatus).toBe("uncertain");
      expect(out.data?.posted).toBe("unknown");
      expect(out.data?.requestKey).toBe("req-uncertain-1");
      expect(out.summary).toMatch(/same request key/);
    }
  });

  it("a 2xx without a comment receipt is uncertain, not submitted", async () => {
    const { client } = fakeClient((c) => (c.method === "POST" ? { status: "submitted" } : undefined));
    const out = await call(client, "request_ross_assessment", { ref: "ACME-7", question: "Status?" });
    expect(out.data?.requestStatus).toBe("uncertain");
    expect(out.data?.reason).toBe("accepted-response-lacked-comment-receipt");
  });

  it("an unresolvable task changes nothing", async () => {
    const { client, calls } = fakeClient((c) => (c.path.startsWith("/companies/company-1/issues") ? [] : undefined));
    const out = await call(client, "request_ross_assessment", { ref: "nonexistent thing", question: "Hello?" });
    expect(out.status).toBe("not_found");
    expect(writes(calls)).toHaveLength(0);
  });

  it("a task in another company is not found and never posted to", async () => {
    const { client, calls } = fakeClient((c) => (c.path === `/issues/${ISSUE.id}` ? { ...ISSUE, companyId: "company-2" } : c.path.startsWith("/companies/company-1/issues") ? [] : undefined));
    const out = await call(client, "request_ross_assessment", { ref: ISSUE.id, question: "Hello?" });
    expect(out.status).toBe("not_found");
    expect(writes(calls)).toHaveLength(0);
  });

  it("rejects a malformed request key before any call", async () => {
    const { client, calls } = fakeClient();
    const out = await call(client, "request_ross_assessment", { ref: "ACME-7", question: "Hi", requestKey: "BAD KEY" });
    expect(out.status).toBe("refused");
    expect(calls).toHaveLength(0);
  });
});

describe("ross_request_status", () => {
  const statusPath = `/issues/${ISSUE.id}/ross-requests/req-status-0001`;

  it("relays an answered review as what Ross wrote, redacted and unverified", async () => {
    const { client, calls } = fakeClient((c) =>
      c.path === statusPath
        ? {
            status: "answered",
            reason: null,
            requestKey: "req-status-0001",
            request: { commentId: "comment-1", requestedAt: "2026-10-01T10:00:00.000Z", question: "Ship it?", contested: false },
            review: {
              documentKey: "ross-review", revisionId: "rev-2", revisionNumber: 2, recordedAt: "2026-10-01T10:20:00.000Z", ageMinutes: 5,
              authorAgentId: "agent-ross", attributedToAssignee: true, newerThanRequest: true,
              body: "Ship Thursday. Ping ops@example.com with key sk-abcdefghijklmnop.", truncated: false,
            },
            businessOutcomeVerified: false,
          }
        : undefined,
    );
    const out = await call(client, "ross_request_status", { ref: "ACME-7", requestKey: "req-status-0001" });
    expect(writes(calls)).toHaveLength(0);
    expect(out.status).toBe("ok");
    expect(out.data?.requestStatus).toBe("answered");
    expect(out.data?.review.agentWrote).toContain("Ship Thursday.");
    expect(out.data?.review.agentWrote).not.toContain("sk-abcdefghijklmnop");
    expect(out.data?.review.agentWrote).not.toContain("ops@example.com");
    expect(out.data?.businessOutcomeVerified).toBe(false);
    expect(out.summary).toMatch(/not independently checked/);
  });

  it("never relays a review body that does not answer the request", async () => {
    const { client } = fakeClient((c) =>
      c.path === statusPath
        ? {
            status: "pending",
            reason: "review-author-not-assigned-agent",
            requestKey: "req-status-0001",
            request: { commentId: "comment-1", requestedAt: "2026-10-01T10:00:00.000Z", question: "Ship it?", contested: false },
            review: { documentKey: "ross-review", revisionId: "rev-3", revisionNumber: 3, recordedAt: "2026-10-01T10:30:00.000Z", ageMinutes: 1, authorAgentId: "agent-other", attributedToAssignee: false, newerThanRequest: true },
            gate: { state: "wake-recorded", wakeStatus: "queued", run: null },
          }
        : undefined,
    );
    const out = await call(client, "ross_request_status", { ref: "ACME-7", requestKey: "req-status-0001" });
    expect(out.data?.requestStatus).toBe("pending");
    expect(out.data?.review.agentWrote).toBeUndefined();
    expect(out.summary).toMatch(/does not count/);
  });

  it("reports refused, conflict and not_found without inventing progress", async () => {
    for (const [status, envelope] of [["refused", "refused"], ["conflict", "refused"], ["not_found", "not_found"]] as const) {
      const { client } = fakeClient((c) => (c.path === statusPath ? { status, reason: "x", requestKey: "req-status-0001" } : undefined));
      const out = await call(client, "ross_request_status", { ref: "ACME-7", requestKey: "req-status-0001" });
      expect(out.status).toBe(envelope);
      expect(out.data?.requestStatus).toBe(status);
    }
  });

  it("an unreachable task is not found", async () => {
    const { client } = fakeClient((c) => (c.path === statusPath ? apiError(404, { error: "Issue not found" }) : undefined));
    const out = await call(client, "ross_request_status", { ref: "ACME-7", requestKey: "req-status-0001" });
    expect(out.status).toBe("not_found");
  });
});
