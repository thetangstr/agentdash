import { createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentStewardships,
  agents,
  approvals,
  channelCallbackTokens,
  channelPairingChallenges,
  companies,
  companyMemberships,
  createDb,
  externalChannelEvents,
  humanChannelBindings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { whatsappConnectorRoutes } from "../routes/whatsapp-connector.js";
import {
  verifyWhatsAppSignature,
  whatsappPairingLink,
  whatsappConnectorService,
} from "../services/whatsapp-connector.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { humanChannelService } from "../services/human-channels.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const APP_SECRET = "whatsapp-app-secret";
const VERIFY_TOKEN = "whatsapp-verify-token";
const WEBHOOK = "/api/connectors/whatsapp/webhook";

function sign(body: string) {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

describe("whatsapp signature verification", () => {
  it("accepts a signature computed over the exact raw bytes", () => {
    const body = '{"entry":[{"changes":[]}]}';
    expect(verifyWhatsAppSignature(APP_SECRET, body, sign(body))).toBe(true);
  });

  it("rejects a signature computed over re-serialized JSON", () => {
    // The trap this guards: verifying against JSON.stringify(req.body) rather
    // than the raw bytes. Whitespace survives the wire and does not survive a
    // parse/serialize round trip, so every authentic request would be rejected.
    // (Key order happens to round-trip in V8, which is exactly why whitespace
    // is the honest example — the bug is real even when reordering is not.)
    const raw = '{ "a": 1, "b": [2, 3] }';
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect(raw).not.toEqual(reserialized);
    expect(verifyWhatsAppSignature(APP_SECRET, reserialized, sign(raw))).toBe(false);
  });

  it("rejects a wrong secret, a missing header, and an unprefixed digest", () => {
    const body = "{}";
    expect(verifyWhatsAppSignature("other-secret", body, sign(body))).toBe(false);
    expect(verifyWhatsAppSignature(APP_SECRET, body, undefined)).toBe(false);
    expect(verifyWhatsAppSignature(APP_SECRET, body, sign(body).replace("sha256=", ""))).toBe(false);
  });

  it("builds a pairing link that carries the token and no phone number", () => {
    // The user sends this FROM their handset; nothing anywhere accepts a
    // number a human typed, because numbers are guessable.
    const link = whatsappPairingLink("+1 (555) 010-1234", "tok_abc");
    expect(link).toBe("https://wa.me/15550101234?text=tok_abc");
  });
});

describeEmbeddedPostgres("whatsapp connector", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let sent: Array<Record<string, unknown>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-whatsapp-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    sent = [];
    vi.stubGlobal("fetch", async (_url: string, init?: { body?: string }) => {
      sent.push(init?.body ? JSON.parse(init.body) : {});
      return { ok: true, json: async () => ({ ok: true }) } as never;
    });
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
    process.env.WHATSAPP_ACCESS_TOKEN = "graph-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "111222";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const key of [
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
    ]) {
      delete process.env[key];
    }
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

  function createApp() {
    const app = express();
    // Mirrors the real app: capture raw bytes so signature checks see the wire.
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use(
      "/api",
      whatsappConnectorRoutes(db, {
        llm: async (input) => `echo:${input.messages.at(-1)?.content ?? ""}`,
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

  function post(app: express.Express, payload: unknown, signature?: string) {
    const body = JSON.stringify(payload);
    return call(app, (baseUrl) =>
      request(baseUrl)
        .post(WEBHOOK)
        .set("content-type", "application/json")
        .set("X-Hub-Signature-256", signature ?? sign(body))
        .send(body),
    );
  }

  function messageEnvelope(messages: unknown[]) {
    return { entry: [{ changes: [{ value: { messages } }] }] };
  }

  async function seedStewardedHuman() {
    const company = await db
      .insert(companies)
      .values({
        name: `WA ${randomUUID()}`,
        issuePrefix: `WA${randomUUID().slice(0, 6).toUpperCase()}`,
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

  async function seedPaired() {
    const base = await seedStewardedHuman();
    const binding = await humanChannelService(db).verifyBinding(base.company.id, {
      provider: "whatsapp",
      userId: base.steward.principalId,
      externalUserId: "15551234567",
      externalConversationId: "15551234567",
    });
    // Pairing opens the messaging window in production; seed it here too.
    await db
      .update(humanChannelBindings)
      .set({ lastInboundAt: new Date() })
      .where(eq(humanChannelBindings.id, binding.id));
    return { ...base, binding };
  }

  it("answers the subscription handshake with the challenge", async () => {
    const app = createApp();
    const res = await call(app, (baseUrl) =>
      request(baseUrl).get(
        `${WEBHOOK}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe("42");
  });

  it("refuses the handshake with a wrong verify token", async () => {
    const app = createApp();
    const res = await call(app, (baseUrl) =>
      request(baseUrl).get(`${WEBHOOK}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`),
    );
    expect(res.status).toBe(403);
  });

  it("refuses an unsigned webhook before dispatching anything", async () => {
    const { binding } = await seedPaired();
    const app = createApp();

    const res = await post(
      app,
      messageEnvelope([
        { id: "wamid.1", from: "15551234567", type: "text", text: { body: "hello" } },
      ]),
      "sha256=deadbeef",
    );

    expect(res.status).toBe(401);
    expect(sent, "an unsigned webhook reached dispatch").toHaveLength(0);
    const events = await db
      .select()
      .from(externalChannelEvents)
      .where(eq(externalChannelEvents.bindingId, binding.id));
    expect(events, "an unsigned webhook was claimed").toHaveLength(0);
  });

  it("answers a paired human's message as their agent", async () => {
    await seedPaired();
    const app = createApp();

    const res = await post(
      app,
      messageEnvelope([
        { id: "wamid.2", from: "15551234567", type: "text", text: { body: "status?" } },
      ]),
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("status?");
  });

  it("deduplicates on wamid so a redelivered message is handled once", async () => {
    await seedPaired();
    const app = createApp();
    const payload = messageEnvelope([
      { id: "wamid.3", from: "15551234567", type: "text", text: { body: "hi" } },
    ]);

    await post(app, payload);
    await post(app, payload);

    expect(sent).toHaveLength(1);
  });

  it("claims each message in a batch separately", async () => {
    // One POST may carry several messages. Treating the payload as one unit
    // would let a duplicate suppress a distinct sibling arriving beside it.
    await seedPaired();
    const app = createApp();

    await post(
      app,
      messageEnvelope([
        { id: "wamid.4", from: "15551234567", type: "text", text: { body: "first" } },
        { id: "wamid.5", from: "15551234567", type: "text", text: { body: "second" } },
      ]),
    );

    expect(sent).toHaveLength(2);
  });

  it("ignores a message from an unpaired number", async () => {
    await seedPaired();
    const app = createApp();

    await post(
      app,
      messageEnvelope([
        { id: "wamid.6", from: "19995550000", type: "text", text: { body: "hello" } },
      ]),
    );

    expect(sent).toHaveLength(0);
  });

  it("pairs from a token the human sent from their own handset", async () => {
    const { company, steward, agent } = await seedStewardedHuman();
    const { token } = await humanChannelService(db).mintPairingChallenge(company.id, {
      userId: steward.principalId,
      provider: "whatsapp",
    });
    const app = createApp();

    await post(
      app,
      messageEnvelope([{ id: "wamid.7", from: "15559998888", type: "text", text: { body: token } }]),
    );

    const binding = await humanChannelService(db).resolveActiveBinding("whatsapp", "15559998888");
    expect(binding, "pairing produced no binding").not.toBeNull();
    expect(binding!.userId).toBe(steward.principalId);
    expect(binding!.agentId).toBe(agent.id);
    expect(binding!.verifiedAt).not.toBeNull();
    // The pairing message is itself inbound and must open the 24-hour window,
    // or the very first approval card would be refused as out-of-window.
    expect(binding!.lastInboundAt).not.toBeNull();
  });

  it("consumes a pairing token exactly once", async () => {
    const { company, steward } = await seedStewardedHuman();
    const { token } = await humanChannelService(db).mintPairingChallenge(company.id, {
      userId: steward.principalId,
      provider: "whatsapp",
    });
    const app = createApp();

    await post(
      app,
      messageEnvelope([{ id: "wamid.8", from: "15559998888", type: "text", text: { body: token } }]),
    );
    await post(
      app,
      messageEnvelope([{ id: "wamid.9", from: "15557776666", type: "text", text: { body: token } }]),
    );

    expect(await humanChannelService(db).resolveActiveBinding("whatsapp", "15559998888")).not.toBeNull();
    expect(
      await humanChannelService(db).resolveActiveBinding("whatsapp", "15557776666"),
      "a replayed pairing token bound a second number",
    ).toBeNull();
  });

  it("decides an approval from an interactive button reply", async () => {
    const { company, agent, binding, steward } = await seedPaired();
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
    const token = await whatsappConnectorService(db).issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });
    const app = createApp();

    await post(
      app,
      messageEnvelope([
        {
          id: "wamid.10",
          from: "15551234567",
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: token } },
        },
      ]),
    );

    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("approved");
    // The decision goes through the same boundary as web and Telegram, so the
    // provenance columns must be populated identically.
    expect(stored.decisionChannel).toBe("whatsapp");
    expect(stored.decisionActorRole).toBe("steward");
    expect(stored.decidedByUserId).toBe(steward.principalId);
  });

  it("refuses a button reply from a revoked binding", async () => {
    const { company, agent, binding } = await seedPaired();
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
    const token = await whatsappConnectorService(db).issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });
    await humanChannelService(db).revokeBinding(company.id, binding.id, { actorUserId: "owner" });
    const app = createApp();

    await post(
      app,
      messageEnvelope([
        {
          id: "wamid.11",
          from: "15551234567",
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: token } },
        },
      ]),
    );

    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("pending");
  });

  it("reports an out-of-window card as undelivered instead of sending one", async () => {
    // Outside 24 hours Meta accepts only a reviewed template. Downgrading to a
    // text message would be rejected upstream while looking delivered here.
    const { company, agent, binding } = await seedPaired();
    await db
      .update(humanChannelBindings)
      .set({ lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(humanChannelBindings.id, binding.id));
    const fresh = await db
      .select()
      .from(humanChannelBindings)
      .where(eq(humanChannelBindings.id, binding.id))
      .then((rows) => rows[0]!);

    const result = await whatsappConnectorService(db).sendApprovalCard({
      companyId: company.id,
      approvalId: randomUUID(),
      revision: 1,
      binding: fresh,
      text: "Decide this",
    });

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("outside_24h_window");
    expect(sent, "a message was sent outside the 24-hour window").toHaveLength(0);
    void agent;
  });

  it("sends interactive buttons inside the window", async () => {
    const { company, agent, binding } = await seedPaired();
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
    const fresh = await db
      .select()
      .from(humanChannelBindings)
      .where(eq(humanChannelBindings.id, binding.id))
      .then((rows) => rows[0]!);

    const result = await whatsappConnectorService(db).sendApprovalCard({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      binding: fresh,
      text: "Decide this",
    });

    expect(result.delivered).toBe(true);
    const body = sent[0] as { type?: string; interactive?: { action?: { buttons?: unknown[] } } };
    expect(body.type).toBe("interactive");
    expect(body.interactive?.action?.buttons).toHaveLength(2);
    // Two opaque handles, never the approval id.
    const tokens = await db
      .select()
      .from(channelCallbackTokens)
      .where(eq(channelCallbackTokens.approvalId, approval.id));
    expect(tokens).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain(approval.id);
  });
});
