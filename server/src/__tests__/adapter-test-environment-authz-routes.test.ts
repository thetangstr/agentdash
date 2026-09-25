import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

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

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    // Closes #327: routes/agents.ts also imports these from the barrel.
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    agentService: () => ({
      getById: vi.fn(async (id: string) =>
        id === "agent-1" ? { id, companyId: "company-1", name: "CoS", permissions: { canCreateAgents: true } } : null,
      ),
    }),
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

// AgentDash (security): POST /companies/:companyId/adapters/:type/test-environment
// spawns the adapter CLI on the host with the caller's adapterConfig after
// resolving company secret refs into it. Choosing the command/args/env/cwd is
// instance-admin only; members may still probe the server-default binary.

const probeAdapterType = "test_environment_authz_route_test";

const MEMBER = {
  type: "board",
  userId: "user-member",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
  source: "session",
  isInstanceAdmin: false,
};
const INSTANCE_ADMIN = {
  type: "board",
  userId: "user-admin",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: true,
};
const LOCAL_BOARD = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};
const AGENT = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
};

async function createApp(actor: Record<string, unknown>) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
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

describe("adapter test-environment host-execution authz", () => {
  let testEnvironment: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    delete process.env.AGENTDASH_ADAPTER_ENV_BYPASS;
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    // Members hold no agents:create grant; agents do.
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);
    await unregisterTestAdapter(probeAdapterType);
    testEnvironment = vi.fn(async () => ({
      adapterType: probeAdapterType,
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    }));
    const { registerServerAdapter } = await import("../adapters/index.js");
    const adapter: ServerAdapterModule = {
      type: probeAdapterType,
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: testEnvironment as unknown as ServerAdapterModule["testEnvironment"],
    };
    registerServerAdapter(adapter);
  });

  afterEach(async () => {
    await unregisterTestAdapter(probeAdapterType);
  });

  async function probe(actor: Record<string, unknown>, adapterConfig: Record<string, unknown>) {
    const app = await createApp(actor);
    return requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/company-1/adapters/${probeAdapterType}/test-environment`)
        .send({ adapterConfig }),
    );
  }

  it.each([
    ["command", { command: "/bin/sh" }],
    ["env with a secret ref", { env: { NODE_OPTIONS: "--require ./x.js", KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" } } }],
    ["extraArgs", { extraArgs: ["-c", "id"] }],
    ["args", { args: ["-c", "id"] }],
    ["cwd", { cwd: "/var/tmp" }],
    ["hermesCommand", { hermesCommand: "/bin/sh" }],
    ["agentCommand", { agent: "custom", agentCommand: "sh -c id" }],
    ["stateDir", { stateDir: "/var/tmp/evil" }],
  ])("403s a non-admin member who supplies %s, before secrets resolve or anything spawns", async (_label, adapterConfig) => {
    const res = await probe(MEMBER, { model: "m", ...adapterConfig });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatch(/Instance admin/);
    expect(testEnvironment).not.toHaveBeenCalled();
    expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
  });

  it("403s an agent key that supplies a command even with agents:create", async () => {
    const res = await probe(AGENT, { command: "/bin/sh" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(testEnvironment).not.toHaveBeenCalled();
  });

  it("lets a member probe the server-default binary (no host-execution overrides)", async () => {
    const res = await probe(MEMBER, { model: "claude-sonnet", command: "", env: {}, extraArgs: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(testEnvironment).toHaveBeenCalledTimes(1);
  });

  it("lets an instance admin test a custom command and env", async () => {
    const res = await probe(INSTANCE_ADMIN, { command: "/usr/local/bin/claude", env: { A: "b" }, cwd: "/var/tmp" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(testEnvironment).toHaveBeenCalledTimes(1);
  });

  it("lets the local_trusted implicit board test a custom command", async () => {
    const res = await probe(LOCAL_BOARD, { command: "/usr/local/bin/claude" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(testEnvironment).toHaveBeenCalledTimes(1);
  });
});
