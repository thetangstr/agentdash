import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
  approvals,
  companies,
  companyMemberships,
  channelCallbackTokens,
  channelPairingChallenges,
  createDb,
  externalChannelEvents,
  humanChannelBindings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { telegramConnectorRoutes } from "../routes/telegram-connector.js";
import { telegramConnectorService } from "../services/telegram-connector.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { humanChannelService } from "../services/human-channels.js";
import { conversationService } from "../services/conversations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const SECRET = "telegram-secret-token";

describeEmbeddedPostgres("telegram connector", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let telegramCalls: Array<{ method: string; body: unknown }>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-telegram-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    telegramCalls = [];
    // Deterministic local double for the Bot API — no network in CI.
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      const method = String(url).split("/").pop() ?? "";
      telegramCalls.push({ method, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({ ok: true, result: {} }) } as never;
    });
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_BOT_TOKEN;
    await db.delete(activityLog);
    await db.delete(channelCallbackTokens);
    await db.delete(channelPairingChallenges);
    await db.delete(externalChannelEvents);
    await db.delete(humanChannelBindings);
    await db.delete(approvals);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const company = await db
      .insert(companies)
      .values({
        name: `TG ${randomUUID()}`,
        issuePrefix: `TG${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: "agentdash_mk",
      })
      .returning()
      .then((rows) => rows[0]!);
    const owner = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "owner",
      })
      .returning()
      .then((rows) => rows[0]!);
    const steward = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
      })
      .returning()
      .then((rows) => rows[0]!);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: steward.principalId,
      assignedByUserId: owner.principalId,
    });
    const binding = await humanChannelService(db).verifyBinding(company.id, {
      provider: "telegram",
      userId: steward.principalId,
      externalUserId: "1",
      externalConversationId: "chat-1",
    });
    const approval = await db
      .insert(approvals)
      .values({
        companyId: company.id,
        type: "request_board_approval",
        requestedByAgentId: agent.id,
        status: "pending",
        payload: { summary: "Ship it" },
      })
      .returning()
      .then((rows) => rows[0]!);
    return { company, owner, steward, agent, binding, approval };
  }

  /**
   * The reply LLM is injected rather than stubbed globally: a unit test that
   * depended on PAPERCLIP_E2E_SKIP_LLM would pass or fail on an env var set
   * elsewhere, and its canned text has nothing to do with this subsystem.
   */
  function createApp(llm?: (input: { messages: Array<{ content: string }> }) => Promise<string>) {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      telegramConnectorRoutes(db, {
        llm: llm ?? (async (input) => `echo:${input.messages.at(-1)?.content ?? ""}`),
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function call(app: express.Express, build: (baseUrl: string) => request.Test) {
    const { createServer } = await import("node:http");
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      return await build(`http://127.0.0.1:${address.port}`);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }

  const webhookPath = "/api/connectors/telegram/webhook";

  it("rejects a webhook with the wrong secret token", async () => {
    await seed();
    const app = createApp();

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", "wrong")
        .send({ update_id: 1, message: { text: "hi", from: { id: 1 }, chat: { id: 1 } } }),
    );

    expect(res.status).toBe(401);
    // Authenticity is checked before any parsing or dispatch.
    expect(await db.select().from(externalChannelEvents)).toHaveLength(0);
  });

  it("rejects a webhook with no secret token header at all", async () => {
    await seed();
    const app = createApp();

    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(webhookPath).send({ update_id: 2 }),
    );

    expect(res.status).toBe(401);
  });

  it("deduplicates update_id so a redelivered callback decides only once", async () => {
    const { company, approval, binding } = await seed();
    const svc = telegramConnectorService(db);
    const token = await svc.issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });

    const update = {
      update_id: 77,
      callback_query: {
        id: "cbq-1",
        from: { id: 1 },
        message: { chat: { id: 1 } },
        data: token,
      },
    };

    const app = createApp();
    const first = await call(app, (baseUrl) =>
      request(baseUrl).post(webhookPath).set("X-Telegram-Bot-Api-Secret-Token", SECRET).send(update),
    );
    const second = await call(app, (baseUrl) =>
      request(baseUrl).post(webhookPath).set("X-Telegram-Bot-Api-Secret-Token", SECRET).send(update),
    );

    // Telegram retries until it gets a 200; a replay must be acknowledged, not errored.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const decisions = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "approval.approved"));
    expect(decisions).toHaveLength(1);
  });

  it("always answers the callback query, including on a replay", async () => {
    const { company, approval, binding } = await seed();
    const svc = telegramConnectorService(db);
    const token = await svc.issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });
    const update = {
      update_id: 78,
      callback_query: { id: "cbq-2", from: { id: 1 }, message: { chat: { id: 1 } }, data: token },
    };

    const app = createApp();
    await call(app, (baseUrl) =>
      request(baseUrl).post(webhookPath).set("X-Telegram-Bot-Api-Secret-Token", SECRET).send(update),
    );
    await call(app, (baseUrl) =>
      request(baseUrl).post(webhookPath).set("X-Telegram-Bot-Api-Secret-Token", SECRET).send(update),
    );

    // Leaving a callback unanswered spins Telegram's client on a loading state.
    const answers = telegramCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps inline keyboard callback data within Telegram's 64-byte limit", async () => {
    const { company, approval, binding } = await seed();
    const svc = telegramConnectorService(db);

    const keyboard = await svc.buildApprovalKeyboard({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      bindingId: binding.id,
    });

    const buttons = keyboard.inline_keyboard.flat();
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      // Opaque: authority must not be reconstructable from the button itself.
      expect(button.callback_data).not.toContain(approval.id);
    }
  });

  it("refuses a callback from a revoked binding", async () => {
    const { company, approval, binding } = await seed();
    const svc = telegramConnectorService(db);
    const token = await svc.issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });
    await humanChannelService(db).revokeBinding(company.id, binding.id, { actorUserId: null });

    const app = createApp();
    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 79,
          callback_query: { id: "cbq-3", from: { id: 1 }, message: { chat: { id: 1 } }, data: token },
        }),
    );

    expect(res.status).toBe(200);
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("pending");
  });

  it("fails a stale callback closed after the approval is resubmitted", async () => {
    const { company, approval, binding } = await seed();
    const svc = telegramConnectorService(db);
    const token = await svc.issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });

    await db.update(approvals).set({ revision: 5 }).where(eq(approvals.id, approval.id));

    const app = createApp();
    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 80,
          callback_query: { id: "cbq-4", from: { id: 1 }, message: { chat: { id: 1 } }, data: token },
        }),
    );

    expect(res.status).toBe(200);
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("pending");
  });

  it("records the decision channel as telegram when a steward approves", async () => {
    const { company, approval, binding, steward } = await seed();
    const svc = telegramConnectorService(db);
    const token = await svc.issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });

    const app = createApp();
    await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 81,
          callback_query: { id: "cbq-5", from: { id: 1 }, message: { chat: { id: 1 } }, data: token },
        }),
    );

    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("approved");
    expect(stored.decisionChannel).toBe("telegram");
    expect(stored.decisionActorRole).toBe("steward");
    expect(stored.decidedByUserId).toBe(steward.principalId);
  });

  it("ignores a message from an unpaired telegram user", async () => {
    await seed();
    const app = createApp();

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 82,
          message: { text: "hello", from: { id: 999 }, chat: { id: 999 } },
        }),
    );

    // Fail closed and acknowledge; never route an unpaired identity to an agent.
    expect(res.status).toBe(200);
    expect(telegramCalls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // Pairing ceremony (criterion 9)
  // ---------------------------------------------------------------------

  /** A company + stewarded human with NO binding yet — the pairing precondition. */
  async function seedUnpaired() {
    const company = await db
      .insert(companies)
      .values({
        name: `TG ${randomUUID()}`,
        issuePrefix: `TG${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: "agentdash_mk",
      })
      .returning()
      .then((rows) => rows[0]!);
    const owner = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "owner",
      })
      .returning()
      .then((rows) => rows[0]!);
    const steward = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
      })
      .returning()
      .then((rows) => rows[0]!);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: steward.principalId,
      assignedByUserId: owner.principalId,
    });
    return { company, owner, steward, agent };
  }

  function startUpdate(token: string, opts: { updateId?: number; externalUserId?: number; chatType?: string } = {}) {
    return {
      update_id: opts.updateId ?? 900,
      message: {
        text: `/start ${token}`,
        from: { id: opts.externalUserId ?? 4242 },
        chat: { id: opts.externalUserId ?? 4242, type: opts.chatType ?? "private" },
      },
    };
  }

  it("completes a pairing from a deep-link token and binds the human", async () => {
    const { company, steward, agent } = await seedUnpaired();
    const { token } = await humanChannelService(db).mintPairingChallenge(company.id, {
      userId: steward.principalId,
      provider: "telegram",
    });
    const app = createApp();

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send(startUpdate(token)),
    );

    expect(res.status).toBe(200);
    const binding = await humanChannelService(db).resolveActiveBinding("telegram", "4242");
    expect(binding, "pairing did not produce a binding").not.toBeNull();
    expect(binding!.userId).toBe(steward.principalId);
    expect(binding!.agentId).toBe(agent.id);
    expect(binding!.verifiedAt).not.toBeNull();
  });

  it("refuses an unknown pairing token and creates no binding", async () => {
    await seedUnpaired();
    const app = createApp();

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send(startUpdate("not-a-real-token")),
    );

    expect(res.status).toBe(200);
    expect(await humanChannelService(db).resolveActiveBinding("telegram", "4242")).toBeNull();
  });

  it("refuses an expired pairing token", async () => {
    const { company, steward } = await seedUnpaired();
    const { token } = await humanChannelService(db).mintPairingChallenge(company.id, {
      userId: steward.principalId,
      provider: "telegram",
    });
    await db
      .update(channelPairingChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(channelPairingChallenges.token, token));
    const app = createApp();

    await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send(startUpdate(token)),
    );

    expect(await humanChannelService(db).resolveActiveBinding("telegram", "4242")).toBeNull();
  });

  it("consumes a pairing token exactly once", async () => {
    // The deep link travels through a channel the user can forward. A second
    // redemption — by anyone — must fail, or the token is a bearer credential
    // for someone else's agent.
    const { company, steward } = await seedUnpaired();
    const { token } = await humanChannelService(db).mintPairingChallenge(company.id, {
      userId: steward.principalId,
      provider: "telegram",
    });
    const app = createApp();

    await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send(startUpdate(token, { updateId: 901, externalUserId: 4242 })),
    );
    await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send(startUpdate(token, { updateId: 902, externalUserId: 5555 })),
    );

    expect(await humanChannelService(db).resolveActiveBinding("telegram", "4242")).not.toBeNull();
    expect(
      await humanChannelService(db).resolveActiveBinding("telegram", "5555"),
      "a replayed pairing token bound a second identity",
    ).toBeNull();
  });

  it("does not double-bind when telegram redelivers the same pairing update", async () => {
    const { company, steward } = await seedUnpaired();
    const { token } = await humanChannelService(db).mintPairingChallenge(company.id, {
      userId: steward.principalId,
      provider: "telegram",
    });
    const app = createApp();
    const update = startUpdate(token, { updateId: 903 });

    await call(app, (baseUrl) =>
      request(baseUrl).post(webhookPath).set("X-Telegram-Bot-Api-Secret-Token", SECRET).send(update),
    );
    const second = await call(app, (baseUrl) =>
      request(baseUrl).post(webhookPath).set("X-Telegram-Bot-Api-Secret-Token", SECRET).send(update),
    );

    expect(second.status).toBe(200);
    const bindings = await db
      .select()
      .from(humanChannelBindings)
      .where(eq(humanChannelBindings.companyId, company.id));
    expect(bindings).toHaveLength(1);
  });

  it("refuses to pair from a group chat", async () => {
    // A binding pairs ONE human. Completing it in a group would hand every
    // member of that group the ability to decide this agent's approvals.
    const { company, steward } = await seedUnpaired();
    const { token } = await humanChannelService(db).mintPairingChallenge(company.id, {
      userId: steward.principalId,
      provider: "telegram",
    });
    const app = createApp();

    await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send(startUpdate(token, { chatType: "supergroup" })),
    );

    expect(await humanChannelService(db).resolveActiveBinding("telegram", "4242")).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Bidirectional conversation (criterion 9)
  // ---------------------------------------------------------------------

  it("answers a paired human's message as their agent", async () => {
    const { company, steward, binding } = await seed();
    const app = createApp();

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 910,
          message: { text: "what is the status?", from: { id: 1 }, chat: { id: 1, type: "private" } },
        }),
    );

    expect(res.status).toBe(200);
    const sends = telegramCalls.filter((c) => c.method === "sendMessage");
    expect(sends, "no reply was sent to a paired human").toHaveLength(1);
    // The reply must actually be derived from what the human said, not a
            // canned acknowledgement — the injected model echoes the question.
    expect(String((sends[0].body as { text?: string }).text ?? "")).toContain("what is the status?");
    void company;
    void steward;
    void binding;
  });

  it("persists the exchange so the conversation has history", async () => {
    const { company, binding } = await seed();
    const app = createApp();

    await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 911,
          message: { text: "first question", from: { id: 1 }, chat: { id: 1, type: "private" } },
        }),
    );

    const conversation = await conversationService(db).findByCompany(company.id, {
      title: `telegram:${binding.id}`,
    });
    expect(conversation, "no durable conversation was created for the binding").not.toBeNull();
    const messages = await conversationService(db).paginate(conversation!.id, { limit: 10 });
    // Both halves: an agent that cannot see what the human said has no memory.
    expect(messages.map((m) => m.role).sort()).toEqual(["agent", "user"]);
  });

  it("does not route an inbound message through an unverified binding", async () => {
    // The REAL entry point. The service-level test proves the query filters
    // correctly; only this proves the webhook actually uses that query. An
    // unverified binding names an account nobody proved control of, so routing
    // its messages to an agent hands that conversation to whoever holds it.
    const { company, agent, steward } = await seed();
    // Revoke the verified binding the seed created, then plant an unverified
    // one for a different Telegram id.
    const existing = await db
      .select()
      .from(humanChannelBindings)
      .where(eq(humanChannelBindings.companyId, company.id))
      .then((rows) => rows[0]!);
    await db
      .update(humanChannelBindings)
      .set({ revokedAt: new Date() })
      .where(eq(humanChannelBindings.id, existing.id));
    await db.insert(humanChannelBindings).values({
      companyId: company.id,
      userId: steward.principalId,
      agentId: agent.id,
      provider: "telegram",
      externalUserId: "7777",
      verifiedAt: null,
    });
    const app = createApp();

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 940,
          message: { text: "hello", from: { id: 7777 }, chat: { id: 7777, type: "private" } },
        }),
    );

    expect(res.status).toBe(200);
    expect(
      telegramCalls.filter((c) => c.method === "sendMessage"),
      "an unverified binding received an agent reply",
    ).toHaveLength(0);
  });

  it("does not answer a message from a bot", async () => {
    // Two bots in one chat will talk to each other until a rate limit stops
    // them. The guard is `is_bot`, checked before any dispatch.
    await seed();
    const app = createApp();

    await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 912,
          message: { text: "hi", from: { id: 1, is_bot: true }, chat: { id: 1, type: "private" } },
        }),
    );

    expect(telegramCalls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });

  it("does not answer a paired human in a group chat", async () => {
    await seed();
    const app = createApp();

    await call(app, (baseUrl) =>
      request(baseUrl)
        .post(webhookPath)
        .set("X-Telegram-Bot-Api-Secret-Token", SECRET)
        .send({
          update_id: 913,
          message: { text: "hi", from: { id: 1 }, chat: { id: -100, type: "group" } },
        }),
    );

    // The binding authenticates one human, not a room. Replying in a group
    // discloses that human's agent's answers to everyone present.
    expect(telegramCalls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });
});
