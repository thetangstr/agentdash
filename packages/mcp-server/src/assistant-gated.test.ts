import { describe, expect, it } from "vitest";
import type { PaperclipApiClient } from "./client.js";
import { PaperclipApiError } from "./client.js";
import { AssistantContext } from "./assistant/context.js";
import { assistantGatedTools } from "./assistant/gated.js";
import type { PaperclipMcpConfig } from "./config.js";

/**
 * AgentDash assistant MCP (M4, GH #679, spec §7): pins the gated toolset —
 * the three tools' names and annotations, the exact REST calls each makes,
 * approval-ref resolution (id vs description), the read-back/hand-off
 * contract, and the refusal mapping that relays the server's reason.
 */

const CONFIG: PaperclipMcpConfig = {
  apiUrl: "https://dash.example.test/api",
  apiKey: "pcpa_test",
  companyId: "company-1",
  agentId: null,
  runId: null,
};
void CONFIG;

type Call = { method: string; path: string; body: unknown };
type Handler = (call: Call) => unknown;

const APPROVAL_ID = "550e8400-e29b-41d4-a716-446655440000";

const PENDING_DECISIONS = {
  decisions: [
    {
      approvalId: APPROVAL_ID,
      kind: "hire_agent",
      summary: "Priya asks to hire a new agent.",
      askedBy: "Priya",
      canDecide: true,
    },
    {
      approvalId: "660e8400-e29b-41d4-a716-446655440001",
      kind: "send_email",
      summary: "Theo asks to send an email.",
      askedBy: "Theo",
      canDecide: true,
    },
  ],
};

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
    if (path === "/companies/company-1") return { id: "company-1", name: "Acme", issuePrefix: "ACME" };
    if (path === "/companies/company-1/assistant/pending-decisions") return PENDING_DECISIONS;
    return null;
  });
}

function makeTools(client: PaperclipApiClient) {
  const ctx = new AssistantContext(client, "company-1");
  const byName = new Map(assistantGatedTools(client, ctx).map((tool) => [tool.name, tool]));
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
    candidates?: Array<{ label: string; ref: string; link?: string }>;
    links?: Record<string, string>;
  };

describe("assistant gated toolset surface", () => {
  it("adds exactly the three gated tools; only confirm_action is destructive", () => {
    const { byName } = makeTools(seededClient().client);
    expect([...byName.keys()].sort()).toEqual(["confirm_action", "prepare_decision", "request_hire"]);
    for (const name of ["prepare_decision", "request_hire", "confirm_action"]) {
      const tool = byName.get(name)!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: false });
      expect(tool.description).toMatch(/^AgentDash: /);
      expect(tool.outputSchema).toBeTruthy();
    }
    // Spec §7.2: confirm is the destructive-hinted call — the client's own
    // confirm affordance sits on top of ours.
    expect(byName.get("confirm_action")!.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.get("prepare_decision")!.annotations).toMatchObject({ destructiveHint: false });
    expect(byName.get("request_hire")!.annotations).toMatchObject({ destructiveHint: false });
  });
});

describe("prepare_decision", () => {
  it("POSTs the resolved approval id, decision and note; returns the read-back and handle", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "POST" && call.path.endsWith("/actions/prepare-decision")) {
        return {
          ok: true,
          readBack: "Approve Priya's request to hire a new agent.",
          handle: "aah_abc",
          expiresAt: "2026-09-26T12:00:00Z",
          effects: ["The hire is approved and the new agent is created."],
          approval: { id: APPROVAL_ID, type: "hire_agent", revision: 3 },
        };
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(
      await call("prepare_decision", { approval: APPROVAL_ID, decision: "approve", note: "go ahead" }),
    );

    expect(result.status).toBe("ok");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/companies/company-1/assistant/actions/prepare-decision");
    expect(post.body).toEqual({ approvalId: APPROVAL_ID, decision: "approve", note: "go ahead" });
    expect(result.data?.handle).toBe("aah_abc");
    expect(result.data?.pendingConfirmation).toBe(true);
    expect(result.summary).toContain("Approve Priya's request");
    expect(result.summary).toContain("Say yes to confirm");
  });

  it("resolves a description against the pending-decisions list", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "POST") {
        return { ok: true, readBack: "Approve Priya's request to hire a new agent.", handle: "aah_x", expiresAt: "", effects: [] };
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("prepare_decision", { approval: "hire a new agent", decision: "reject" }));
    expect(result.status).toBe("ok");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ approvalId: APPROVAL_ID, decision: "reject" });
  });

  it("an ambiguous description returns candidates and writes nothing", async () => {
    const { client, calls } = seededClient();
    const { call } = makeTools(client);
    const result = structured(await call("prepare_decision", { approval: "asks to", decision: "approve" }));
    expect(result.status).toBe("needs_clarification");
    expect(result.candidates).toHaveLength(2);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("an unmatchable description is not_found and writes nothing", async () => {
    const { client, calls } = seededClient();
    const { call } = makeTools(client);
    const result = structured(await call("prepare_decision", { approval: "nothing like this", decision: "approve" }));
    expect(result.status).toBe("not_found");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("a server refusal relays the reason verbatim", async () => {
    const { client } = seededClient((call) => {
      if (call.method === "POST") {
        return new PaperclipApiError({
          status: 409,
          method: "POST",
          path: call.path,
          body: { ok: false, code: "approval_already_decided", reason: "That request was already approved — nothing is waiting on you." },
          message: "POST failed with 409",
        });
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("prepare_decision", { approval: APPROVAL_ID, decision: "approve" }));
    expect(result.status).toBe("refused");
    expect(result.summary).toContain("already approved");
  });
});

describe("request_hire", () => {
  it("POSTs role/reason/name/projectId and returns the read-back", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "GET" && call.path === "/companies/company-1/projects") {
        return [{ id: "project-1", companyId: "company-1", name: "Checkout", status: "active" }];
      }
      if (call.method === "POST" && call.path.endsWith("/actions/prepare-hire")) {
        return {
          ok: true,
          readBack: "Hire Quinn as qa: \"release gate needs coverage\".",
          handle: "aah_hire",
          expiresAt: "2026-09-26T12:00:00Z",
          wouldNeedApproval: false,
          effects: [],
          hire: { name: "Quinn", role: "Qa", adapterType: "hermes_local" },
        };
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(
      await call("request_hire", { role: "qa", reason: "release gate needs coverage", nameHint: "Quinn", project: "Checkout" }),
    );
    expect(result.status).toBe("ok");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/companies/company-1/assistant/actions/prepare-hire");
    expect(post.body).toEqual({
      role: "qa",
      reason: "release gate needs coverage",
      name: "Quinn",
      projectId: "project-1",
    });
    expect(result.data?.handle).toBe("aah_hire");
    expect(result.data?.wouldNeedApproval).toBe(false);
  });

  it("an unresolvable project is not_found and writes nothing", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "GET" && call.path === "/companies/company-1/projects") return [];
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("request_hire", { role: "qa", reason: "coverage", project: "Nope" }));
    expect(result.status).toBe("not_found");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
});

describe("confirm_action", () => {
  it("POSTs the handle and personSaid; returns the outcome and links", async () => {
    const { client, calls } = seededClient((call) => {
      if (call.method === "POST" && call.path.endsWith("/actions/confirm")) {
        return {
          ok: true,
          kind: "approval_decision",
          approvalId: APPROVAL_ID,
          outcome: "Approved — the request went through.",
          links: { approval: `https://dash.example.test/approvals/${APPROVAL_ID}` },
        };
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(
      await call("confirm_action", { handle: "aah_abc", personSaid: "yes, approve it" }),
    );
    expect(result.status).toBe("ok");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ handle: "aah_abc", personSaid: "yes, approve it" });
    expect(result.summary).toContain("Approved");
    expect(result.links?.approval).toContain(APPROVAL_ID);
  });

  it("a spent or expired handle relays the server's refusal", async () => {
    const { client } = seededClient((call) => {
      if (call.method === "POST") {
        return new PaperclipApiError({
          status: 409,
          method: "POST",
          path: call.path,
          body: { ok: false, code: "handle_consumed", reason: "That confirmation was already used — nothing happened twice." },
          message: "POST failed with 409",
        });
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("confirm_action", { handle: "aah_spent" }));
    expect(result.status).toBe("refused");
    expect(result.summary).toContain("already used");
  });

  it("insufficient_scope names the decide scope", async () => {
    const { client } = seededClient((call) => {
      if (call.method === "POST") {
        return new PaperclipApiError({
          status: 403,
          method: "POST",
          path: call.path,
          body: { error: "insufficient_scope", required_scope: "agentdash:decide" },
          message: "POST failed with 403",
        });
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("confirm_action", { handle: "aah_abc" }));
    expect(result.status).toBe("refused");
    expect(result.summary).toContain("agentdash:decide");
  });

  it("an unmapped upstream error collapses to a generic refusal — no internals leak", async () => {
    const { client } = seededClient((call) => {
      if (call.method === "POST") {
        return new PaperclipApiError({
          status: 500,
          method: "POST",
          path: "/companies/company-1/assistant/actions/confirm/550e8400",
          body: { error: "relation `secret_table` does not exist" },
          message: "POST failed with 500",
        });
      }
      return undefined;
    });
    const { call } = makeTools(client);
    const result = structured(await call("confirm_action", { handle: "aah_abc" }));
    expect(result.status).toBe("refused");
    expect(result.summary).not.toContain("550e8400");
    expect(result.summary).not.toContain("secret_table");
  });
});
