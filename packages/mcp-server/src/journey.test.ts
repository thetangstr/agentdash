import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import {
  INSTALL_STEPS,
  computeNextAction,
  createJourneyToolDefinitions,
  findLatestPlanMessage,
  type SetupStatusSnapshot,
} from "./journey.js";

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const RUN_ID = "33333333-3333-3333-3333-333333333333";
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";
const APPROVAL_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_AGENT_ID = "88888888-8888-4888-8888-888888888888";

function makeClient(overrides: Partial<ConstructorParameters<typeof PaperclipApiClient>[0]> = {}) {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    ...overrides,
  });
}

function getTool(name: string, client = makeClient()) {
  const tool = createJourneyToolDefinitions(client).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseText(response: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
}

/** Route mocked fetch calls by URL suffix so call ordering doesn't matter. */
function routeFetch(routes: Array<[matcher: RegExp, body: unknown, status?: number]>) {
  const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
    const href = String(url);
    for (const [matcher, body, status] of routes) {
      if (matcher.test(href)) return Promise.resolve(mockJsonResponse(body, status ?? 200));
    }
    return Promise.resolve(mockJsonResponse({ error: `no route for ${href}` }, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// computeNextAction — exhaustive table over all phases
// ---------------------------------------------------------------------------

describe("computeNextAction", () => {
  const base: SetupStatusSnapshot = {
    serverHealthy: true,
    bootstrapStatus: null,
    adapterReady: true,
    apiKeyConfigured: true,
    companyId: COMPANY_ID,
    agentCount: 1,
    nonCosAgentCount: 0,
    pausedAgentCount: 0,
    planReady: false,
    pendingApprovals: 0,
    openTasks: 0,
  };

  const cases: Array<[name: string, input: SetupStatusSnapshot, phase: string, action: string]> = [
    [
      "server unreachable → install checklist",
      { ...base, serverHealthy: false },
      "install",
      "agentdash_install_checklist",
    ],
    [
      "server unreachable trumps everything else",
      { ...base, serverHealthy: false, companyId: null, agentCount: 0 },
      "install",
      "agentdash_install_checklist",
    ],
    [
      "server unreachable trumps sign_up too",
      {
        ...base,
        serverHealthy: false,
        bootstrapStatus: "bootstrap_pending",
        apiKeyConfigured: false,
        companyId: null,
        agentCount: 0,
      },
      "install",
      "agentdash_install_checklist",
    ],
    [
      "fresh authenticated install (bootstrap_pending) + no API key → sign up",
      {
        ...base,
        bootstrapStatus: "bootstrap_pending",
        apiKeyConfigured: false,
        companyId: null,
        agentCount: 0,
      },
      "sign_up",
      "agentdash_sign_up",
    ],
    [
      "bootstrap_pending but a key is already configured → normal bootstrap",
      { ...base, bootstrapStatus: "bootstrap_pending", companyId: null, agentCount: 0 },
      "bootstrap",
      "agentdash_start_interview",
    ],
    [
      "signed up but adapter not configured → setup_adapter",
      { ...base, adapterReady: false, companyId: null, agentCount: 0 },
      "setup_adapter",
      "agentdash_setup_adapter",
    ],
    [
      "adapter not ready trumps company/agent bootstrap",
      { ...base, adapterReady: false },
      "setup_adapter",
      "agentdash_setup_adapter",
    ],
    [
      "adapter not ready trumps an existing plan card",
      { ...base, adapterReady: false, planReady: true },
      "setup_adapter",
      "agentdash_setup_adapter",
    ],
    [
      "no API key but the instance is already claimed (ready) → not sign_up",
      { ...base, bootstrapStatus: "ready", apiKeyConfigured: false, companyId: null, agentCount: 0 },
      "bootstrap",
      "agentdash_start_interview",
    ],
    [
      "healthy + no company → start interview",
      { ...base, companyId: null, agentCount: 0 },
      "bootstrap",
      "agentdash_start_interview",
    ],
    [
      "healthy + company but zero agents → start interview (re-bootstrap)",
      { ...base, agentCount: 0 },
      "bootstrap",
      "agentdash_start_interview",
    ],
    [
      "company + CoS only + no plan → interview turn",
      { ...base },
      "interview",
      "agentdash_interview_turn",
    ],
    [
      "plan ready but unconfirmed → confirm plan",
      { ...base, planReady: true },
      "plan_review",
      "agentdash_confirm_plan",
    ],
    [
      "team exists but all agents paused → resume via approval",
      { ...base, agentCount: 3, nonCosAgentCount: 2, pausedAgentCount: 3 },
      "paused",
      "agentdash_request_approval",
    ],
    [
      "team exists, some running → operate",
      { ...base, agentCount: 3, nonCosAgentCount: 2, pausedAgentCount: 1 },
      "operate",
      "agentdash_list_tasks / agentdash_create_task",
    ],
    [
      "team exists, none paused → operate",
      { ...base, agentCount: 3, nonCosAgentCount: 2 },
      "operate",
      "agentdash_list_tasks / agentdash_create_task",
    ],
    [
      "operate is unaffected by pending approvals and open tasks",
      { ...base, agentCount: 4, nonCosAgentCount: 3, pendingApprovals: 2, openTasks: 9 },
      "operate",
      "agentdash_list_tasks / agentdash_create_task",
    ],
    [
      "planReady is ignored once the team is materialized",
      { ...base, agentCount: 3, nonCosAgentCount: 2, planReady: true },
      "operate",
      "agentdash_list_tasks / agentdash_create_task",
    ],
  ];

  it.each(cases)("%s", (_name, input, phase, action) => {
    const result = computeNextAction(input);
    expect(result.phase).toBe(phase);
    expect(result.nextAction).toBe(action);
    expect(result.nextActionReason.length).toBeGreaterThan(0);
  });

  it("sign-up reason forbids inventing an email", () => {
    const result = computeNextAction({
      ...base,
      bootstrapStatus: "bootstrap_pending",
      apiKeyConfigured: false,
      companyId: null,
      agentCount: 0,
    });
    expect(result.nextActionReason).toMatch(/NEVER invent an email/i);
  });

  it("confirm-plan reason mentions the human-approval gate", () => {
    const result = computeNextAction({ ...base, planReady: true });
    expect(result.nextActionReason).toMatch(/human approval/i);
  });

  it("operate reason tells the agent to re-check status after each action", () => {
    const result = computeNextAction({ ...base, agentCount: 2, nonCosAgentCount: 1 });
    expect(result.nextActionReason).toMatch(/re-check/i);
  });
});

// ---------------------------------------------------------------------------
// findLatestPlanMessage
// ---------------------------------------------------------------------------

describe("findLatestPlanMessage", () => {
  it("returns null when no plan card exists", () => {
    expect(findLatestPlanMessage([{ cardKind: null }, { body: "hi" }])).toBeNull();
    expect(findLatestPlanMessage(undefined)).toBeNull();
  });

  it("picks the newest agent_plan_proposal_v1 card by createdAt", () => {
    const messages = [
      { id: "m1", cardKind: "agent_plan_proposal_v1", createdAt: "2026-07-01T00:00:00Z" },
      { id: "m2", cardKind: "proposal_card_v1", createdAt: "2026-07-03T00:00:00Z" },
      { id: "m3", cardKind: "agent_plan_proposal_v1", createdAt: "2026-07-02T00:00:00Z" },
    ];
    expect(findLatestPlanMessage(messages)?.id).toBe("m3");
  });
});

// ---------------------------------------------------------------------------
// agentdash_setup_status — aggregation endpoint contracts
// ---------------------------------------------------------------------------

describe("agentdash_setup_status", () => {
  it("returns install phase when /health is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await getTool("agentdash_setup_status").execute({});
    const result = parseText(response);

    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:3100/api/health");
    expect(result.phase).toBe("install");
    expect(result.serverHealthy).toBe(false);
    expect(result.nextAction).toBe("agentdash_install_checklist");
  });

  it("aggregates health + agents + dashboard + pending approvals for operate", async () => {
    const fetchMock = routeFetch([
      [/\/api\/health$/, { status: "ok", adapterReady: true }],
      [/\/companies\/[^/]+\/agents$/, [
        { id: AGENT_ID, role: "chief_of_staff", status: "idle" },
        { id: OTHER_AGENT_ID, role: "general", status: "paused" },
      ]],
      [/\/companies\/[^/]+\/dashboard$/, {
        pendingApprovals: 1,
        taskCounts: { open: 4, inProgress: 1, blocked: 0, done: 2 },
      }],
      [/\/companies\/[^/]+\/approvals\?status=pending$/, [{ id: APPROVAL_ID }]],
    ]);

    const response = await getTool("agentdash_setup_status").execute({});
    const result = parseText(response);

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).toContain("http://localhost:3100/api/health");
    expect(calledUrls).toContain(`http://localhost:3100/api/companies/${COMPANY_ID}/agents`);
    expect(calledUrls).toContain(`http://localhost:3100/api/companies/${COMPANY_ID}/dashboard`);
    expect(calledUrls).toContain(
      `http://localhost:3100/api/companies/${COMPANY_ID}/approvals?status=pending`,
    );
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");
    }

    expect(result).toMatchObject({
      phase: "operate",
      serverHealthy: true,
      companyId: COMPANY_ID,
      agentCount: 2,
      runningAgents: 1,
      pendingApprovals: 1,
      openTasks: 4,
    });
  });

  it("discovers the company via GET /companies when none is configured", async () => {
    const client = makeClient({ companyId: null });
    const fetchMock = routeFetch([
      [/\/api\/health$/, { status: "ok", adapterReady: true }],
      [/\/api\/companies$/, [{ id: COMPANY_ID }]],
      [/\/companies\/[^/]+\/agents$/, []],
      [/\/companies\/[^/]+\/dashboard$/, { pendingApprovals: 0, taskCounts: { open: 0 } }],
      [/\/approvals\?status=pending$/, []],
    ]);

    const response = await getTool("agentdash_setup_status", client).execute({});
    const result = parseText(response);

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      "http://localhost:3100/api/companies",
    );
    expect(result.companyId).toBe(COMPANY_ID);
    expect(result.phase).toBe("bootstrap");
    expect(result.nextAction).toBe("agentdash_start_interview");
  });

  it("reports bootstrap phase when healthy and no company exists", async () => {
    const client = makeClient({ companyId: null });
    routeFetch([
      [/\/api\/health$/, { status: "ok", adapterReady: true }],
      [/\/api\/companies$/, []],
    ]);

    const result = parseText(await getTool("agentdash_setup_status", client).execute({}));
    expect(result.phase).toBe("bootstrap");
    expect(result.companyId).toBeNull();
  });

  it("checks the inbox conversation for a plan card while the team is unmaterialized", async () => {
    const fetchMock = routeFetch([
      [/\/api\/health$/, { status: "ok", adapterReady: true }],
      [/\/companies\/[^/]+\/agents$/, [{ id: AGENT_ID, role: "chief_of_staff", status: "idle" }]],
      [/\/companies\/[^/]+\/dashboard$/, { pendingApprovals: 0, taskCounts: { open: 0 } }],
      [/\/approvals\?status=pending$/, []],
      [/\/conversations\/companies\/[^/]+\/inbox$/, { id: CONVERSATION_ID }],
      [/\/conversations\/[^/]+\/messages\?limit=200$/, [
        { id: "m1", cardKind: "agent_plan_proposal_v1", cardPayload: { agents: [] } },
      ]],
    ]);

    const result = parseText(await getTool("agentdash_setup_status").execute({}));

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).toContain(
      `http://localhost:3100/api/conversations/companies/${COMPANY_ID}/inbox`,
    );
    expect(calledUrls).toContain(
      `http://localhost:3100/api/conversations/${CONVERSATION_ID}/messages?limit=200`,
    );
    expect(result.phase).toBe("plan_review");
    expect(result.nextAction).toBe("agentdash_confirm_plan");
  });

  it("reports interview phase when the CoS exists but no plan card yet", async () => {
    routeFetch([
      [/\/api\/health$/, { status: "ok", adapterReady: true }],
      [/\/companies\/[^/]+\/agents$/, [{ id: AGENT_ID, role: "chief_of_staff", status: "idle" }]],
      [/\/companies\/[^/]+\/dashboard$/, { pendingApprovals: 0, taskCounts: { open: 0 } }],
      [/\/approvals\?status=pending$/, []],
      [/\/conversations\/companies\/[^/]+\/inbox$/, { id: CONVERSATION_ID }],
      [/\/conversations\/[^/]+\/messages\?limit=200$/, [{ id: "m1", body: "welcome" }]],
    ]);

    const result = parseText(await getTool("agentdash_setup_status").execute({}));
    expect(result.phase).toBe("interview");
    expect(result.nextAction).toBe("agentdash_interview_turn");
  });

  // AgentDash (MCP-native signup): setup_status must work UNAUTHENTICATED —
  // /health is public, and with no key configured the authed sub-fetches are
  // skipped entirely (they would only 401 on an authenticated server).
  it("works without an API key: only /health is fetched, no Authorization header, routes to sign_up", async () => {
    const client = makeClient({ apiKey: "", companyId: null });
    const fetchMock = routeFetch([
      [/\/api\/health$/, { status: "ok", deploymentMode: "authenticated", bootstrapStatus: "bootstrap_pending", adapterReady: true }],
    ]);

    const result = parseText(await getTool("agentdash_setup_status", client).execute({}));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:3100/api/health");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();

    expect(result.phase).toBe("sign_up");
    expect(result.nextAction).toBe("agentdash_sign_up");
    expect(result.serverHealthy).toBe(true);
    expect(result.bootstrapStatus).toBe("bootstrap_pending");
    expect(result.apiKeyConfigured).toBe(false);
  });

  it("without an API key on a claimed instance (ready), skips authed fetches and reports bootstrap", async () => {
    const client = makeClient({ apiKey: "", companyId: null });
    const fetchMock = routeFetch([
      [/\/api\/health$/, { status: "ok", bootstrapStatus: "ready", adapterReady: true }],
    ]);

    const result = parseText(await getTool("agentdash_setup_status", client).execute({}));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.phase).toBe("bootstrap");
    expect(result.apiKeyConfigured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agentdash_install_checklist
// ---------------------------------------------------------------------------

describe("agentdash_install_checklist", () => {
  it("never touches the network and returns structured steps", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("agentdash_install_checklist");
    const result = parseText(await tool.execute({}));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tool.description).toContain("NEVER executes anything");
    expect(result.notice).toContain("NEVER executes anything");
    expect(result.steps).toEqual(INSTALL_STEPS);
    for (const step of result.steps as Array<Record<string, unknown>>) {
      expect(Object.keys(step).sort()).toEqual(["expect", "id", "run", "verify"]);
    }
    const stepIds = (result.steps as Array<{ id: string }>).map((step) => step.id);
    expect(stepIds).toContain("clone");
    expect(stepIds).toContain("health-check");
  });
});

// ---------------------------------------------------------------------------
// agentdash_sign_up — founding-user signup endpoint contract
// ---------------------------------------------------------------------------

describe("agentdash_sign_up", () => {
  const SIGNUP_RESPONSE = {
    userId: "99999999-9999-4999-8999-999999999999",
    email: "founder@example.com",
    name: "Founder",
    apiKey: "pcp_board_deadbeef",
    apiKeyExpiresAt: "2026-08-24T00:00:00.000Z",
    passwordSetup:
      "Use 'Forgot password' on the web UI with this email to set a browser password later.",
  };

  it("POSTs to /onboarding/mcp-signup WITHOUT an Authorization header when no key is configured", async () => {
    const client = makeClient({ apiKey: "" });
    const fetchMock = routeFetch([[/\/onboarding\/mcp-signup$/, SIGNUP_RESPONSE]]);

    const result = parseText(
      await getTool("agentdash_sign_up", client).execute({
        email: "founder@example.com",
        name: "Founder",
      }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/onboarding/mcp-signup");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({
      email: "founder@example.com",
      name: "Founder",
    });

    expect(result.userId).toBe(SIGNUP_RESPONSE.userId);
    expect(result.apiKey).toBe(SIGNUP_RESPONSE.apiKey);
    expect(String(result.apiKeyPersistInstructions)).toContain(
      `PAPERCLIP_API_KEY=${SIGNUP_RESPONSE.apiKey}`,
    );
    expect(result.passwordSetup).toBe(SIGNUP_RESPONSE.passwordSetup);
  });

  it("upgrades the SAME session: subsequent calls carry the minted key as Bearer", async () => {
    const client = makeClient({ apiKey: "" });
    expect(client.hasApiKey).toBe(false);
    routeFetch([[/\/onboarding\/mcp-signup$/, SIGNUP_RESPONSE]]);

    await getTool("agentdash_sign_up", client).execute({
      email: "founder@example.com",
      name: "Founder",
    });
    expect(client.hasApiKey).toBe(true);

    // Next call on the same client now authenticates with the new key.
    const fetchMock = routeFetch([[/./, []]]);
    await getTool("agentdash_list_agents", client).execute({});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${SIGNUP_RESPONSE.apiKey}`,
    );
  });

  it("is documented as founding-only, no-password, and never inventing an email", () => {
    const tool = getTool("agentdash_sign_up");
    expect(tool.description).toMatch(/fresh/i);
    expect(tool.description).toMatch(/no password/i);
    expect(tool.description).toMatch(/NEVER invent an email/i);
  });

  it("surfaces the server's gate errors (e.g. 409 instance_already_claimed) instead of swallowing them", async () => {
    routeFetch([[/\/onboarding\/mcp-signup$/, { code: "instance_already_claimed", error: "This instance already has a user." }, 409]]);

    const response = await getTool("agentdash_sign_up").execute({
      email: "founder@example.com",
      name: "Founder",
    });
    expect(response.content[0]!.text).toMatch(/409/);
  });
});

// ---------------------------------------------------------------------------
// agentdash_start_interview
// ---------------------------------------------------------------------------

describe("agentdash_start_interview", () => {
  it("bootstraps then PATCHes requireBoardApprovalForNewAgents=true", async () => {
    const fetchMock = routeFetch([
      [/\/onboarding\/bootstrap$/, {
        companyId: COMPANY_ID,
        cosAgentId: AGENT_ID,
        conversationId: CONVERSATION_ID,
      }],
      [new RegExp(`/companies/${COMPANY_ID}$`), { id: COMPANY_ID, requireBoardApprovalForNewAgents: true }],
    ]);

    const result = parseText(await getTool("agentdash_start_interview").execute({}));

    const [bootstrapUrl, bootstrapInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(bootstrapUrl)).toBe("http://localhost:3100/api/onboarding/bootstrap");
    expect(bootstrapInit.method).toBe("POST");
    expect((bootstrapInit.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");
    expect(JSON.parse(String(bootstrapInit.body))).toEqual({});

    const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(patchUrl)).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}`);
    expect(patchInit.method).toBe("PATCH");
    expect(JSON.parse(String(patchInit.body))).toEqual({ requireBoardApprovalForNewAgents: true });

    expect(result).toEqual({
      companyId: COMPANY_ID,
      conversationId: CONVERSATION_ID,
      cosAgentId: AGENT_ID,
      boundaries: { hiresRequireApproval: true },
    });
  });

  it("surfaces a REQUIRED manual step when the boundary PATCH fails", async () => {
    routeFetch([
      [/\/onboarding\/bootstrap$/, {
        companyId: COMPANY_ID,
        cosAgentId: AGENT_ID,
        conversationId: CONVERSATION_ID,
      }],
      [new RegExp(`/companies/${COMPANY_ID}$`), { error: "Forbidden" }, 403],
    ]);

    const result = parseText(await getTool("agentdash_start_interview").execute({}));

    expect(result.companyId).toBe(COMPANY_ID);
    expect(result.boundaries).toEqual({ hiresRequireApproval: true });
    expect(String(result.requiredManualStep)).toMatch(/^REQUIRED:/);
    expect(String(result.requiredManualStep)).toContain("requireBoardApprovalForNewAgents");
  });
});

// ---------------------------------------------------------------------------
// Interview / plan tools — endpoint contracts
// ---------------------------------------------------------------------------

describe("interview and plan tools", () => {
  it("agentdash_interview_turn POSTs to /onboarding/interview/turn", async () => {
    const fetchMock = routeFetch([[/./, { assistantMessage: "Next question?", state: {} }]]);

    await getTool("agentdash_interview_turn").execute({
      conversationId: CONVERSATION_ID,
      userMessage: "We are a B2B SaaS",
      cosAgentId: AGENT_ID,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/onboarding/interview/turn");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");
    expect(JSON.parse(String(init.body))).toEqual({
      conversationId: CONVERSATION_ID,
      userMessage: "We are a B2B SaaS",
      cosAgentId: AGENT_ID,
      companyId: COMPANY_ID,
    });
  });

  it("agentdash_get_plan filters for the latest agent_plan_proposal_v1 card", async () => {
    const fetchMock = routeFetch([
      [/\/messages\?limit=200$/, [
        { id: "m1", body: "welcome", cardKind: null, createdAt: "2026-07-01T00:00:00Z" },
        {
          id: "m2",
          cardKind: "agent_plan_proposal_v1",
          cardPayload: { agents: [{ name: "Old" }] },
          createdAt: "2026-07-02T00:00:00Z",
        },
        {
          id: "m3",
          cardKind: "agent_plan_proposal_v1",
          cardPayload: { agents: [{ name: "Newer", role: "Support" }] },
          createdAt: "2026-07-03T00:00:00Z",
        },
      ]],
    ]);

    const result = parseText(
      await getTool("agentdash_get_plan").execute({ conversationId: CONVERSATION_ID }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      `http://localhost:3100/api/conversations/${CONVERSATION_ID}/messages?limit=200`,
    );
    expect(init.method).toBe("GET");
    expect(result.planFound).toBe(true);
    expect(result.messageId).toBe("m3");
    expect(result.plan).toEqual({ agents: [{ name: "Newer", role: "Support" }] });
  });

  it("agentdash_get_plan reports planFound=false when no card exists", async () => {
    routeFetch([[/\/messages\?limit=200$/, [{ id: "m1", body: "hello" }]]]);

    const result = parseText(
      await getTool("agentdash_get_plan").execute({ conversationId: CONVERSATION_ID }),
    );
    expect(result.planFound).toBe(false);
    expect(String(result.hint)).toContain("agentdash_interview_turn");
  });

  it("agentdash_confirm_plan POSTs to /onboarding/confirm-plan", async () => {
    const fetchMock = routeFetch([[/./, { companyId: COMPANY_ID, createdAgentIds: ["a", "b"] }]]);

    await getTool("agentdash_confirm_plan").execute({ conversationId: CONVERSATION_ID });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/onboarding/confirm-plan");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ conversationId: CONVERSATION_ID });
  });

  it("agentdash_revise_plan POSTs to /onboarding/revise-plan", async () => {
    const fetchMock = routeFetch([[/./, { ok: true }]]);

    await getTool("agentdash_revise_plan").execute({
      conversationId: CONVERSATION_ID,
      revisionText: "Drop the QA agent, add marketing",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/onboarding/revise-plan");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      conversationId: CONVERSATION_ID,
      revisionText: "Drop the QA agent, add marketing",
    });
  });
});

// ---------------------------------------------------------------------------
// Approval gate — request → pending → check → approved roundtrip
// ---------------------------------------------------------------------------

describe("approval gate", () => {
  it("agentdash_request_approval POSTs a request_board_approval with the mcp payload", async () => {
    const fetchMock = routeFetch([[/./, { id: APPROVAL_ID, status: "pending" }]]);

    const result = parseText(
      await getTool("agentdash_request_approval").execute({
        summary: "Hire an extra research agent",
        proposedAction: "agentdashHireAgent name=Scout adapterType=claude_code",
        details: "Beyond the confirmed plan of 2 agents",
      }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/approvals`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "request_board_approval",
      requestedByAgentId: AGENT_ID,
      payload: {
        summary: "Hire an extra research agent",
        proposedAction: "agentdashHireAgent name=Scout adapterType=claude_code",
        details: "Beyond the confirmed plan of 2 agents",
        requestedVia: "mcp",
      },
    });

    expect(result).toEqual({
      approvalId: APPROVAL_ID,
      status: "pending",
      approveUrl: `http://localhost:3100/approvals/${APPROVAL_ID}`,
    });
  });

  it("omits requestedByAgentId when no agent id is configured and links issueIds", async () => {
    const client = makeClient({ agentId: null });
    const fetchMock = routeFetch([[/./, { id: APPROVAL_ID, status: "pending" }]]);

    await getTool("agentdash_request_approval", client).execute({
      summary: "Pause the fleet",
      proposedAction: "pause all agents",
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      type: "request_board_approval",
      payload: {
        summary: "Pause the fleet",
        proposedAction: "pause all agents",
        requestedVia: "mcp",
      },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });
  });

  it("agentdash_check_approval GETs the approval and reports approved=true only when approved", async () => {
    const fetchMock = routeFetch([
      [/\/approvals\/[^/]+$/, { id: APPROVAL_ID, status: "approved", decisionNote: "Go ahead" }],
    ]);

    const result = parseText(
      await getTool("agentdash_check_approval").execute({ approvalId: APPROVAL_ID }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`http://localhost:3100/api/approvals/${APPROVAL_ID}`);
    expect(init.method).toBe("GET");
    expect(result).toEqual({
      approvalId: APPROVAL_ID,
      status: "approved",
      decisionNote: "Go ahead",
      approved: true,
    });
  });

  it("full roundtrip: request → pending poll → approved poll", async () => {
    // 1) Request the approval.
    routeFetch([[/\/approvals$/, { id: APPROVAL_ID, status: "pending" }]]);
    const requested = parseText(
      await getTool("agentdash_request_approval").execute({
        summary: "Resume fleet",
        proposedAction: "resume all agents",
      }),
    );
    expect(requested.status).toBe("pending");
    expect(requested.approveUrl).toBe(`http://localhost:3100/approvals/${APPROVAL_ID}`);

    // 2) First poll: still pending → do not proceed.
    routeFetch([[/\/approvals\/[^/]+$/, { id: APPROVAL_ID, status: "pending", decisionNote: null }]]);
    const pending = parseText(
      await getTool("agentdash_check_approval").execute({ approvalId: APPROVAL_ID }),
    );
    expect(pending.status).toBe("pending");
    expect(pending.approved).toBe(false);

    // 3) Second poll: approved → gated action may proceed.
    routeFetch([[/\/approvals\/[^/]+$/, { id: APPROVAL_ID, status: "approved", decisionNote: "ok" }]]);
    const approved = parseText(
      await getTool("agentdash_check_approval").execute({ approvalId: APPROVAL_ID }),
    );
    expect(approved.approved).toBe(true);
    expect(approved.decisionNote).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Operating tools — endpoint contracts
// ---------------------------------------------------------------------------

describe("operating tools", () => {
  it("agentdash_list_agents GETs company agents", async () => {
    const fetchMock = routeFetch([[/./, []]]);

    await getTool("agentdash_list_agents").execute({});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/agents`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");
  });

  it("agentdash_list_tasks GETs company issues with a status filter", async () => {
    const fetchMock = routeFetch([[/./, []]]);

    await getTool("agentdash_list_tasks").execute({ status: "in_progress" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      `http://localhost:3100/api/companies/${COMPANY_ID}/issues?status=in_progress`,
    );
    expect(init.method).toBe("GET");
  });

  it("agentdash_create_task POSTs a todo issue with defaults applied", async () => {
    const fetchMock = routeFetch([[/./, { id: "issue-1" }]]);

    await getTool("agentdash_create_task").execute({
      title: "Ship the launch post",
      assigneeAgentId: OTHER_AGENT_ID,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/issues`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "Ship the launch post",
      description: "",
      priority: "medium",
      status: "todo",
      assigneeAgentId: OTHER_AGENT_ID,
    });
  });

  it("agentdash_get_dashboard GETs the company dashboard", async () => {
    const fetchMock = routeFetch([[/./, { agentCounts: {} }]]);

    await getTool("agentdash_get_dashboard").execute({});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/dashboard`);
    expect(init.method).toBe("GET");
  });

  it("agentdash_pause_agent POSTs to /agents/:id/pause and warns about fleet pauses", async () => {
    const fetchMock = routeFetch([[/./, { id: OTHER_AGENT_ID, status: "paused" }]]);

    const tool = getTool("agentdash_pause_agent");
    await tool.execute({ agentId: OTHER_AGENT_ID });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`http://localhost:3100/api/agents/${OTHER_AGENT_ID}/pause`);
    expect(init.method).toBe("POST");
    expect(tool.description).toContain("agentdash_request_approval");
  });

  it("agentdash_resume_agent POSTs to /agents/:id/resume and is documented as gated", async () => {
    const fetchMock = routeFetch([[/./, { id: OTHER_AGENT_ID, status: "idle" }]]);

    const tool = getTool("agentdash_resume_agent");
    await tool.execute({ agentId: OTHER_AGENT_ID });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`http://localhost:3100/api/agents/${OTHER_AGENT_ID}/resume`);
    expect(init.method).toBe("POST");
    expect(tool.description).toContain("agentdash_request_approval");
    expect(tool.description).toMatch(/approved/i);
  });
});
