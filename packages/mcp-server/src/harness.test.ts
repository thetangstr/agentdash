import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { harnessTools } from "./harness.js";

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: null,
  });
}

function getTool(name: string) {
  const tool = harnessTools(makeClient()).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * AgentDash-MK Slice 1 — the local harness's three verbs: push the soul, narrow
 * the ceiling, read back what actually applies after intersection.
 */
describe("harness control tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("pushes directives to the paired agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ directive: { version: 2 } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await getTool("agentdashPushAgentDirectives").execute({
      directives: "Never email a client without asking.",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/agents/22222222-2222-2222-2222-222222222222/directives",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      directives: "Never email a client without asking.",
    });
    expect(response.content[0]?.text).toContain("version");
  });

  it("narrows the steward request through the clamping harness route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ policy: {}, clamped: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("agentdashNarrowAgentCeilings").execute({
      providers: ["hubspot"],
      dataScopes: ["crm.contacts.read"],
      permissions: ["*"],
      monthlyBudgetCents: 50_000,
      destructiveActions: "blocked",
      minimumApproval: "steward",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/agents/22222222-2222-2222-2222-222222222222/governance/harness-request",
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      policy: {
        permissions: ["*"],
        monthlyBudgetCents: 50_000,
        destructiveActions: "blocked",
        dataScopes: ["crm.contacts.read"],
        providers: ["hubspot"],
        minimumApproval: "steward",
      },
    });
  });

  it("reads back the effective policy so a human can see what survived the intersection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        policy: {
          ownerCeiling: { providers: ["hubspot"] },
          stewardRequest: { providers: ["hubspot"] },
          effectivePolicy: { providers: ["hubspot"] },
          revision: 3,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await getTool("agentdashGetAgentPolicy").execute({});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/agents/22222222-2222-2222-2222-222222222222/governance",
    );
    expect(init.method).toBe("GET");
    expect(response.content[0]?.text).toContain("effectivePolicy");
  });

  it("reads the directive history with its provenance", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ active: null, history: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("agentdashGetAgentDirectives").execute({});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/directives");
    expect(init.method).toBe("GET");
  });
});
