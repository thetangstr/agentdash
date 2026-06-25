import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { agentDashNativeAdapter } from "./index.js";

// Integration test for execute(): stubs the global fetch so the gateway loop and
// the REST tools are both exercised through the real adapter wiring, and env so
// resolveGatewayAccess() succeeds.

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "ERR",
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeContext(over: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "Tara", adapterType: "agentdash_native", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { model: "gpt-4o-mini" },
    context: { paperclipIssue: { id: "iss-1", title: "Reconcile invoices" }, paperclipWake: { kind: "issue_assigned" } },
    onLog: async () => {},
    authToken: "jwt-abc",
    ...over,
  };
}

describe("agentDashNativeAdapter.execute (integration)", () => {
  beforeEach(() => {
    process.env.AGENTDASH_GATEWAY_BASE_URL = "https://gw.test/v1";
    process.env.AGENTDASH_GATEWAY_API_KEY = "sk-test";
  });
  afterEach(() => {
    delete process.env.AGENTDASH_GATEWAY_BASE_URL;
    delete process.env.AGENTDASH_GATEWAY_API_KEY;
    vi.unstubAllGlobals();
  });

  it("runs the loop, executes a tool via REST, and maps to a metered success result", async () => {
    const apiCalls: string[] = [];
    let gatewayTurn = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/chat/completions")) {
        gatewayTurn++;
        if (gatewayTurn === 1) {
          return jsonResponse({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: "c1", type: "function", function: { name: "add_comment", arguments: JSON.stringify({ body: "Reconciled." }) } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 40 },
          });
        }
        return jsonResponse({
          choices: [{ message: { content: "Done — invoices reconciled and commented." } }],
          usage: { prompt_tokens: 60, completion_tokens: 20 },
        });
      }
      // REST tool call
      apiCalls.push(`${init?.method ?? "GET"} ${url}`);
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentDashNativeAdapter.execute(makeContext());

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.billingType).toBe("metered_api");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.usage).toEqual({ inputTokens: 160, outputTokens: 60, cachedInputTokens: 0 });
    // gpt-4o-mini: 160/1e6*0.15 + 60/1e6*0.6
    expect(result.costUsd).toBeCloseTo((160 / 1e6) * 0.15 + (60 / 1e6) * 0.6, 9);
    expect(result.summary).toContain("reconciled");
    // the add_comment tool hit the REST API for the current issue
    expect(apiCalls.some((c) => c.startsWith("POST") && c.includes("/api/issues/iss-1/comments"))).toBe(true);
  });

  it("fails cleanly with gateway_not_configured when the gateway env is absent", async () => {
    delete process.env.AGENTDASH_GATEWAY_BASE_URL;
    delete process.env.AGENTDASH_GATEWAY_API_KEY;
    const result = await agentDashNativeAdapter.execute(makeContext());
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("gateway_not_configured");
  });

  it("testEnvironment passes when the gateway is configured", async () => {
    const res = await agentDashNativeAdapter.testEnvironment({ companyId: "co-1", adapterType: "agentdash_native", config: {} });
    expect(res.status).toBe("pass");
  });
});
