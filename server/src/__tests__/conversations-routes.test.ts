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
    conversationService: () => mockConversationService,
    conversationDispatch: mockConversationDispatch,
    agentService: () => mockAgentService,
    cosReplier: vi.fn(() => ({ reply: vi.fn() })),
    agentSummoner: vi.fn(() => ({ summon: vi.fn() })),
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
    mockConversationService.postMessage.mockResolvedValue(baseMessage);
    mockConversationService.paginate.mockResolvedValue([baseMessage]);
    mockConversationService.listParticipants.mockResolvedValue([]);
    mockConversationService.setReadPointer.mockResolvedValue(undefined);
    mockAgentService.list.mockResolvedValue([]);
    mockDispatchOnMessage.mockResolvedValue(undefined);
    mockConversationDispatch.mockReturnValue({ onMessage: mockDispatchOnMessage });
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
});
