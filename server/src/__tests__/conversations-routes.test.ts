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
  content: "Hello world",
  cardKind: null,
  cardPayload: null,
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
};

const mockConversationService = vi.hoisted(() => ({
  getById: vi.fn(),
  postMessage: vi.fn(),
  paginate: vi.fn(),
  setReadPointer: vi.fn(),
  listParticipants: vi.fn(),
  findByCompany: vi.fn(),
  create: vi.fn(),
  addParticipant: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  getById: vi.fn(),
}));

const mockDispatchOnMessage = vi.hoisted(() => vi.fn());

const mockConversationDispatch = vi.hoisted(() => vi.fn(() => ({
  onMessage: mockDispatchOnMessage,
})));

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
    cosReplier: vi.fn(() => ({ reply: vi.fn() })),
  }));

  vi.doMock("../services/agent-summoner.js", () => ({
    agentSummoner: vi.fn(() => ({ summon: vi.fn() })),
  }));

  vi.doMock("../services/index.js", () => ({
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    conversationService: () => mockConversationService,
    conversationDispatch: mockConversationDispatch,
    agentService: () => mockAgentService,
    cosReplier: vi.fn(() => ({ reply: vi.fn() })),
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
