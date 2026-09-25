import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assistantConversationParticipants,
  assistantConversations,
  assistantMessages,
  authUsers,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { conversationService } from "../services/conversations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres conversation service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TEST_USER_ID = "test-user-1";

async function insertTestUser(db: ReturnType<typeof createDb>) {
  await db.insert(authUsers).values({
    id: TEST_USER_ID,
    name: "Test User",
    email: "test@example.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
}

describeEmbeddedPostgres("conversationService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let service!: ReturnType<typeof conversationService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-conversations-service-");
    db = createDb(tempDb.connectionString);
    service = conversationService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(assistantConversationParticipants);
    await db.delete(assistantMessages);
    await db.delete(assistantConversations);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("findByCompany returns null for a fresh company", async () => {
    const result = await service.findByCompany(randomUUID());
    expect(result).toBeNull();
  });

  it("findByCompany returns the conversation after create", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    await service.create({ companyId, userId: TEST_USER_ID, title: "Main chat" });
    const result = await service.findByCompany(companyId);
    expect(result).not.toBeNull();
    expect(result?.companyId).toBe(companyId);
  });

  it("findByCompany can filter by title", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    await service.create({ companyId, userId: TEST_USER_ID, title: "Welcome chat" });
    const inbox = await service.create({ companyId, userId: TEST_USER_ID, title: "Company Inbox" });

    const result = await service.findByCompany(companyId, { title: "Company Inbox" });

    expect(result?.id).toBe(inbox.id);
    expect(result?.title).toBe("Company Inbox");
  });

  it("addParticipant is idempotent", async () => {
    await insertTestUser(db);
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    const conversation = await service.create({ companyId, userId: TEST_USER_ID });
    await service.addParticipant(conversation.id, TEST_USER_ID, "owner");
    // Second call should not throw (idempotent)
    await service.addParticipant(conversation.id, TEST_USER_ID, "owner");
    const participants = await service.listParticipants(conversation.id);
    expect(participants).toHaveLength(1);
  });

  it("setReadPointer updates the row", async () => {
    await insertTestUser(db);
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    const conversation = await service.create({ companyId, userId: TEST_USER_ID });
    await service.addParticipant(conversation.id, TEST_USER_ID, "owner");
    const msg = await service.postMessage({
      conversationId: conversation.id,
      authorKind: "user",
      authorId: TEST_USER_ID,
      body: "hello",
    });
    await service.setReadPointer(conversation.id, TEST_USER_ID, msg.id);
    const participants = await service.listParticipants(conversation.id);
    expect(participants[0]?.lastReadMessageId).toBe(msg.id);
  });

  it("setReadPointer refuses a message from a foreign conversation", async () => {
    await insertTestUser(db);
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    const conversation = await service.create({ companyId, userId: TEST_USER_ID });
    const other = await service.create({ companyId, userId: TEST_USER_ID });
    await service.addParticipant(conversation.id, TEST_USER_ID, "owner");
    const own = await service.postMessage({
      conversationId: conversation.id,
      authorKind: "user",
      authorId: TEST_USER_ID,
      body: "mine",
    });
    await service.setReadPointer(conversation.id, TEST_USER_ID, own.id);
    const foreign = await service.postMessage({
      conversationId: other.id,
      authorKind: "user",
      authorId: TEST_USER_ID,
      body: "elsewhere",
    });

    const ok = await service.setReadPointer(conversation.id, TEST_USER_ID, foreign.id);

    expect(ok).toBe(false);
    const participants = await service.listParticipants(conversation.id);
    expect(participants[0]?.lastReadMessageId).toBe(own.id);
  });

  it("paginate ignores a cursor from another conversation", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    const conversation = await service.create({ companyId, userId: TEST_USER_ID });
    const other = await service.create({ companyId, userId: TEST_USER_ID });
    const foreignCursor = await service.postMessage({ conversationId: other.id, authorKind: "user", authorId: "u1", body: "early foreign" });
    await new Promise((r) => setTimeout(r, 5));
    await service.postMessage({ conversationId: conversation.id, authorKind: "user", authorId: "u1", body: "a" });
    await new Promise((r) => setTimeout(r, 5));
    await service.postMessage({ conversationId: conversation.id, authorKind: "user", authorId: "u1", body: "b" });

    // An in-conversation cursor pages normally.
    const page = await service.paginate(conversation.id, { limit: 10 });
    const older = await service.paginate(conversation.id, { limit: 10, before: page[0]!.id });
    expect(older.map((m) => m.content)).toEqual(["a"]);

    // A foreign message id is not resolved as a cursor: it neither leaks the
    // foreign row nor steers the page window (the foreign row is older than
    // every row here, so honoring it would return nothing).
    const scoped = await service.paginate(conversation.id, { limit: 10, before: foreignCursor.id });
    expect(scoped.map((m) => m.content)).toEqual(["b", "a"]);
    expect(scoped.every((m) => m.conversationId === conversation.id)).toBe(true);
  });

  it("postMessage persists card_kind and card_payload when provided", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    const conversation = await service.create({ companyId, userId: TEST_USER_ID });
    const msg = await service.postMessage({
      conversationId: conversation.id,
      authorKind: "agent",
      authorId: "agent-1",
      body: "Here is a proposal",
      cardKind: "proposal_card_v1",
      cardPayload: { name: "Reese", role: "SDR", oneLineOkr: "Close 10 deals", rationale: "Strong pipeline" },
    });
    expect(msg.cardKind).toBe("proposal_card_v1");
    expect(msg.cardPayload).toMatchObject({ name: "Reese" });
  });

  it("paginate returns rows in descending order", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    const conversation = await service.create({ companyId, userId: TEST_USER_ID });
    await service.postMessage({ conversationId: conversation.id, authorKind: "user", authorId: "u1", body: "first" });
    await service.postMessage({ conversationId: conversation.id, authorKind: "user", authorId: "u1", body: "second" });
    await service.postMessage({ conversationId: conversation.id, authorKind: "user", authorId: "u1", body: "third" });
    const rows = await service.paginate(conversation.id, { limit: 10 });
    expect(rows).toHaveLength(3);
    expect(rows[0]!.content).toBe("third");
    expect(rows[2]!.content).toBe("first");
  });
});

// WS event emission tests — these use a stub DB so they run without embedded postgres.
describe("conversationService WS bus emission", () => {
  const mockEmitMessageCreated = vi.hoisted(() => vi.fn());
  const mockEmitMessageRead = vi.hoisted(() => vi.fn());

  const fakeMessageRow = {
    id: "msg-1",
    conversationId: "conv-1",
    role: "user" as const,
    content: "hello",
    cardKind: null,
    cardPayload: null,
    createdAt: new Date(),
  };

  function buildFakeDb(messageRow = fakeMessageRow, ownedMessageRows: Array<{ id: string }> = [{ id: messageRow.id }]) {
    return {
      // setReadPointer first checks the message belongs to the conversation.
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => ownedMessageRows,
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: async () => [messageRow],
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    } as any;
  }

  beforeAll(() => {
    vi.mock("../realtime/conversation-events.js", () => ({
      emitMessageCreated: mockEmitMessageCreated,
      emitMessageRead: mockEmitMessageRead,
    }));
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("postMessage emits message.created when companyId provided", async () => {
    const { conversationService } = await import("../services/conversations.js");
    const svc = conversationService(buildFakeDb());
    await svc.postMessage({
      conversationId: "conv-1",
      authorKind: "user",
      authorId: "user-1",
      body: "hello",
      companyId: "company-1",
    });
    expect(mockEmitMessageCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msg-1", companyId: "company-1" }),
    );
  });

  it("postMessage does NOT emit when companyId is omitted", async () => {
    mockEmitMessageCreated.mockClear();
    const { conversationService } = await import("../services/conversations.js");
    const svc = conversationService(buildFakeDb());
    await svc.postMessage({
      conversationId: "conv-1",
      authorKind: "user",
      authorId: "user-1",
      body: "hello",
    });
    expect(mockEmitMessageCreated).not.toHaveBeenCalled();
  });

  it("setReadPointer emits message.read when companyId provided", async () => {
    const { conversationService } = await import("../services/conversations.js");
    const svc = conversationService(buildFakeDb());
    await svc.setReadPointer("conv-1", "user-1", "msg-1", "company-1");
    expect(mockEmitMessageRead).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        userId: "user-1",
        lastReadMessageId: "msg-1",
        companyId: "company-1",
      }),
    );
  });

  it("setReadPointer returns false and does not emit when the message is not in the conversation", async () => {
    mockEmitMessageRead.mockClear();
    const { conversationService } = await import("../services/conversations.js");
    const svc = conversationService(buildFakeDb(fakeMessageRow, []));
    const ok = await svc.setReadPointer("conv-1", "user-1", "msg-foreign", "company-1");
    expect(ok).toBe(false);
    expect(mockEmitMessageRead).not.toHaveBeenCalled();
  });
});
