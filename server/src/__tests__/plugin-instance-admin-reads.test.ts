import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AgentDash (security): instance-global plugin reads (registry records, config,
// logs, jobs, dashboard) are instance-admin only. A member of one company must
// not be able to read plugin data that can carry another company's records.
// ui-contributions stays member-visible but must not leak sensitive fields.

const pluginId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

const pluginRecord = {
  id: pluginId,
  pluginKey: "paperclip.example",
  packageName: "paperclip-plugin-example",
  packagePath: "/srv/plugins/example",
  version: "1.0.0",
  status: "ready",
  lastError: null,
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  manifestJson: {
    id: "paperclip.example",
    displayName: "Example",
    capabilities: ["secrets.read"],
    entrypoints: { ui: "dist/ui" },
    instanceConfigSchema: { type: "object", properties: { apiKey: { type: "string" } } },
    ui: {
      slots: [{ type: "page", id: "main", displayName: "Main", exportName: "Main" }],
    },
  },
};

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
  upsertConfig: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

function chainDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const key of ["select", "from", "where", "orderBy"]) {
    chain[key] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

const jobStore = {
  listJobs: vi.fn(async () => [{ id: jobId, jobKey: "sync" }]),
  getJobByIdForPlugin: vi.fn(async () => ({ id: jobId })),
  listRunsByJob: vi.fn(async () => []),
  listRunsByPlugin: vi.fn(async () => []),
};

const workerManager = {
  getWorker: vi.fn(() => undefined),
  call: vi.fn(async () => ({ ok: true })),
};

async function createApp(actor: Record<string, unknown>) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(
    chainDb([{ id: "log-1", pluginId, message: "company B secret" }]) as never,
    { installPlugin: vi.fn() } as never,
    { jobStore, scheduler: {} } as never,
    undefined,
    undefined,
    { workerManager } as never,
  ));
  app.use(errorHandler);
  return app;
}

const member = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-a"],
};
const admin = {
  type: "board",
  userId: "admin-1",
  source: "session",
  isInstanceAdmin: true,
  companyIds: [],
};
const localBoard = {
  type: "board",
  userId: "local-board",
  source: "local_implicit",
  isInstanceAdmin: true,
};

const instanceGlobalRoutes = [
  ["list", "get", "/api/plugins", undefined],
  ["examples", "get", "/api/plugins/examples", undefined],
  ["get", "get", `/api/plugins/${pluginId}`, undefined],
  ["health", "get", `/api/plugins/${pluginId}/health`, undefined],
  ["logs", "get", `/api/plugins/${pluginId}/logs`, undefined],
  ["config", "get", `/api/plugins/${pluginId}/config`, undefined],
  ["config test", "post", `/api/plugins/${pluginId}/config/test`, { configJson: { apiKey: "x" } }],
  ["jobs", "get", `/api/plugins/${pluginId}/jobs`, undefined],
  ["job runs", "get", `/api/plugins/${pluginId}/jobs/${jobId}/runs`, undefined],
  ["dashboard", "get", `/api/plugins/${pluginId}/dashboard`, undefined],
] as const;

function send(app: express.Express, method: "get" | "post", path: string, body: unknown) {
  return method === "get" ? request(app).get(path) : request(app).post(path).send(body as object);
}

describe.sequential("plugin instance-global reads are instance-admin only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.getByKey.mockResolvedValue(null);
    mockRegistry.getConfig.mockResolvedValue({ pluginId, configJson: { apiKey: "sk-secret" } });
    mockRegistry.listInstalled.mockResolvedValue([pluginRecord]);
    mockRegistry.listByStatus.mockResolvedValue([pluginRecord]);
  });

  it.each(instanceGlobalRoutes)("403s a non-admin company member on %s", async (_n, method, path, body) => {
    const app = await createApp(member);
    const res = await send(app, method, path, body);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("sk-secret");
    expect(JSON.stringify(res.body)).not.toContain("company B secret");
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
    expect(workerManager.call).not.toHaveBeenCalled();
  }, 20_000);

  it.each(instanceGlobalRoutes)("allows an instance admin on %s", async (_n, method, path, body) => {
    const app = await createApp(admin);
    const res = await send(app, method, path, body);
    expect(res.status).toBe(200);
  }, 20_000);

  it.each(instanceGlobalRoutes)("allows the local_trusted board on %s", async (_n, method, path, body) => {
    const app = await createApp(localBoard);
    const res = await send(app, method, path, body);
    expect(res.status).toBe(200);
  }, 20_000);

  it("keeps ui-contributions reachable for members without sensitive fields", async () => {
    const app = await createApp(member);
    const res = await request(app).get("/api/plugins/ui-contributions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [entry] = res.body;
    expect(Object.keys(entry).sort()).toEqual(
      ["displayName", "launchers", "pluginId", "pluginKey", "slots", "uiEntryFile", "updatedAt", "version"],
    );
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("/srv/plugins");
    expect(serialized).not.toContain("instanceConfigSchema");
    expect(serialized).not.toContain("secrets.read");
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
  }, 20_000);
});
