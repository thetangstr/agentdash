import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

/**
 * RF criteria — Ross GLM feasibility test flag gate (2026-09-02).
 *
 * The feasibility probe is an agent whose adapterConfig carries
 * `rossFeasibilityTest: true`. Launching it — POST /agents/:id/wakeup and
 * POST /agents/:id/heartbeat/invoke — is allowed only while its company has
 * the `ross_glm_feasibility_test` feature flag enabled (FEATURE_FLAG_KEYS in
 * shared constants). Agents WITHOUT the marker never consult the flag, so
 * behavior for every existing agent is unchanged byte for byte.
 *
 *   RF-1  marker agent + flag disabled -> 403 ROSS_FEASIBILITY_FLAG_DISABLED, no run
 *   RF-2  marker agent + flag enabled  -> 202, heartbeat.wakeup called
 *   RF-3  plain agent  + flag disabled -> 202, and the flag was NEVER consulted
 *   RF-4  heartbeat/invoke, marker + flag disabled -> 403, no invoke
 *   RF-5  marker agent + flag enabled  -> wakeup recorded requestedByActorType "user"
 */

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  list: vi.fn(async () => []),
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
  normalizeAdapterConfigForPersistence: vi.fn(async (_c: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_c: string, config: Record<string, unknown>) => ({ config })),
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
  wakeup: vi.fn(),
  invoke: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockFeatureFlags = vi.hoisted(() => ({
  isEnabled: vi.fn(async () => false),
}));

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
  agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: vi.fn().mockReturnValue({ create: vi.fn(), getById: vi.fn() }),
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: Record<string, unknown>) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/feature-flags.js", () => ({
  featureFlagsService: () => mockFeatureFlags,
}));

const markerAgent = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001",
  companyId: "company-1",
  adapterType: "hermes_local",
  adapterConfig: { hermesCommand: "/tmp/hermes-rosstest-wrapper", rossFeasibilityTest: true },
  status: "idle",
  role: "general",
  name: "Ross GLM Feasibility Probe",
};

const plainAgent = {
  ...markerAgent,
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002",
  adapterConfig: { hermesCommand: "/tmp/hermes-wrapper" },
};

async function createApp() {
  const [{ agentRoutes }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
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
        where: vi.fn(async () => []),
        orderBy: vi.fn(async () => []),
        limit: vi.fn(async () => []),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => []) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
  } as unknown as Db;
  app.use("/api", agentRoutes(db));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFeatureFlags.isEnabled.mockResolvedValue(false);
  mockHeartbeatService.wakeup.mockResolvedValue({ id: "run-1" });
  mockHeartbeatService.invoke.mockResolvedValue({ id: "run-1" });
});

describe("ross feasibility flag gate", () => {
  it("RF-1: marker agent + flag disabled -> 403 ROSS_FEASIBILITY_FLAG_DISABLED, no run", async () => {
    mockAgentService.getById.mockResolvedValue(markerAgent);
    const app = await createApp();
    const res = await request(app).post("/api/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001/wakeup").send({ reason: "test" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROSS_FEASIBILITY_FLAG_DISABLED");
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("RF-2: marker agent + flag enabled -> 202 and heartbeat.wakeup called", async () => {
    mockAgentService.getById.mockResolvedValue(markerAgent);
    mockFeatureFlags.isEnabled.mockResolvedValue(true);
    const app = await createApp();
    const res = await request(app).post("/api/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001/wakeup").send({ reason: "test" });
    expect(res.status).toBe(202);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup.mock.calls[0][0]).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001");
  });

  it("RF-3: plain agent + flag disabled -> 202, and the flag was never consulted", async () => {
    mockAgentService.getById.mockResolvedValue(plainAgent);
    const app = await createApp();
    const res = await request(app).post("/api/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002/wakeup").send({ reason: "test" });
    expect(res.status).toBe(202);
    expect(mockFeatureFlags.isEnabled).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
  });

  it("RF-4: heartbeat/invoke on marker agent + flag disabled -> 403, no invoke", async () => {
    mockAgentService.getById.mockResolvedValue(markerAgent);
    const app = await createApp();
    const res = await request(app).post("/api/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001/heartbeat/invoke").send({ reason: "test" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROSS_FEASIBILITY_FLAG_DISABLED");
    expect(mockHeartbeatService.invoke).not.toHaveBeenCalled();
  });

  it("RF-5: marker agent + flag enabled -> wakeup attributed to the user actor", async () => {
    mockAgentService.getById.mockResolvedValue(markerAgent);
    mockFeatureFlags.isEnabled.mockResolvedValue(true);
    const app = await createApp();
    const res = await request(app).post("/api/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001/wakeup").send({ reason: "test" });
    expect(res.status).toBe(202);
    const opts = mockHeartbeatService.wakeup.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.requestedByActorType).toBe("user");
    expect(opts.requestedByActorId).toBe("local-board");
  });
});
