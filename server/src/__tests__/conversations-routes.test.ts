import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const baseMessage = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  conversationId,
  role: "user" as const,
  authorUserId: userId,
  content: "Hello world",
  cardKind: null,
  cardPayload: null,
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
};

const failedReplyCard = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  conversationId,
  role: "agent" as const,
  cardKind: "cos_dispatch_error_v1",
  cardPayload: { reason: "x", retryMessageId: baseMessage.id },
  content: "CoS couldn't reply: x. Retry",
  createdAt: new Date("2026-05-01T00:00:05.000Z"),
};

/** The conversation ends on the person's message followed by its failure card. */
function conversationEndsOnFailedReply(mock: { latestByRole: ReturnType<typeof vi.fn> }) {
  mock.latestByRole.mockImplementation(async (_id: string, role: string) => (role === "agent" ? failedReplyCard : baseMessage));
}

const mockConversationService = vi.hoisted(() => ({
  getById: vi.fn(),
  postMessage: vi.fn(),
  paginate: vi.fn(),
  setReadPointer: vi.fn(),
  listParticipants: vi.fn(),
  findByCompany: vi.fn(),
  create: vi.fn(),
  addParticipant: vi.fn(),
  getMessage: vi.fn(),
  latestByRole: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  getById: vi.fn(),
}));

const mockDispatchOnMessage = vi.hoisted(() => vi.fn());

const mockConversationDispatch = vi.hoisted(() => vi.fn(() => ({
  onMessage: mockDispatchOnMessage,
})));

// AgentDash (scan 3, lane G): the CoS replier gets the issue action.
const mockCosIssueAction = vi.hoisted(() => ({
  roster: vi.fn(),
  proposeFromTrailer: vi.fn(),
  confirmProposal: vi.fn(),
  dismissProposal: vi.fn(),
}));
const mockVisibleAgentIdsFor = vi.hoisted(() => vi.fn());
const mockCosReplier = vi.hoisted(() => vi.fn((_deps: unknown) => ({ reply: vi.fn() })));

function registerModuleMocks() {
  vi.doMock("../services/conversations.js", () => ({
    conversationService: () => mockConversationService,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
    deduplicateAgentName: vi.fn(),
  }));

  vi.doMock("../services/conversation-dispatch.js", () => ({
    conversationDispatch: mockConversationDispatch,
  }));

  vi.doMock("../services/cos-replier.js", () => ({
    cosReplier: mockCosReplier,
  }));

  vi.doMock("../routes/visibility.js", () => ({
    visibleAgentIdsFor: mockVisibleAgentIdsFor,
  }));

  vi.doMock("../services/cos-issue-action.js", () => ({
    cosIssueActionForDb: () => mockCosIssueAction,
  }));

  vi.doMock("../services/agent-summoner.js", () => ({
    agentSummoner: vi.fn(() => ({ summon: vi.fn() })),
  }));

  vi.doMock("../services/index.js", () => ({
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    conversationService: () => mockConversationService,
    companyService: () => ({ getById: vi.fn().mockResolvedValue({ id: companyId, name: "Acme Labs" }) }),
    conversationDispatch: mockConversationDispatch,
    agentService: () => mockAgentService,
    cosReplier: mockCosReplier,
    agentSummoner: vi.fn(() => ({ summon: vi.fn() })),
    // Phase B (#PR for cos-phases-bcd): cos-replier now reads/writes a
    // cos_onboarding_state row to drive phase transitions. The route
    // factory wires this in; tests stub it with no-op methods.
    cosOnboardingStateService: () => ({
      getOrCreate: vi.fn().mockResolvedValue({ phase: "goals", goals: {}, turnsInPhase: 0 }),
      recordTurn: vi.fn().mockResolvedValue(undefined),
      setGoals: vi.fn().mockResolvedValue(undefined),
      advancePhase: vi.fn().mockResolvedValue(undefined),
    }),
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { conversationRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/conversations.js") as Promise<typeof import("../routes/conversations.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/conversations", conversationRoutes({} as any));
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

const boardActor = {
  type: "board",
  userId,
  companyId,
  companyIds: [companyId],
};

const noActor = {
  type: "none",
};

describe.sequential("conversation routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/conversations.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/conversation-dispatch.js");
    vi.doUnmock("../services/cos-replier.js");
    vi.doUnmock("../services/cos-issue-action.js");
    vi.doUnmock("../routes/visibility.js");
    vi.doUnmock("../services/agent-summoner.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/conversations.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();

    // Default happy-path stubs
    mockConversationService.getById.mockResolvedValue({
      id: conversationId,
      companyId,
      userId,
      title: "Company Inbox",
      status: "active",
    });
    mockConversationService.postMessage.mockResolvedValue(baseMessage);
    mockConversationService.paginate.mockResolvedValue([baseMessage]);
    mockConversationService.listParticipants.mockResolvedValue([]);
    mockConversationService.setReadPointer.mockResolvedValue(true);
    mockAgentService.list.mockResolvedValue([]);
    mockDispatchOnMessage.mockResolvedValue(undefined);
    mockConversationDispatch.mockReturnValue({ onMessage: mockDispatchOnMessage });
    mockCosReplier.mockImplementation(() => ({ reply: vi.fn() }));
    mockVisibleAgentIdsFor.mockResolvedValue(new Set(["agent-visible"]));
  });

  // AgentDash (scan 3, lane G): the CoS hands out work with the sender's authority.
  describe("CoS task creation wiring", () => {
    it("gives the CoS replier the issue action", async () => {
      await createApp(boardActor);
      expect(mockCosReplier).toHaveBeenCalledWith(expect.objectContaining({ issueAction: mockCosIssueAction }));
    });

    it("passes how the sender is signed in to the dispatcher", async () => {
      const app = await createApp({ ...boardActor, source: "session", isInstanceAdmin: false });
      await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages`).send({ body: "Get Ellie on the Acme proposal" }),
      );
      await new Promise((r) => setImmediate(r));
      expect(mockDispatchOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          authorUserId: userId,
          authorSource: "session",
          authorIsInstanceAdmin: false,
          companyId,
        }),
      );
    });

    it("resolves the sender's agent visibility for their own request", async () => {
      const app = await createApp({ ...boardActor, source: "session" });
      await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages`).send({ body: "Have Ellie do X" }),
      );
      await new Promise((r) => setImmediate(r));
      const input = mockDispatchOnMessage.mock.calls[0]![0];
      expect(input.messageId).toBe(baseMessage.id);
      await expect(input.authorVisibleAgentIds()).resolves.toEqual(new Set(["agent-visible"]));
      expect(mockVisibleAgentIdsFor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actor: expect.objectContaining({ userId }) }), companyId);
    });

    it("marks an instance admin sender", async () => {
      const app = await createApp({ ...boardActor, source: "session", isInstanceAdmin: true });
      await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages`).send({ body: "Do the thing" }),
      );
      await new Promise((r) => setImmediate(r));
      expect(mockDispatchOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({ authorIsInstanceAdmin: true }),
      );
    });

    // AgentDash (review #1000): the CoS reply lands in the shared inbox every
    // member reads, so its workspace facts are built for the least-privileged
    // member — the sender's memberships never reach the dispatcher, or an
    // admin's question could leak restricted projects into a shared reply.
    it("does not pass the sender's memberships to the dispatcher", async () => {
      const memberships = [{ companyId, membershipRole: "admin", status: "active" }];
      const app = await createApp({ ...boardActor, source: "session", memberships });
      await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages`).send({ body: "What is everyone working on?" }),
      );
      await new Promise((r) => setImmediate(r));
      expect(mockDispatchOnMessage).toHaveBeenCalledWith(
        expect.not.objectContaining({ authorMemberships: expect.anything() }),
      );
    });
  });

  // AgentDash (scan 3, lane G): only the requester confirms a CoS task card.
  describe("POST /:id/task-proposals/:messageId/confirm and /dismiss", () => {
    const cardId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    it("confirms with the caller's own identity and visibility", async () => {
      mockCosIssueAction.confirmProposal.mockResolvedValue({
        ok: true,
        payload: { status: "created" },
        created: { issueId: "i1", identifier: "ACM-1", title: "T", assigneeName: "Ellie", status: "todo" },
      });
      const app = await createApp({ ...boardActor, source: "session", isInstanceAdmin: false });
      const res = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/task-proposals/${cardId}/confirm`).send({}),
      );
      expect(res.status).toBe(201);
      expect(res.body.issue).toMatchObject({ issueId: "i1", identifier: "ACM-1" });
      expect(mockCosIssueAction.confirmProposal).toHaveBeenCalledWith({
        companyId,
        conversationId,
        cardMessageId: cardId,
        start: false,
        actor: { userId, source: "session", isInstanceAdmin: false, visibleAgentIds: new Set(["agent-visible"]) },
      });
    });

    // Scan 4, lane N: "Create and start" asks for the work to start now.
    it("passes start only when the body says start: true", async () => {
      mockCosIssueAction.confirmProposal.mockResolvedValue({
        ok: true,
        payload: { status: "created" },
        created: { issueId: "i1", identifier: "ACM-1", title: "T", assigneeName: "Ellie", status: "todo" },
      });
      const app = await createApp(boardActor);
      await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/task-proposals/${cardId}/confirm`).send({ start: true }),
      );
      expect(mockCosIssueAction.confirmProposal).toHaveBeenLastCalledWith(expect.objectContaining({ start: true }));
      await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/task-proposals/${cardId}/confirm`).send({ start: "yes" }),
      );
      expect(mockCosIssueAction.confirmProposal).toHaveBeenLastCalledWith(expect.objectContaining({ start: false }));
    });

    // B -> A: founder A tries to confirm a card that answered member B.
    it("answers 403 with the polite note when the caller is not the requester", async () => {
      mockCosIssueAction.confirmProposal.mockResolvedValue({
        ok: false,
        code: "forbidden",
        note: "Only the person who asked for this task can confirm it.",
      });
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/task-proposals/${cardId}/confirm`).send({}),
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only the person who asked for this task can confirm it.", code: "forbidden" });
    });

    it("answers 409 for a card that was already handled", async () => {
      mockCosIssueAction.confirmProposal.mockResolvedValue({ ok: false, code: "conflict", note: "already" });
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/task-proposals/${cardId}/confirm`).send({}),
      );
      expect(res.status).toBe(409);
    });

    it("dismisses for the requester", async () => {
      mockCosIssueAction.dismissProposal.mockResolvedValue({ ok: true, payload: { status: "dismissed" } });
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/task-proposals/${cardId}/dismiss`).send({}),
      );
      expect(res.status).toBe(200);
      expect(mockCosIssueAction.dismissProposal).toHaveBeenCalledWith({
        companyId,
        conversationId,
        cardMessageId: cardId,
        actor: { userId },
      });
    });

    it("rejects anonymous callers and other companies", async () => {
      const anon = await createApp(noActor);
      const res = await requestApp(anon, (base) =>
        request(base).post(`/api/conversations/${conversationId}/task-proposals/${cardId}/confirm`).send({}),
      );
      expect(res.status).toBe(401);
      const outsider = await createApp({ ...boardActor, companyId: "ffffffff-ffff-4fff-8fff-ffffffffffff", companyIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"] });
      const res2 = await requestApp(outsider, (base) =>
        request(base).post(`/api/conversations/${conversationId}/task-proposals/${cardId}/confirm`).send({}),
      );
      expect(res2.status).toBe(403);
      expect(mockCosIssueAction.confirmProposal).not.toHaveBeenCalled();
    });
  });

  describe("GET /companies/:companyId/inbox", () => {
    it("returns the existing company inbox conversation", async () => {
      mockConversationService.findByCompany.mockResolvedValue({
        id: conversationId,
        companyId,
        userId,
        title: "Company Inbox",
        status: "active",
      });
      const app = await createApp(boardActor);

      const res = await requestApp(app, (base) =>
        request(base).get(`/api/conversations/companies/${companyId}/inbox`),
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: conversationId, title: "Company Inbox" });
      expect(mockConversationService.create).not.toHaveBeenCalled();
      expect(mockConversationService.addParticipant).not.toHaveBeenCalled();
      expect(mockConversationService.findByCompany).toHaveBeenCalledWith(companyId, { title: "Company Inbox" });
    });

    it("creates a company inbox conversation when no titled inbox exists", async () => {
      mockConversationService.findByCompany.mockResolvedValue(null);
      mockConversationService.create.mockResolvedValue({
        id: conversationId,
        companyId,
        userId,
        title: "Company Inbox",
        status: "active",
      });
      const app = await createApp(boardActor);

      const res = await requestApp(app, (base) =>
        request(base).get(`/api/conversations/companies/${companyId}/inbox`),
      );

      expect(res.status).toBe(200);
      expect(mockConversationService.create).toHaveBeenCalledWith({
        companyId,
        userId,
        title: "Company Inbox",
      });
      expect(mockConversationService.findByCompany).toHaveBeenCalledWith(companyId, { title: "Company Inbox" });
      expect(mockConversationService.addParticipant).toHaveBeenCalledWith(conversationId, userId, "owner");
    });

    // AgentDash (first-session test, Lane A item 4): a fresh company's Ask
    // page used to open on an empty conversation.
    it("opens a fresh company's new inbox with a CoS greeting", async () => {
      mockConversationService.findByCompany.mockResolvedValue(null);
      mockConversationService.create.mockResolvedValue({ id: conversationId, companyId, userId, title: "Company Inbox", status: "active" });
      mockAgentService.list.mockResolvedValue([{ id: "cos-1", role: "chief_of_staff", name: "Chief of Staff" }]);
      const app = await createApp(boardActor);

      const res = await requestApp(app, (base) =>
        request(base).get(`/api/conversations/companies/${companyId}/inbox`),
      );

      expect(res.status).toBe(200);
      expect(mockConversationService.postMessage).toHaveBeenCalledTimes(1);
      expect(mockConversationService.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId,
          authorKind: "agent",
          authorId: "cos-1",
          companyId,
          body: expect.stringContaining("I'm your Chief of Staff at Acme Labs"),
        }),
      );
    });

    it("only greets a company that has never had a conversation and never hired", async () => {
      mockConversationService.findByCompany.mockResolvedValue(null);
      mockConversationService.create.mockResolvedValue({ id: conversationId, companyId, userId, title: "Company Inbox", status: "active" });
      mockAgentService.list.mockResolvedValue([{ id: "cos-1", role: "chief_of_staff", name: "Chief of Staff" }]);
      const app = await createApp(boardActor);

      await requestApp(app, (base) => request(base).get(`/api/conversations/companies/${companyId}/inbox`));

      // Terminated hires count as hires.
      expect(mockAgentService.list).toHaveBeenCalledWith(companyId, { includeTerminated: true });
      // The check for an earlier conversation is untitled (any CoS thread).
      expect(mockConversationService.findByCompany).toHaveBeenCalledWith(companyId);
    });

    // Review of #953: a founder who already ran the /cos interview has an
    // earlier conversation; their new inbox must not restart the interview.
    it("does not greet when the company already has a CoS conversation", async () => {
      mockConversationService.findByCompany.mockImplementation(async (_companyId: string, opts?: { title?: string }) =>
        opts?.title ? null : { id: "bootstrap-conv", companyId, userId, title: null, status: "active" },
      );
      mockConversationService.create.mockResolvedValue({ id: conversationId, companyId, userId, title: "Company Inbox", status: "active" });
      mockAgentService.list.mockResolvedValue([{ id: "cos-1", role: "chief_of_staff", name: "Chief of Staff" }]);
      const app = await createApp(boardActor);

      const res = await requestApp(app, (base) =>
        request(base).get(`/api/conversations/companies/${companyId}/inbox`),
      );

      expect(res.status).toBe(200);
      expect(mockConversationService.create).toHaveBeenCalled();
      expect(mockConversationService.postMessage).not.toHaveBeenCalled();
    });

    it("does not greet when a past hire was terminated", async () => {
      mockConversationService.findByCompany.mockResolvedValue(null);
      mockConversationService.create.mockResolvedValue({ id: conversationId, companyId, userId, title: "Company Inbox", status: "active" });
      mockAgentService.list.mockImplementation(async (_companyId: string, opts?: { includeTerminated?: boolean }) => [
        { id: "cos-1", role: "chief_of_staff", name: "Chief of Staff", status: "idle" },
        ...(opts?.includeTerminated ? [{ id: "old-1", role: "researcher", name: "Rae", status: "terminated" }] : []),
      ]);
      const app = await createApp(boardActor);

      await requestApp(app, (base) => request(base).get(`/api/conversations/companies/${companyId}/inbox`));

      expect(mockConversationService.postMessage).not.toHaveBeenCalled();
    });

    it("does not greet when the company already has a team", async () => {
      mockConversationService.findByCompany.mockResolvedValue(null);
      mockConversationService.create.mockResolvedValue({ id: conversationId, companyId, userId, title: "Company Inbox", status: "active" });
      mockAgentService.list.mockResolvedValue([
        { id: "cos-1", role: "chief_of_staff", name: "Chief of Staff" },
        { id: "eng-1", role: "engineer", name: "Ellie" },
      ]);
      const app = await createApp(boardActor);

      const res = await requestApp(app, (base) =>
        request(base).get(`/api/conversations/companies/${companyId}/inbox`),
      );

      expect(res.status).toBe(200);
      expect(mockConversationService.postMessage).not.toHaveBeenCalled();
    });

    it("rejects another company's inbox", async () => {
      const app = await createApp({ ...boardActor, companyIds: ["other-company"] });

      const res = await requestApp(app, (base) =>
        request(base).get(`/api/conversations/companies/${companyId}/inbox`),
      );

      expect(res.status).toBe(403);
    });
  });

  describe("POST /:id/messages", () => {
    it("stores the user message and returns 201", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base)
          .post(`/api/conversations/${conversationId}/messages`)
          .send({ body: "Hello world", companyId }),
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: baseMessage.id, content: "Hello world" });
      expect(mockConversationService.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId,
          body: "Hello world",
          authorKind: "user",
          authorId: userId,
        }),
      );
    });

    it("fires dispatch after posting message", async () => {
      const app = await createApp(boardActor);
      await requestApp(app, (base) =>
        request(base)
          .post(`/api/conversations/${conversationId}/messages`)
          .send({ body: "Hello world", companyId }),
      );
      // Allow the fire-and-forget to settle
      await new Promise((r) => setImmediate(r));
      expect(mockDispatchOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId,
          body: "Hello world",
        }),
      );
    });

    it("rejects unauthenticated requests with 401", async () => {
      const app = await createApp(noActor);
      const res = await requestApp(app, (base) =>
        request(base)
          .post(`/api/conversations/${conversationId}/messages`)
          .send({ body: "Hello world" }),
      );
      expect(res.status).toBe(401);
    });

    it("rejects empty body with 400", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base)
          .post(`/api/conversations/${conversationId}/messages`)
          .send({ body: "   " }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects missing body field with 400", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base)
          .post(`/api/conversations/${conversationId}/messages`)
          .send({}),
      );
      expect(res.status).toBe(400);
    });

    // A Coding Plan that lapses stays pinned; a no-balance failure (Z.AI code
    // 1113, not a rate limit) re-probes once and, if the pin moved, dispatches again.
    describe("no-balance failures", () => {
      const noBalance = new Error(
        'Adapter "hermes_local" failed ([dispatch-llm] hermes exited 1: HTTP 429: Insufficient balance or no resource package) and the adapter/model invariant refuses to retry.',
      );
      const send = async () => {
        const app = await createApp(boardActor);
        await requestApp(app, (base) =>
          request(base).post(`/api/conversations/${conversationId}/messages`).send({ body: "Hello world" }),
        );
      };

      it("re-pins the endpoint and dispatches once more before showing an error", async () => {
        const repinEndpoint = vi.fn().mockResolvedValue({ repinned: true });
        vi.doMock("../services/hermes-provider-reconcile.js", () => ({ hermesProviderReconciler: () => ({ repinEndpoint }) }));
        mockDispatchOnMessage.mockRejectedValueOnce(noBalance).mockResolvedValueOnce(undefined);
        await send();
        await vi.waitFor(() => expect(mockDispatchOnMessage).toHaveBeenCalledTimes(2));
        expect(repinEndpoint).toHaveBeenCalledTimes(1);
        // Only the person's own message was posted: no error card.
        expect(mockConversationService.postMessage).toHaveBeenCalledTimes(1);
      });

      it("shows the error card when the pin did not move, and does not loop", async () => {
        const repinEndpoint = vi.fn().mockResolvedValue({ repinned: false, skipped: "rate_limited" });
        vi.doMock("../services/hermes-provider-reconcile.js", () => ({ hermesProviderReconciler: () => ({ repinEndpoint }) }));
        mockAgentService.list.mockResolvedValue([{ id: "cos-agent", role: "chief_of_staff" }]);
        mockDispatchOnMessage.mockRejectedValue(noBalance);
        await send();
        await vi.waitFor(() => expect(mockConversationService.postMessage).toHaveBeenCalledTimes(2));
        expect(mockDispatchOnMessage).toHaveBeenCalledTimes(1);
        expect(mockConversationService.postMessage.mock.calls[1]![0]).toMatchObject({
          cardKind: "cos_dispatch_error_v1",
          cardPayload: { hint: expect.stringContaining("re-save") },
        });
      });

      it("does not re-pin for a rate limit", async () => {
        const repinEndpoint = vi.fn();
        vi.doMock("../services/hermes-provider-reconcile.js", () => ({ hermesProviderReconciler: () => ({ repinEndpoint }) }));
        mockAgentService.list.mockResolvedValue([{ id: "cos-agent", role: "chief_of_staff" }]);
        mockDispatchOnMessage.mockRejectedValue(new Error("hermes exited 1: HTTP 429: Rate limit reached (code 1302)"));
        await send();
        await vi.waitFor(() => expect(mockConversationService.postMessage).toHaveBeenCalledTimes(2));
        expect(repinEndpoint).not.toHaveBeenCalled();
        expect(mockConversationService.postMessage.mock.calls[1]![0].cardPayload.hint).toMatch(/limiting requests/);
      });
    });

    // Regression (P0, v2026.1002.0): a failed CoS reply used to end in a log
    // line only, and the chat sat silently on the person's message.
    it("posts a 'CoS couldn't reply' card with a Retry target when dispatch fails", async () => {
      mockAgentService.list.mockResolvedValue([{ id: "cos-agent", role: "chief_of_staff" }]);
      mockDispatchOnMessage.mockRejectedValue(
        new Error(
          'Adapter "hermes_local" failed ([dispatch-llm] /usr/local/bin/hermes exited 1: session_id: 20261002_085216_21b463) ' +
            "and the adapter/model invariant refuses to retry on a different adapter or model. Fix or reconfigure the adapter.",
        ),
      );
      const app = await createApp(boardActor);
      await requestApp(app, (base) =>
        request(base)
          .post(`/api/conversations/${conversationId}/messages`)
          .send({ body: "Hello world" }),
      );
      await vi.waitFor(() => expect(mockConversationService.postMessage).toHaveBeenCalledTimes(2));
      const failure = mockConversationService.postMessage.mock.calls[1]![0];
      expect(failure).toMatchObject({
        conversationId,
        authorKind: "agent",
        authorId: "cos-agent",
        companyId,
        cardKind: "cos_dispatch_error_v1",
        cardPayload: { retryMessageId: baseMessage.id },
      });
      expect(failure.body).toBe(
        "CoS couldn't reply: hermes_local: hermes exited 1: session_id: 20261002_085216_21b463. Retry",
      );
    });
  });

  describe("POST /:id/messages/:messageId/retry", () => {
    it("re-dispatches the person's message without posting it again", async () => {
      mockConversationService.getMessage.mockResolvedValue(baseMessage);
      conversationEndsOnFailedReply(mockConversationService);
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
      );
      expect(res.status).toBe(202);
      await vi.waitFor(() =>
        expect(mockDispatchOnMessage).toHaveBeenCalledWith(
          expect.objectContaining({ messageId: baseMessage.id, conversationId, companyId, body: "Hello world" }),
        ),
      );
      expect(mockConversationService.getMessage).toHaveBeenCalledWith(conversationId, baseMessage.id);
      expect(mockConversationService.postMessage).not.toHaveBeenCalled();
    });

    // AgentDash (scan 3, lane G): a retried message is answered with its
    // author's identity, so a task the CoS suggests is checked against them.
    it("re-dispatches with the author's sign-in and agent visibility (error-card retry)", async () => {
      mockConversationService.getMessage.mockResolvedValue(baseMessage);
      conversationEndsOnFailedReply(mockConversationService);
      const app = await createApp({ ...boardActor, source: "session", isInstanceAdmin: false });
      await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
      );
      await vi.waitFor(() => expect(mockDispatchOnMessage).toHaveBeenCalled());
      const input = mockDispatchOnMessage.mock.calls[0]![0];
      expect(input).toMatchObject({ messageId: baseMessage.id, authorUserId: userId, authorSource: "session", authorIsInstanceAdmin: false });
      await expect(input.authorVisibleAgentIds()).resolves.toEqual(new Set(["agent-visible"]));
    });

    it("re-dispatches a stalled message with the author's identity too", async () => {
      const old = { ...baseMessage, createdAt: new Date(Date.now() - 200_000) };
      mockConversationService.getMessage.mockResolvedValue(old);
      mockConversationService.latestByRole.mockImplementation(async (_id: string, role: string) => (role === "agent" ? null : old));
      const app = await createApp({ ...boardActor, source: "session", isInstanceAdmin: true });
      const res = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
      );
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(mockDispatchOnMessage).toHaveBeenCalled());
      expect(mockDispatchOnMessage.mock.calls[0]![0]).toMatchObject({
        authorUserId: userId,
        authorSource: "session",
        authorIsInstanceAdmin: true,
      });
    });

    it("refuses to retry an agent message or one from another conversation", async () => {
      const app = await createApp(boardActor);
      mockConversationService.getMessage.mockResolvedValue({ ...baseMessage, role: "agent" });
      const agentMsg = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
      );
      expect(agentMsg.status).toBe(404);
      mockConversationService.getMessage.mockResolvedValue(null);
      const foreign = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
      );
      expect(foreign.status).toBe(404);
      expect(mockDispatchOnMessage).not.toHaveBeenCalled();
    });

    it("answers 409 unless the newest agent message is the failure card for exactly this message", async () => {
      mockConversationService.getMessage.mockResolvedValue(baseMessage);
      const app = await createApp(boardActor);
      const retry = () =>
        requestApp(app, (base) =>
          request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
        );
      // The CoS did reply (newest agent message is a normal reply).
      mockConversationService.latestByRole.mockImplementation(async (_id: string, role: string) =>
        role === "agent" ? { ...failedReplyCard, cardKind: null, cardPayload: null } : baseMessage,
      );
      expect((await retry()).status).toBe(409);
      // The card belongs to another message.
      mockConversationService.latestByRole.mockImplementation(async (_id: string, role: string) =>
        role === "agent" ? { ...failedReplyCard, cardPayload: { retryMessageId: "someone-else" } } : baseMessage,
      );
      expect((await retry()).status).toBe(409);
      // The person has since sent a newer message.
      mockConversationService.latestByRole.mockImplementation(async (_id: string, role: string) =>
        role === "agent" ? failedReplyCard : { ...baseMessage, id: "newer" },
      );
      expect((await retry()).status).toBe(409);
      expect(mockDispatchOnMessage).not.toHaveBeenCalled();
    });

    // The "CoS hasn't replied" Retry: a dispatch that hung or died leaves no error card.
    it("accepts a Retry for a message nothing replied to once it is overdue, and refuses it while recent or answered", async () => {
      const app = await createApp(boardActor);
      const retry = () =>
        requestApp(app, (base) =>
          request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
        );
      const old = { ...baseMessage, createdAt: new Date(Date.now() - 200_000) };
      mockConversationService.getMessage.mockResolvedValue(old);
      mockConversationService.latestByRole.mockImplementation(async (_id: string, role: string) => (role === "agent" ? null : old));
      expect((await retry()).status).toBe(202);
      await vi.waitFor(() => expect(mockDispatchOnMessage).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Too recent: the reply may still be on its way.
      const recent = { ...baseMessage, createdAt: new Date(Date.now() - 5_000) };
      mockConversationService.getMessage.mockResolvedValue(recent);
      mockConversationService.latestByRole.mockImplementation(async (_id: string, role: string) => (role === "agent" ? null : recent));
      expect((await retry()).status).toBe(409);

      // Answered: an agent message came after it.
      mockConversationService.getMessage.mockResolvedValue(old);
      mockConversationService.latestByRole.mockImplementation(async (_id: string, role: string) =>
        role === "agent" ? { ...failedReplyCard, cardKind: null, cardPayload: null, createdAt: new Date() } : old,
      );
      expect((await retry()).status).toBe(409);
      expect(mockDispatchOnMessage).toHaveBeenCalledTimes(1);
    });

    it("lets only one retry per conversation run at a time (two tabs)", async () => {
      mockConversationService.getMessage.mockResolvedValue(baseMessage);
      conversationEndsOnFailedReply(mockConversationService);
      let release: () => void = () => undefined;
      mockDispatchOnMessage.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
      const app = await createApp(boardActor);
      const retry = () =>
        requestApp(app, (base) =>
          request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
        );
      expect((await retry()).status).toBe(202);
      expect((await retry()).status).toBe(409);
      release();
      await vi.waitFor(async () => expect((await retry()).status).toBe(202));
      release();
      expect(mockDispatchOnMessage).toHaveBeenCalledTimes(2);
    });

    it("refuses a teammate retrying someone else's message, and a legacy message with no recorded author", async () => {
      const app = await createApp(boardActor);
      mockConversationService.getMessage.mockResolvedValue({ ...baseMessage, authorUserId: "someone-else" });
      const other = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
      );
      expect(other.status).toBe(403);
      mockConversationService.getMessage.mockResolvedValue({ ...baseMessage, authorUserId: null });
      const legacy = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
      );
      expect(legacy.status).toBe(403);
      expect(mockDispatchOnMessage).not.toHaveBeenCalled();
    });

    it("keeps the company-access check on retry", async () => {
      mockConversationService.getMessage.mockResolvedValue(baseMessage);
      conversationEndsOnFailedReply(mockConversationService);
      const app = await createApp({ ...boardActor, companyIds: ["other-company"] });
      const res = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
      );
      expect(res.status).toBe(403);
      expect(mockDispatchOnMessage).not.toHaveBeenCalled();
    });

    it("rejects anonymous callers", async () => {
      const app = await createApp(noActor);
      const res = await requestApp(app, (base) =>
        request(base).post(`/api/conversations/${conversationId}/messages/${baseMessage.id}/retry`).send({}),
      );
      expect(res.status).toBe(401);
    });
  });

  describe("GET /:id/messages", () => {
    it("returns paginated message rows", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base).get(`/api/conversations/${conversationId}/messages`),
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(mockConversationService.paginate).toHaveBeenCalledWith(
        conversationId,
        expect.objectContaining({ limit: 50 }),
      );
    });

    it("passes before and limit query params", async () => {
      const app = await createApp(boardActor);
      await requestApp(app, (base) =>
        request(base).get(
          `/api/conversations/${conversationId}/messages?before=${baseMessage.id}&limit=10`,
        ),
      );
      expect(mockConversationService.paginate).toHaveBeenCalledWith(
        conversationId,
        expect.objectContaining({ before: baseMessage.id, limit: 10 }),
      );
    });
  });

  describe("PATCH /:id/read", () => {
    it("updates the read pointer and returns 204", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base)
          .patch(`/api/conversations/${conversationId}/read`)
          .send({ lastReadMessageId: baseMessage.id }),
      );
      expect(res.status).toBe(204);
      expect(mockConversationService.setReadPointer).toHaveBeenCalledWith(
        conversationId,
        userId,
        baseMessage.id,
        expect.any(String),
      );
    });

    it("rejects unauthenticated requests with 401", async () => {
      const app = await createApp(noActor);
      const res = await requestApp(app, (base) =>
        request(base)
          .patch(`/api/conversations/${conversationId}/read`)
          .send({ lastReadMessageId: baseMessage.id }),
      );
      expect(res.status).toBe(401);
    });

    it("rejects missing lastReadMessageId with 400", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base)
          .patch(`/api/conversations/${conversationId}/read`)
          .send({}),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("GET /:id/participants", () => {
    it("returns the participant list", async () => {
      const participants = [
        { conversationId, userId, role: "owner", lastReadMessageId: null },
      ];
      mockConversationService.listParticipants.mockResolvedValue(participants);

      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base).get(`/api/conversations/${conversationId}/participants`),
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ userId });
    });
  });
  describe("company isolation on /:id routes", () => {
    const otherCompanyId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const outsider = { ...boardActor, companyId: otherCompanyId, companyIds: [otherCompanyId] };
    const outsiderAgent = { type: "agent", agentId: "agent-1", companyId: otherCompanyId };

    const routes: Array<{
      name: string;
      send: (base: string) => request.Test;
      service: keyof typeof mockConversationService;
    }> = [
      {
        name: "POST /:id/messages",
        send: (base) =>
          request(base)
            .post(`/api/conversations/${conversationId}/messages`)
            .send({ body: "hi", companyId: otherCompanyId }),
        service: "postMessage",
      },
      {
        name: "GET /:id/messages",
        send: (base) => request(base).get(`/api/conversations/${conversationId}/messages`),
        service: "paginate",
      },
      {
        name: "PATCH /:id/read",
        send: (base) =>
          request(base)
            .patch(`/api/conversations/${conversationId}/read`)
            .send({ lastReadMessageId: baseMessage.id, companyId: otherCompanyId }),
        service: "setReadPointer",
      },
      {
        name: "GET /:id/participants",
        send: (base) => request(base).get(`/api/conversations/${conversationId}/participants`),
        service: "listParticipants",
      },
    ];

    for (const route of routes) {
      it(`${route.name} rejects a signed-in user from another company`, async () => {
        const app = await createApp(outsider);
        const res = await requestApp(app, route.send);
        expect(res.status).toBe(403);
        expect(mockConversationService[route.service]).not.toHaveBeenCalled();
      });

      it(`${route.name} rejects anonymous callers before looking the conversation up`, async () => {
        const app = await createApp(noActor);
        const res = await requestApp(app, route.send);
        expect(res.status).toBe(401);
        expect(mockConversationService.getById).not.toHaveBeenCalled();
        expect(mockConversationService[route.service]).not.toHaveBeenCalled();
      });

      it(`${route.name} returns 404 for an unknown conversation`, async () => {
        mockConversationService.getById.mockResolvedValue(null);
        const app = await createApp(boardActor);
        const res = await requestApp(app, route.send);
        expect(res.status).toBe(404);
        expect(mockConversationService[route.service]).not.toHaveBeenCalled();
      });
    }

    it("GET /:id/messages rejects an agent key from another company", async () => {
      const app = await createApp(outsiderAgent);
      const res = await requestApp(app, (base) =>
        request(base).get(`/api/conversations/${conversationId}/messages`),
      );
      expect(res.status).toBe(403);
      expect(mockConversationService.paginate).not.toHaveBeenCalled();
    });

    it("GET /:id/messages allows an agent key from the conversation's company", async () => {
      const app = await createApp({ ...outsiderAgent, companyId });
      const res = await requestApp(app, (base) =>
        request(base).get(`/api/conversations/${conversationId}/messages`),
      );
      expect(res.status).toBe(200);
    });

    it("POST /:id/messages broadcasts on the conversation's company, not a body-supplied one", async () => {
      const app = await createApp({ ...boardActor, companyIds: [companyId, otherCompanyId] });
      const res = await requestApp(app, (base) =>
        request(base)
          .post(`/api/conversations/${conversationId}/messages`)
          .send({ body: "hi", companyId: otherCompanyId }),
      );
      expect(res.status).toBe(201);
      expect(mockConversationService.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ companyId }),
      );
      await new Promise((r) => setImmediate(r));
      expect(mockDispatchOnMessage).toHaveBeenCalledWith(expect.objectContaining({ companyId }));
    });

    it("PATCH /:id/read rejects a message id from another conversation", async () => {
      mockConversationService.setReadPointer.mockResolvedValue(false);
      const app = await createApp(boardActor);
      const res = await requestApp(app, (base) =>
        request(base)
          .patch(`/api/conversations/${conversationId}/read`)
          .send({ lastReadMessageId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
      );
      expect(res.status).toBe(400);
    });

    it("PATCH /:id/read emits on the conversation's company, not a body-supplied one", async () => {
      const app = await createApp({ ...boardActor, companyIds: [companyId, otherCompanyId] });
      const res = await requestApp(app, (base) =>
        request(base)
          .patch(`/api/conversations/${conversationId}/read`)
          .send({ lastReadMessageId: baseMessage.id, companyId: otherCompanyId }),
      );
      expect(res.status).toBe(204);
      expect(mockConversationService.setReadPointer).toHaveBeenCalledWith(
        conversationId,
        userId,
        baseMessage.id,
        companyId,
      );
    });
  });
});
