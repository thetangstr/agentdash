import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const routineId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const otherAgentId = "55555555-5555-4555-8555-555555555555";

const routine = {
  id: routineId,
  companyId,
  projectId,
  goalId: null,
  parentIssueId: null,
  title: "Daily routine",
  description: null,
  assigneeAgentId: agentId,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: null,
  lastEnqueuedAt: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};
const pausedRoutine = {
  ...routine,
  status: "paused",
};
const trigger = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId,
  routineId,
  kind: "schedule",
  label: "weekday",
  enabled: false,
  cronExpression: "0 10 * * 1-5",
  timezone: "UTC",
  nextRunAt: null,
  lastFiredAt: null,
  publicId: null,
  secretId: null,
  signingMode: null,
  replayWindowSec: null,
  lastRotatedAt: null,
  lastResult: null,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const mockRoutineService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  getDetail: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  listRuns: vi.fn(),
  createTrigger: vi.fn(),
  getTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  rotateTriggerSecret: vi.fn(),
  runRoutine: vi.fn(),
  firePublicTrigger: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackRoutineCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackRoutineCreated: mockTrackRoutineCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    accessService: () => mockAccessService,
    logActivity: mockLogActivity,
    routineService: () => mockRoutineService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { routineRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/routines.js")>("../routes/routines.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", routineRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("routine routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/routines.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockRoutineService.list.mockResolvedValue([routine]);
    mockRoutineService.create.mockResolvedValue(routine);
    mockRoutineService.get.mockResolvedValue(routine);
    mockRoutineService.getTrigger.mockResolvedValue(trigger);
    mockRoutineService.update.mockResolvedValue({ ...routine, assigneeAgentId: otherAgentId });
    mockRoutineService.runRoutine.mockResolvedValue({
      id: "run-1",
      source: "manual",
      status: "issue_created",
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("passes project filters to the routine list service", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/routines`)
      .query({ projectId });

    expect(res.status).toBe(200);
    expect(mockRoutineService.list).toHaveBeenCalledWith(companyId, { projectId });
  });

  it("requires tasks:assign permission for non-admin board routine creation", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.create).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to retarget a routine assignee", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        assigneeAgentId: otherAgentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to reactivate a routine", async () => {
    mockRoutineService.get.mockResolvedValue(pausedRoutine);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        status: "active",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to create a trigger", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.createTrigger).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to update a trigger", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routine-triggers/${trigger.id}`)
      .send({
        enabled: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.updateTrigger).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to manually run a routine", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.runRoutine).not.toHaveBeenCalled();
  });

  it("passes the board actor through when manually running a routine", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({});

    expect(res.status).toBe(202);
    expect(mockRoutineService.runRoutine).toHaveBeenCalledWith(routineId, {
      source: "manual",
    }, {
      agentId: null,
      userId: "board-user",
    });
  });

  it("allows routine creation when the board user has tasks:assign", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(201);
    expect(mockRoutineService.create).toHaveBeenCalledWith(companyId, expect.objectContaining({
      projectId,
      title: "Daily routine",
      assigneeAgentId: agentId,
    }), {
      agentId: null,
      userId: "board-user",
    });
    expect(mockTrackRoutineCreated).toHaveBeenCalledWith(expect.anything());
  });

  // AgentDash: (#710) every routine write is a standing-instruction change.
  describe("standing-instruction guard on routine edits (#710)", () => {
    const assignedAgent = {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    };
    const memberWithoutAssign = {
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    };
    const instanceAdmin = {
      type: "board",
      userId: "admin-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    };
    const variablesPatch = {
      variables: [{ name: "target", type: "text", required: true }],
    };

    it.each([
      ["description", { description: "Wire the treasury to this account." }],
      ["variables", variablesPatch],
      ["title", { title: "Renamed routine" }],
      ["project", { projectId: null }],
    ])("rejects the assigned agent editing %s of its active routine", async (_field, body) => {
      const app = await createApp(assignedAgent);

      const res = await request(app).patch(`/api/routines/${routineId}`).send(body);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Agents cannot create or change routines");
      expect(mockRoutineService.update).not.toHaveBeenCalled();
    });

    it.each([
      ["description", { description: "Do something else every morning." }],
      ["variables", variablesPatch],
      ["pause", { status: "paused" }],
    ])("rejects a member without tasks:assign editing %s", async (_field, body) => {
      const app = await createApp(memberWithoutAssign);

      const res = await request(app).patch(`/api/routines/${routineId}`).send(body);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("tasks:assign");
      expect(mockAccessService.canUser).toHaveBeenCalledWith(companyId, "board-user", "tasks:assign");
      expect(mockRoutineService.update).not.toHaveBeenCalled();
    });

    it("lets a member with tasks:assign edit the description", async () => {
      mockAccessService.canUser.mockResolvedValue(true);
      const app = await createApp(memberWithoutAssign);

      const res = await request(app)
        .patch(`/api/routines/${routineId}`)
        .send({ description: "Updated by an admin." });

      expect(res.status).toBe(200);
      expect(mockRoutineService.update).toHaveBeenCalledWith(
        routineId,
        { description: "Updated by an admin." },
        { agentId: null, userId: "board-user" },
      );
    });

    it("lets an instance admin edit variables without a tasks:assign grant", async () => {
      const app = await createApp(instanceAdmin);

      const res = await request(app).patch(`/api/routines/${routineId}`).send(variablesPatch);

      expect(res.status).toBe(200);
      expect(mockAccessService.canUser).not.toHaveBeenCalled();
      expect(mockRoutineService.update).toHaveBeenCalledWith(
        routineId,
        expect.objectContaining({ variables: [expect.objectContaining({ name: "target" })] }),
        { agentId: null, userId: "admin-user" },
      );
    });

    it("lets the local implicit board edit the description", async () => {
      const app = await createApp({ type: "board", userId: "local-board", source: "local_implicit" });

      const res = await request(app)
        .patch(`/api/routines/${routineId}`)
        .send({ description: "Local edit." });

      expect(res.status).toBe(200);
      expect(mockRoutineService.update).toHaveBeenCalled();
    });

    // Every write route, so a route added later without the guard shows up here.
    const writeRoutes = [
      {
        name: "create routine",
        method: "post",
        path: `/api/companies/${companyId}/routines`,
        body: { projectId, title: "Daily routine", assigneeAgentId: agentId },
        service: "create",
        okStatus: 201,
      },
      {
        name: "update routine",
        method: "patch",
        path: `/api/routines/${routineId}`,
        body: { description: "New instructions." },
        service: "update",
        okStatus: 200,
      },
      {
        name: "create trigger",
        method: "post",
        path: `/api/routines/${routineId}/triggers`,
        body: { kind: "schedule", cronExpression: "0 10 * * *", timezone: "UTC" },
        service: "createTrigger",
        okStatus: 201,
      },
      {
        name: "update trigger",
        method: "patch",
        path: `/api/routine-triggers/${trigger.id}`,
        body: { cronExpression: "* * * * *" },
        service: "updateTrigger",
        okStatus: 200,
      },
      {
        name: "delete trigger",
        method: "delete",
        path: `/api/routine-triggers/${trigger.id}`,
        body: undefined,
        service: "deleteTrigger",
        okStatus: 204,
      },
      {
        name: "rotate trigger secret",
        method: "post",
        path: `/api/routine-triggers/${trigger.id}/rotate-secret`,
        body: {},
        service: "rotateTriggerSecret",
        okStatus: 200,
      },
      {
        name: "run routine",
        method: "post",
        path: `/api/routines/${routineId}/run`,
        body: {},
        service: "runRoutine",
        okStatus: 202,
      },
    ] as const;

    function send(app: express.Express, route: (typeof writeRoutes)[number]) {
      const req = request(app)[route.method](route.path);
      return route.body === undefined ? req : req.send(route.body);
    }

    beforeEach(() => {
      mockRoutineService.createTrigger.mockResolvedValue({ trigger, secretMaterial: null });
      mockRoutineService.updateTrigger.mockResolvedValue(trigger);
      mockRoutineService.deleteTrigger.mockResolvedValue(undefined);
      mockRoutineService.rotateTriggerSecret.mockResolvedValue({ trigger, secretMaterial: null });
    });

    it.each(writeRoutes)("rejects the assigned agent: $name", async (route) => {
      const app = await createApp(assignedAgent);

      const res = await send(app, route);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Agents cannot create or change routines");
      expect(mockRoutineService[route.service]).not.toHaveBeenCalled();
    });

    it.each(writeRoutes)("rejects a member without tasks:assign: $name", async (route) => {
      const app = await createApp(memberWithoutAssign);

      const res = await send(app, route);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("tasks:assign");
      expect(mockRoutineService[route.service]).not.toHaveBeenCalled();
    });

    it.each(writeRoutes)("allows an instance admin: $name", async (route) => {
      const app = await createApp(instanceAdmin);

      const res = await send(app, route);

      expect(res.status).toBe(route.okStatus);
      expect(mockAccessService.canUser).not.toHaveBeenCalled();
      expect(mockRoutineService[route.service]).toHaveBeenCalled();
    });

    it.each(writeRoutes)("allows a member with tasks:assign: $name", async (route) => {
      mockAccessService.canUser.mockResolvedValue(true);
      const app = await createApp(memberWithoutAssign);

      const res = await send(app, route);

      expect(res.status).toBe(route.okStatus);
      expect(mockRoutineService[route.service]).toHaveBeenCalled();
    });

    it("returns 404 for a missing routine before checking permissions", async () => {
      mockRoutineService.get.mockResolvedValue(null);
      const app = await createApp(memberWithoutAssign);

      const res = await request(app)
        .patch(`/api/routines/${routineId}`)
        .send({ description: "x" });

      expect(res.status).toBe(404);
      expect(mockAccessService.canUser).not.toHaveBeenCalled();
    });
  });
});
