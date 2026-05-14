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
const mockInstructions = { materializeManagedBundle: vi.fn().mockResolvedValue({}) };
const mockCosState = {
  getOrCreate: vi.fn(),
  recordTurn: vi.fn(),
  setGoals: vi.fn(),
  advancePhase: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../services/index.js", () => ({
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
  onboardingOrchestrator: () => mockOrchestrator,
  cosInterview: () => mockInterview,
  agentProposer: () => mockProposer,
  agentCreatorFromProposal: () => mockCreator,
  conversationService: () => mockConversations,
  agentService: () => mockAgents,
  accessService: () => ({}),
  companyService: () => ({}),
  agentInstructionsService: () => mockInstructions,
  cosOnboardingStateService: () => mockCosState,
}));

vi.mock("@paperclipai/db", () => ({
  authUsers: { id: "id" },
  assistantConversations: { id: "id" },
  assistantMessages: {
    conversationId: "conversation_id",
    cardKind: "card_kind",
    createdAt: "created_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
}));

import { onboardingV2Routes } from "../routes/onboarding-v2.js";
import { errorHandler } from "../middleware/error-handler.js";

function buildApp(actor: any, dbResults: Array<unknown[]> = []) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = actor;
    next();
  });
  // Stub db: each `select().from().where()...orderBy?...limit?` chain pops the
  // next preset result. The chain's terminal state is awaitable as a Promise of an array.
  const queue = [...dbResults];
  const makeChain = (): any => {
    const chain: any = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (onF: any, onR: any) =>
        Promise.resolve(queue.length > 0 ? queue.shift() : []).then(onF, onR),
    };
    return chain;
  };
  const stubDb: any = makeChain();
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
    // Closes #330: route asserts companyAccess against body.companyId
    // (per PR #282 / #230 security fix). Actor must include the
    // company in its companyIds list or the route returns 403.
    const app = buildApp({ type: "board", userId: "u1", source: "session", companyIds: ["c1"] });
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

describe("POST /api/onboarding/confirm-plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates one agent per plan-card entry, posts a closing message, advances phase to ready", async () => {
    mockAgents.list.mockResolvedValue([
      { id: "cos1", role: "chief_of_staff", name: "CoS" },
    ]);
    let createdCount = 0;
    mockAgents.create.mockImplementation(async (companyId: string, data: any) => ({
      id: `agent-${++createdCount}`,
      companyId,
      name: data.name,
      adapterConfig: {},
    }));

    const planPayload = {
      rationale: "ship + seed",
      agents: [
        {
          role: "engineering_lead",
          name: "Ellie",
          adapterType: "claude_local",
          responsibilities: ["own dashboard"],
          kpis: ["ship Q3"],
        },
        {
          role: "qa",
          name: "Quinn",
          adapterType: "claude_local",
          responsibilities: ["test nightly"],
          kpis: ["zero P0 escapes"],
        },
      ],
      alignmentToShortTerm: "ships v2",
      alignmentToLongTerm: "lays groundwork",
    };
    const app = buildApp(
      // Closes #330: includes companyIds per PR #282/#230 assertCompanyAccess.
      { type: "board", userId: "u1", source: "session", companyIds: ["c1"] },
      [
        // 1st db chain: lookup conversation
        [{ id: "conv1", companyId: "c1" }],
        // 2nd db chain: lookup latest agent_plan_proposal_v1 message
        [{ id: "msg1", cardKind: "agent_plan_proposal_v1", cardPayload: planPayload }],
      ],
    );

    const res = await request(app)
      .post("/api/onboarding/confirm-plan")
      .send({ conversationId: "conv1" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      companyId: "c1",
      createdAgentIds: ["agent-1", "agent-2"],
    });
    expect(mockAgents.create).toHaveBeenCalledTimes(2);
    expect(mockAgents.create).toHaveBeenNthCalledWith(
      1,
      "c1",
      expect.objectContaining({ name: "Ellie", adapterType: "claude_local", reportsTo: "cos1" }),
    );
    expect(mockAgents.create).toHaveBeenNthCalledWith(
      2,
      "c1",
      expect.objectContaining({ name: "Quinn", adapterType: "claude_local" }),
    );
    expect(mockInstructions.materializeManagedBundle).toHaveBeenCalledTimes(2);
    expect(mockCosState.advancePhase).toHaveBeenCalledWith("conv1", "materializing");
    expect(mockCosState.advancePhase).toHaveBeenCalledWith("conv1", "ready");
    // Closing message posted authored by the CoS.
    expect(mockConversations.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv1",
        authorKind: "agent",
        authorId: "cos1",
        body: expect.stringContaining("Done"),
      }),
    );
  });

  it("returns 404 when the conversation has no plan card", async () => {
    const app = buildApp(
      // Closes #330: includes companyIds per PR #282/#230 assertCompanyAccess.
      { type: "board", userId: "u1", source: "session", companyIds: ["c1"] },
      [
        [{ id: "conv1", companyId: "c1" }], // conversation lookup
        [], // no plan card
      ],
    );
    const res = await request(app)
      .post("/api/onboarding/confirm-plan")
      .send({ conversationId: "conv1" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/onboarding/revise-plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Closes #330: route is no longer Phase-F-deferred (#210 / #231
  // implemented it). With an empty conversation lookup, the route
  // returns 404 "Conversation not found" — assert that contract.
  it("returns 404 when the conversation is missing", async () => {
    const app = buildApp(
      { type: "board", userId: "u1", source: "session", companyIds: ["c1"] },
      [[]], // conversation lookup returns no rows
    );
    const res = await request(app)
      .post("/api/onboarding/revise-plan")
      .send({ conversationId: "conv1", revisionText: "swap qa for marketing" });
    expect(res.status).toBe(404);
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
