import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOrchestrator = { bootstrap: vi.fn() };
const mockConversations = {
  paginate: vi.fn().mockResolvedValue([]),
  postMessage: vi.fn().mockResolvedValue({ id: "m1" }),
  findByCompany: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({ id: "conv1" }),
  addParticipant: vi.fn().mockResolvedValue(undefined),
};
const mockAgents = {
  create: vi.fn(),
  getById: vi.fn(),
  createApiKey: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  listKeys: vi.fn().mockResolvedValue([]),
};
const mockInterview = { nextTurn: vi.fn() };
const mockProposer = { propose: vi.fn() };
const mockCreator = { create: vi.fn() };

vi.mock("../services/index.js", () => ({
  onboardingOrchestrator: () => mockOrchestrator,
  cosInterview: () => mockInterview,
  agentProposer: () => mockProposer,
  agentCreatorFromProposal: () => mockCreator,
  conversationService: () => mockConversations,
  agentService: () => mockAgents,
  accessService: () => ({}),
  companyService: () => ({}),
  agentInstructionsService: () => ({}),
}));

vi.mock("@paperclipai/db", () => ({
  authUsers: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

import { onboardingV2Routes } from "../routes/onboarding-v2.js";
import { errorHandler } from "../middleware/error-handler.js";

function buildApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = actor;
    next();
  });
  // Provide a stub db that has a select chain for authUsers lookup
  const stubDb: any = {
    select: () => stubDb,
    from: () => stubDb,
    where: () => Promise.resolve([]),
  };
  app.use("/api/onboarding", onboardingV2Routes(stubDb));
  app.use(errorHandler);
  return app;
}

describe("POST /api/onboarding/bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConversations.postMessage.mockResolvedValue({ id: "m1" });
  });

  it("returns the bootstrapped IDs (welcome sequence is owned by orchestrator, not the route)", async () => {
    mockOrchestrator.bootstrap.mockResolvedValue({
      companyId: "c1",
      cosAgentId: "a1",
      conversationId: "conv1",
    });
    const app = buildApp({ type: "board", userId: "u1", source: "session" });
    const res = await request(app).post("/api/onboarding/bootstrap").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      companyId: "c1",
      cosAgentId: "a1",
      conversationId: "conv1",
    });
    expect(mockOrchestrator.bootstrap).toHaveBeenCalledWith("u1");
    // The route must NOT post any messages itself anymore.
    expect(mockConversations.postMessage).not.toHaveBeenCalled();
  });

  it("returns 401 for unauthenticated callers", async () => {
    const app = buildApp({ type: "none", source: "none" });
    const res = await request(app).post("/api/onboarding/bootstrap").send({});
    expect(res.status).toBe(401);
  });
});

describe("POST /api/onboarding/agent/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConversations.postMessage.mockResolvedValue({ id: "m1" });
    mockConversations.paginate.mockResolvedValue([]);
  });

  it("hires an agent and returns the proposal + apiKey", async () => {
    mockProposer.propose.mockResolvedValue({
      name: "Reese",
      role: "SDR",
      oneLineOkr: "ok",
      rationale: "x",
    });
    mockCreator.create.mockResolvedValue({
      agentId: "agent-2",
      apiKey: { id: "k", token: "agk_x" },
    });
    const app = buildApp({ type: "board", userId: "u1", source: "session" });
    const res = await request(app).post("/api/onboarding/agent/confirm").send({
      conversationId: "conv1",
      reportsToAgentId: "cos1",
      companyId: "c1",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      agent: { id: "agent-2", name: "Reese", title: "SDR" },
      apiKey: { token: "agk_x" },
    });
  });
});

describe("POST /api/onboarding/invites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes the invite list (returns errors[] when invite service is stubbed)", async () => {
    const app = buildApp({ type: "board", userId: "u1", source: "session" });
    const res = await request(app).post("/api/onboarding/invites").send({
      conversationId: "conv1",
      companyId: "c1",
      emails: ["bob@acme.com"],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      inviteIds: expect.any(Array),
      errors: expect.any(Array),
    });
  });
});
