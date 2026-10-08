import express from "express";
import request from "supertest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const companies = [{ id: "company-1", requireBoardApprovalForNewAgents: false }];
  let transactionOpen = false;
  // Adapter switches recheck the current agent under the production company
  // lock. Model that DB seam here; real contention is covered by the PG suite.
  const lockCompany = vi.fn(async () => {
    expect(transactionOpen).toBe(true);
    return companies;
  });
  const db = {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      transactionOpen = true;
      try { return await work(db); }
      finally { transactionOpen = false; }
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve(companies), { for: lockCompany })),
      })),
    })),
  };
  app.locals.companyTransaction = db.transaction;
  app.locals.lockCompany = lockCompany;
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

  // AgentDash (c3 addendum): the re-check endpoint returns its outcome as
  // data — a blocking warn is persisted as evidence and reported 200, while
  // the launch gate in claimQueuedRun is what refuses the run.
  it("returns 200 and persists a blocking-warn result on the saved-agent re-check", async () => {
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

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toMatchObject({
      adapterType: "external_preflight_warn_blocking",
      status: "warn",
    });
    expect(res.body.readiness).toMatchObject({ ready: false });
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

  // AgentDash (c4 trust): a page load re-checks preflight in the background —
  // those silent checks must not write activity rows credited to whoever is
  // merely looking at the page. An explicit Re-check still logs.
  it("skips the activity row for background preflight checks but keeps it for manual ones", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "Demo Agent",
      urlKey: "demo-agent",
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
    mockLogActivity.mockClear();

    const backgroundRes = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/harness-preflight")
        .send({ background: true }),
    );
    expect(backgroundRes.status, JSON.stringify(backgroundRes.body)).toBe(200);
    // logActivity(db, entry) — the activity row is the second argument.
    expect(
      mockLogActivity.mock.calls.filter(
        ([, entry]) => typeof entry?.action === "string" && entry.action.startsWith("agent.harness_preflight"),
      ),
    ).toHaveLength(0);

    const manualRes = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/harness-preflight")
        .send({}),
    );
    expect(manualRes.status, JSON.stringify(manualRes.body)).toBe(200);
    expect(
      mockLogActivity.mock.calls.some(
        ([, entry]) => entry?.action === "agent.harness_preflight_passed",
      ),
    ).toBe(true);
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

  // AgentDash (c3 addendum): a failed re-check is the answer, not an error —
  // 200 with the failed result saved as evidence, never a 422 to log.
  it("returns 200 and persists a failed result on the saved-agent re-check", async () => {
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

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toMatchObject({
      adapterType: "external_preflight_fail",
      status: "fail",
    });
    expect(res.body.readiness).toMatchObject({ ready: false, reason: "not_passed" });
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        metadata: expect.objectContaining({
          harnessPreflight: expect.objectContaining({
            status: "fail",
          }),
        }),
      }),
    );
  });

  // AgentDash (c3 review): the 200 re-check does not weaken the launch gate —
  // the failed evidence it persists still blocks invoke/wakeup with a 422.
  it("still 422s invoke after a failed re-check returned its result as data", async () => {
    vi.stubEnv("AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT", "true");
    const agent = {
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
      adapterType: "external_preflight_fail",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null as unknown,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockAgentService.getById.mockResolvedValue(agent);
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(failingPreflightAdapter);

    const app = await createApp();
    const recheck = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/harness-preflight")
        .send({}),
    );
    expect(recheck.status, JSON.stringify(recheck.body)).toBe(200);
    expect(recheck.body.readiness.ready).toBe(false);

    // The persisted failure is what the next agent read sees.
    const persisted = (mockAgentService.update.mock.calls.at(-1)?.[1] as { metadata?: unknown }).metadata;
    mockAgentService.getById.mockResolvedValue({ ...agent, metadata: persisted });

    const invoke = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/heartbeat/invoke")
        .send({}),
    );
    expect(invoke.status, JSON.stringify(invoke.body)).toBe(422);
    expect(invoke.body.details).toMatchObject({
      code: "agent_harness_preflight_required",
      reason: "not_passed",
    });
    expect(mockHeartbeatService.invoke).not.toHaveBeenCalled();
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

// AgentDash (review-1028, items 1/3/5 + 11): route-level coverage for the
// opt-in model tiers. POST /agents, POST /agent-hires and PATCH /agents/:id
// all funnel through applyCreateDefaultsByAdapterType + the instance gate —
// these exercise the real route handlers end to end with the BYOK marker
// path pointed at a temp dir.
describe("agent routes hermes model tiers", () => {
  let profilesDir: string;
  const ENV_KEYS = [
    "AGENTDASH_HERMES_MODEL_TIERS",
    "HERMES_PROFILES_DIR",
    "AGENTDASH_HERMES_ROOT",
    "AGENTDASH_HERMES_PROFILE_TEMPLATE",
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    process.env.AGENTDASH_BILLING_DISABLED = "true";
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
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
      title: (input.title as string | null) ?? null,
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
      metadata: (input.metadata as Record<string, unknown> | null | undefined) ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "Hermes Agent",
      urlKey: "hermes-agent",
      role: "engineer",
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
      metadata: (patch.metadata as Record<string, unknown> | null | undefined) ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "Hermes Agent",
      urlKey: "hermes-agent",
      role: "engineer",
      title: "Backend Engineer",
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "hermes_local",
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

    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    profilesDir = mkdtempSync(join(tmpdir(), "hermes-tiers-routes-"));
    process.env.HERMES_PROFILES_DIR = profilesDir;
    delete process.env.AGENTDASH_HERMES_ROOT;
    delete process.env.AGENTDASH_HERMES_PROFILE_TEMPLATE;
    process.env.AGENTDASH_HERMES_MODEL_TIERS = "on";
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(profilesDir, { recursive: true, force: true });
  });

  function createCallArgs() {
    return mockAgentService.create.mock.calls.map(([, input]: unknown[]) => input as Record<string, unknown>);
  }

  it("POST /agents stamps the role's tier on a modelless hermes_local agent", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Cos", role: "chief_of_staff", adapterType: "hermes_local", adapterConfig: {} }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [input] = createCallArgs();
    expect(input?.adapterConfig).toMatchObject({
      model: "qwen3.8-max",
      provider: "alibaba-token-plan-cn",
    });
    expect(input?.metadata).toMatchObject({ modelTier: "high" });
  });

  it("POST /agents maps an ops-role hire to the low tier", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Eng", role: "engineer", title: "Backend Engineer", adapterType: "hermes_local" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [input] = createCallArgs();
    expect(input?.adapterConfig).toMatchObject({ model: "deepseek-v4.1-flash" });
    expect(input?.metadata).toMatchObject({ modelTier: "low" });
  });

  it("POST /agents maps a pm with a non-leadership title to low (item 4)", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Coord", role: "pm", title: "Project Coordinator", adapterType: "hermes_local" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [input] = createCallArgs();
    expect(input?.adapterConfig).toMatchObject({ model: "deepseek-v4.1-flash" });
    expect(input?.metadata).toMatchObject({ modelTier: "low" });
  });

  it("POST /agents never overwrites an explicit model", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Zai",
          role: "ceo",
          adapterType: "hermes_local",
          adapterConfig: { model: "glm-5.3-flash", provider: "zai" },
        }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [input] = createCallArgs();
    expect(input?.adapterConfig).toEqual({ model: "glm-5.3-flash", provider: "zai" });
  });

  it("POST /agents keeps an explicit non-tier provider whole — no tier model either (item 3)", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Byop",
          role: "ceo",
          adapterType: "hermes_local",
          adapterConfig: { provider: "zai" },
        }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [input] = createCallArgs();
    expect(input?.adapterConfig).toEqual({ provider: "zai" });
  });

  it("POST /agents applies nothing with the switch off — the pre-tier behaviour", async () => {
    process.env.AGENTDASH_HERMES_MODEL_TIERS = "off";
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Cos", role: "chief_of_staff", adapterType: "hermes_local", adapterConfig: {} }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [input] = createCallArgs();
    expect(input?.adapterConfig ?? {}).not.toHaveProperty("model");
    expect(input?.adapterConfig ?? {}).not.toHaveProperty("provider");
  });

  it("POST /agents applies nothing on a BYOK box even with the switch on", async () => {
    mkdirSync(join(profilesDir, "agentdash"), { recursive: true });
    writeFileSync(
      join(profilesDir, "agentdash", "agentdash-provider.json"),
      JSON.stringify({ provider: "zai", model: "glm-5.3-flash" }),
    );
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Cos", role: "chief_of_staff", adapterType: "hermes_local", adapterConfig: {} }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [input] = createCallArgs();
    expect(input?.adapterConfig ?? {}).not.toHaveProperty("model");
  });

  it("POST /agent-hires stamps the tier through the same funnel", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agent-hires")
        .send({ name: "Cos", role: "chief_of_staff", adapterType: "hermes_local", adapterConfig: {} }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [input] = createCallArgs();
    expect(input?.adapterConfig).toMatchObject({
      model: "qwen3.8-max",
      provider: "alibaba-token-plan-cn",
    });
    expect(input?.metadata).toMatchObject({ modelTier: "high" });
  });

  it("PATCH /agents/:id on an unrelated adapterConfig field does NOT move the agent onto a tier (item 5)", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { cwd: "/tmp/work" } }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [patch] = mockAgentService.update.mock.calls.map(([, p]: unknown[]) => p as Record<string, unknown>);
    expect(patch?.adapterConfig).toMatchObject({ cwd: "/tmp/work" });
    expect(patch?.adapterConfig).not.toHaveProperty("model");
    expect(patch?.adapterConfig).not.toHaveProperty("provider");
  });

  it("PATCH /agents/:id clearing the model applies the tier (item 5)", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...(await mockAgentService.getById()),
      adapterConfig: { model: "custom-model" },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { model: "" } }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [patch] = mockAgentService.update.mock.calls.map(([, p]: unknown[]) => p as Record<string, unknown>);
    expect(patch?.adapterConfig).toMatchObject({
      model: "deepseek-v4.1-flash",
      provider: "alibaba-token-plan-cn",
    });
    expect(patch?.metadata).toMatchObject({ modelTier: "low" });
  });

  it("PATCH /agents/:id clearing the model on an explicit non-tier provider keeps the provider (items 3+5)", async () => {
    // The two rules collide here: the model was cleared (item 5 says apply
    // the tier) but the agent's provider is a person's explicit non-tier
    // choice (item 3 says leave it whole). The provider wins — a tier model
    // on a foreign provider is a guaranteed wrong route, while an empty
    // model on the kept provider is a reviewable hermes default.
    mockAgentService.getById.mockResolvedValue({
      ...(await mockAgentService.getById()),
      adapterConfig: { model: "custom-model", provider: "custom-p" },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { model: "" } }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [patch] = mockAgentService.update.mock.calls.map(([, p]: unknown[]) => p as Record<string, unknown>);
    expect(patch?.adapterConfig).toEqual({ model: "", provider: "custom-p" });
  });

  it("PATCH /agents/:id switching adapterType to hermes_local applies the tier (item 5)", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...(await mockAgentService.getById()),
      adapterType: "process",
      adapterConfig: {},
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterType: "hermes_local" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(app.locals.companyTransaction).toHaveBeenCalledTimes(1);
    expect(app.locals.lockCompany).toHaveBeenCalledExactlyOnceWith("no key update");
    expect(app.locals.lockCompany.mock.invocationCallOrder[0]).toBeLessThan(mockAgentService.update.mock.invocationCallOrder[0]);
    const [patch] = mockAgentService.update.mock.calls.map(([, p]: unknown[]) => p as Record<string, unknown>);
    expect(patch?.adapterConfig).toMatchObject({ model: "deepseek-v4.1-flash" });
    expect(patch?.metadata).toMatchObject({ modelTier: "low" });
  });

  it("PATCH /agents/:id with a custom model removes the recorded tier", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...(await mockAgentService.getById()),
      adapterConfig: { model: "deepseek-v4.1-flash", provider: "alibaba-token-plan-cn" },
      metadata: { modelTier: "low", other: "kept" },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { model: "glm-5.3-flash", provider: "zai" } }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [patch] = mockAgentService.update.mock.calls.map(([, p]: unknown[]) => p as Record<string, unknown>);
    expect(patch?.adapterConfig).toMatchObject({ model: "glm-5.3-flash", provider: "zai" });
    expect(patch?.metadata).toMatchObject({ other: "kept" });
    expect(patch?.metadata).not.toHaveProperty("modelTier");
  });

  it("PATCH /agents/:id on an unrelated adapterConfig field preserves the recorded tier with the switch off (review-1028 follow-up)", async () => {
    process.env.AGENTDASH_HERMES_MODEL_TIERS = "off";
    mockAgentService.getById.mockResolvedValue({
      ...(await mockAgentService.getById()),
      adapterConfig: { model: "deepseek-v4.1-flash", provider: "alibaba-token-plan-cn" },
      metadata: { modelTier: "low", other: "kept" },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { timeoutSec: 600 } }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [patch] = mockAgentService.update.mock.calls.map(([, p]: unknown[]) => p as Record<string, unknown>);
    expect(patch?.adapterConfig).toMatchObject({ timeoutSec: 600, model: "deepseek-v4.1-flash" });
    expect(patch?.metadata).toMatchObject({ modelTier: "low", other: "kept" });
  });

  it("PATCH /agents/:id resending the same model value preserves the recorded tier with the switch off", async () => {
    process.env.AGENTDASH_HERMES_MODEL_TIERS = "off";
    mockAgentService.getById.mockResolvedValue({
      ...(await mockAgentService.getById()),
      adapterConfig: { model: "deepseek-v4.1-flash", provider: "alibaba-token-plan-cn" },
      metadata: { modelTier: "low" },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { model: "deepseek-v4.1-flash", provider: "alibaba-token-plan-cn" } }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [patch] = mockAgentService.update.mock.calls.map(([, p]: unknown[]) => p as Record<string, unknown>);
    expect(patch?.metadata).toMatchObject({ modelTier: "low" });
  });

  it("PATCH /agents/:id picking a custom model still clears the recorded tier with the switch off", async () => {
    process.env.AGENTDASH_HERMES_MODEL_TIERS = "off";
    mockAgentService.getById.mockResolvedValue({
      ...(await mockAgentService.getById()),
      adapterConfig: { model: "deepseek-v4.1-flash", provider: "alibaba-token-plan-cn" },
      metadata: { modelTier: "low", other: "kept" },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { model: "glm-5.3-flash", provider: "zai" } }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [patch] = mockAgentService.update.mock.calls.map(([, p]: unknown[]) => p as Record<string, unknown>);
    expect(patch?.metadata).toMatchObject({ other: "kept" });
    expect(patch?.metadata).not.toHaveProperty("modelTier");
  });

  it("PATCH /agents/:id switching away from hermes_local clears the recorded tier with the switch off", async () => {
    process.env.AGENTDASH_HERMES_MODEL_TIERS = "off";
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    mockAgentService.getById.mockResolvedValue({
      ...(await mockAgentService.getById()),
      adapterConfig: { model: "deepseek-v4.1-flash", provider: "alibaba-token-plan-cn" },
      metadata: { modelTier: "low", other: "kept" },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterType: "external_test", adapterConfig: {} }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(app.locals.companyTransaction).toHaveBeenCalledTimes(1);
    expect(app.locals.lockCompany).toHaveBeenCalledExactlyOnceWith("no key update");
    expect(app.locals.lockCompany.mock.invocationCallOrder[0]).toBeLessThan(mockAgentService.update.mock.invocationCallOrder[0]);
    const [patch] = mockAgentService.update.mock.calls.map(([, p]: unknown[]) => p as Record<string, unknown>);
    expect(patch?.metadata).toMatchObject({ other: "kept" });
    expect(patch?.metadata).not.toHaveProperty("modelTier");
  });
});
