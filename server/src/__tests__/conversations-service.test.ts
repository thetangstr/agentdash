import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
