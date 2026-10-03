import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
const originalBillingDisabled = process.env.AGENTDASH_BILLING_DISABLED;

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  // GH #71 carry-forward: POST /companies/:companyId/agents now auto-creates a default API key.
  createApiKey: vi.fn().mockResolvedValue({
    id: "key-1",
    name: "default",
    token: "agk_test_token",
    createdAt: new Date("2026-05-02T00:00:00.000Z"),
  }),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
  invoke: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
  // Closes #327: routes/agents.ts also imports these from the barrel.
  agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
}

const externalAdapter: ServerAdapterModule = {
  type: "external_test",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "external_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
};

const failingPreflightAdapter: ServerAdapterModule = {
  type: "external_preflight_fail",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "external_preflight_fail",
    status: "fail",
    checks: [
      {
        code: "missing_token",
        level: "error",
        message: "Missing test token",
        hint: "Add a token before creating this agent.",
      },
    ],
    testedAt: new Date(0).toISOString(),
  }),
};

// The self-hosted Hermes shape from the canary: the only warning is that
// AgentDash's own env holds no LLM keys — they live in the Hermes profile.
const warningPreflightAdapter: ServerAdapterModule = {
  type: "external_preflight_warn",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "external_preflight_warn",
    status: "warn",
    checks: [
      {
        code: "no_llm_keys",
        level: "warn",
        message: "No LLM API keys in AgentDash env",
      },
    ],
    testedAt: new Date(0).toISOString(),
  }),
};

// A warn that means the adapter cannot run at all: the probe could not
// authenticate. Same status, different verdict — this one must 422.
const blockingWarnPreflightAdapter: ServerAdapterModule = {
  type: "external_preflight_warn_blocking",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "external_preflight_warn_blocking",
    status: "warn",
    checks: [
      {
        code: "claude_hello_probe_auth_required",
        level: "warn",
        message: "Claude CLI is installed, but login is required.",
      },
    ],
    testedAt: new Date(0).toISOString(),
  }),
};

const missingAdapterType = "missing_adapter_validation_test";

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents: false,
          },
        ]),
      })),
    })),
  };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../adapters/index.js");
  unregisterServerAdapter(type);
}

describe("agent routes adapter validation", () => {
  beforeEach(async () => {
    process.env.AGENTDASH_BILLING_DISABLED = "true";
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../routes/agents.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    // AgentDash (AGE-8): bundle-capable adapters (hermes_local included) go
    // through materializeDefaultInstructionsBundleForNewAgent on create; echo
    // the agent's config the way the real service's return contract does.
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: { adapterConfig?: unknown }) => ({
        bundle: {},
        adapterConfig: { ...((agent.adapterConfig ?? {}) as Record<string, unknown>) },
      }),
    );
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: String(input.name ?? "Agent"),
      urlKey: "agent",
      role: String(input.role ?? "general"),
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: String(input.adapterType ?? "process"),
      adapterConfig: (input.adapterConfig as Record<string, unknown> | undefined) ?? {},
      runtimeConfig: (input.runtimeConfig as Record<string, unknown> | undefined) ?? {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "External Agent",
      urlKey: "external-agent",
      role: "general",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "external_test",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: patch.metadata ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockHeartbeatService.invoke.mockResolvedValue({
      id: "run-1",
      agentId: "11111111-1111-4111-8111-111111111111",
      status: "queued",
    });
    await unregisterTestAdapter("external_test");
    await unregisterTestAdapter("external_preflight_fail");
    await unregisterTestAdapter("external_preflight_warn");
    await unregisterTestAdapter("external_preflight_warn_blocking");
    await unregisterTestAdapter(missingAdapterType);
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    await unregisterTestAdapter("external_test");
    await unregisterTestAdapter("external_preflight_fail");
    await unregisterTestAdapter("external_preflight_warn");
    await unregisterTestAdapter("external_preflight_warn_blocking");
    await unregisterTestAdapter(missingAdapterType);
    if (originalStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    if (originalBillingDisabled === undefined) delete process.env.AGENTDASH_BILLING_DISABLED;
    else process.env.AGENTDASH_BILLING_DISABLED = originalBillingDisabled;
  });

  it("creates agents for dynamically registered external adapter types", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "External Agent",
          adapterType: "external_test",
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapterType).toBe("external_test");
  });

  it("accepts type/config aliases when agents create local adapter workers", async () => {
    // hermes_local is bundle-capable (AGE-8), so creation now materializes the
    // default managed bundle and persists the merged adapterConfig via update().
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "Hermes Agent",
      urlKey: "hermes-agent",
      role: "general",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "hermes_local",
      adapterConfig: (patch.adapterConfig as Record<string, unknown> | undefined) ?? {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Hermes Agent",
          type: "hermes_local",
          config: {
            hermesCommand: "/Users/example/.local/bin/hermes",
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapterType).toBe("hermes_local");
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalled();
    // AGE-24: the key minted with the agent says so, and its provenance is recorded.
    expect(res.body.apiKey).toMatchObject({ name: "default", autoCreated: true });
    expect(mockAgentService.createApiKey).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "default",
      expect.objectContaining({ source: "agent_creation" }),
    );
    // The bundle materialization keys are added to the echoed config; what must
    // survive untouched is the caller-supplied hermesCommand.
    expect(res.body.adapterConfig).toMatchObject({
      hermesCommand: "/Users/example/.local/bin/hermes",
    });
  });

  it("blocks launch-safe agent creation when adapter preflight fails", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(failingPreflightAdapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Broken Agent",
          adapterType: "external_preflight_fail",
          requireHarnessPreflight: true,
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("Agent harness preflight failed");
    expect(res.body.details).toMatchObject({
      code: "agent_harness_preflight_failed",
      result: {
        adapterType: "external_preflight_fail",
        status: "fail",
        checks: [
          {
            code: "missing_token",
            level: "error",
            message: "Missing test token",
          },
        ],
      },
    });
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("allows launch-safe agent creation when adapter preflight only warns", async () => {
    // Warnings are advisory (a self-hosted Hermes box keeps its LLM keys in
    // ~/.hermes, so "No LLM API keys in AgentDash env" is the correct setup),
    // not a reason to block the hire.
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(warningPreflightAdapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Warned Agent",
          adapterType: "external_preflight_warn",
          requireHarnessPreflight: true,
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalled();
  });

  it("rejects agent creation on a warn that means the adapter cannot run", async () => {
    // "auth required" is warn-level but the agent would fail on first invoke —
    // it 422s exactly like a fail.
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(blockingWarnPreflightAdapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Auth Required Agent",
          adapterType: "external_preflight_warn_blocking",
          requireHarnessPreflight: true,
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("persists saved-agent harness preflight evidence", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "External Agent",
      urlKey: "external-agent",
      role: "general",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "external_test",
      adapterConfig: { model: "demo" },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/harness-preflight")
        .send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toMatchObject({
      adapterType: "external_test",
      status: "pass",
    });
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        metadata: expect.objectContaining({
          harnessPreflight: expect.objectContaining({
            status: "pass",
            configDigest: expect.any(String),
          }),
        }),
      }),
    );
  });

  it("returns 200 and persists warn evidence instead of rejecting a warned preflight", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(warningPreflightAdapter);
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "Warned Agent",
      urlKey: "warned-agent",
      role: "general",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "external_preflight_warn",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/harness-preflight")
        .send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toMatchObject({
      adapterType: "external_preflight_warn",
      status: "warn",
    });
    expect(res.body.readiness).toMatchObject({
      ready: true,
      reason: "passed_with_warnings",
    });
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        metadata: expect.objectContaining({
          harnessPreflight: expect.objectContaining({
            status: "warn",
          }),
        }),
      }),
    );
  });

  it("returns 422 on a saved-agent preflight whose warn means the adapter cannot run", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(blockingWarnPreflightAdapter);
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "Auth Required Agent",
      urlKey: "auth-required-agent",
      role: "general",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "external_preflight_warn_blocking",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/harness-preflight")
        .send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("passes the saved agent to the adapter's environment test (Hermes managed profiles need its id)", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    const seen: Array<Parameters<ServerAdapterModule["testEnvironment"]>[0]> = [];
    registerServerAdapter({
      type: "external_ctx_capture",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async (ctx) => {
        seen.push(ctx);
        return { adapterType: "external_ctx_capture", status: "pass", checks: [], testedAt: new Date(0).toISOString() };
      },
    });
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "Capture Agent",
      urlKey: "capture-agent",
      role: "general",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "external_ctx_capture",
      adapterConfig: { model: "demo" },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/harness-preflight")
        .send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.agent).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      adapterConfig: { model: "demo" },
    });
  });

  it("uses saved-agent wording when saved-agent harness preflight fails", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(failingPreflightAdapter);
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "Broken Agent",
      urlKey: "broken-agent",
      role: "general",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "external_preflight_fail",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/harness-preflight")
        .send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("before running this agent");
  });

  it("blocks launch-mode heartbeat invoke until saved-agent harness preflight is current", async () => {
    vi.stubEnv("AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT", "true");
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "External Agent",
      urlKey: "external-agent",
      role: "general",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "external_test",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/heartbeat/invoke")
        .send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("Run a harness preflight");
    expect(res.body.details).toMatchObject({
      code: "agent_harness_preflight_required",
      reason: "missing",
    });
    expect(mockHeartbeatService.invoke).not.toHaveBeenCalled();
  });

  it("rejects unknown adapter types even when schema accepts arbitrary strings", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Missing Adapter",
          adapterType: missingAdapterType,
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain(`Unknown adapter type: ${missingAdapterType}`);
  });
});
