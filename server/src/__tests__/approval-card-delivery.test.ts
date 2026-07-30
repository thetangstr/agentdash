import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentStewardships,
  agents,
  approvals,
  channelCallbackTokens,
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
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { approvalCardDeliveryService } from "../services/approval-card-delivery.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

/**
 * Outbound approval cards.
 *
 * `buildApprovalKeyboard` existed, minted correct opaque tokens, and was
 * tested — and had no caller. Nothing pushed a card when an approval was
 * created, so a steward never received a button to press. The decision path was
 * complete and the delivery path did not exist, and the tests asserted only the
 * former.
 */
describeEmbeddedPostgres("approval card delivery", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let sent: Array<{ method: string; body: Record<string, unknown> }>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-card-delivery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    sent = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      sent.push({
        method: String(url).split("/").pop() ?? "",
        body: init?.body ? JSON.parse(init.body) : {},
      });
      return { ok: true, json: async () => ({ ok: true, result: {} }) } as never;
    });
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
    await db.delete(activityLog);
    await db.delete(channelCallbackTokens);
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

  async function seed(
    options: {
      profile?: "agentdash_mk" | "default";
      binding?: "verified" | "unverified" | "revoked" | "none";
      steward?: boolean;
    } = {},
  ) {
    const company = await db
      .insert(companies)
      .values({
        name: `Card ${randomUUID()}`,
        issuePrefix: `CD${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: options.profile ?? "agentdash_mk",
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

    if (options.steward !== false) {
      await agentStewardshipService(db).assign(company.id, {
        agentId: agent.id,
        userId: steward.principalId,
        assignedByUserId: owner.principalId,
      });
    }

    const bindingMode = options.binding ?? "verified";
    if (bindingMode !== "none") {
      const now = new Date();
      await db.insert(humanChannelBindings).values({
        companyId: company.id,
        userId: steward.principalId,
        agentId: agent.id,
        provider: "telegram",
        externalUserId: "555",
        externalConversationId: "chat-555",
        verifiedAt: bindingMode === "unverified" ? null : now,
        revokedAt: bindingMode === "revoked" ? now : null,
      });
    }

    const approval = await db
      .insert(approvals)
      .values({
        companyId: company.id,
        type: "request_board_approval",
        requestedByAgentId: agent.id,
        status: "pending",
        payload: { summary: "Ship the board deck" },
      })
      .returning()
      .then((rows) => rows[0]!);

    return { company, owner, steward, agent, approval };
  }

  function cardSends() {
    return sent.filter((call) => call.method === "sendMessage");
  }

  it("delivers a card to the steward's verified channel", async () => {
    const { approval } = await seed();

    await approvalCardDeliveryService(db).deliverForApproval(approval.id);

    const cards = cardSends();
    expect(cards, "no approval card was delivered").toHaveLength(1);
    expect(cards[0].body.chat_id).toBe("chat-555");
    const keyboard = (cards[0].body.reply_markup as { inline_keyboard?: unknown[][] } | undefined)
      ?.inline_keyboard;
    expect(keyboard?.[0], "the card carried no decision buttons").toHaveLength(2);
  });

  it("mints callback tokens bound to the approval and its current revision", async () => {
    const { approval } = await seed();

    await approvalCardDeliveryService(db).deliverForApproval(approval.id);

    const tokens = await db
      .select()
      .from(channelCallbackTokens)
      .where(eq(channelCallbackTokens.approvalId, approval.id));
    expect(tokens).toHaveLength(2);
    expect(tokens.map((row) => row.decision).sort()).toEqual(["approved", "rejected"]);
    // The revision on the token is what the decision echoes back. A card minted
    // against a stale revision would decide something the human never saw.
    expect(tokens.every((row) => row.approvalRevision === approval.revision)).toBe(true);
  });

  it("does not deliver to an unverified binding", async () => {
    // An unverified binding names an identity nobody has proven control of.
    // Delivering to it leaks the approval to whoever holds that account.
    const { approval } = await seed({ binding: "unverified" });

    await approvalCardDeliveryService(db).deliverForApproval(approval.id);

    expect(cardSends()).toHaveLength(0);
  });

  it("does not deliver to a revoked binding", async () => {
    const { approval } = await seed({ binding: "revoked" });

    await approvalCardDeliveryService(db).deliverForApproval(approval.id);

    expect(cardSends()).toHaveLength(0);
  });

  it("does not deliver in a default-profile company", async () => {
    const { approval } = await seed({ profile: "default" });

    await approvalCardDeliveryService(db).deliverForApproval(approval.id);

    expect(cardSends()).toHaveLength(0);
  });

  it("does not deliver when the requesting agent has no steward", async () => {
    // With no steward there is nobody with authority to decide, so a card would
    // be an invitation to an action the server will refuse.
    const { approval } = await seed({ steward: false, binding: "none" });

    await approvalCardDeliveryService(db).deliverForApproval(approval.id);

    expect(cardSends()).toHaveLength(0);
  });

  it("does not deliver an already-decided approval", async () => {
    const { approval } = await seed();
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approval.id));

    await approvalCardDeliveryService(db).deliverForApproval(approval.id);

    expect(cardSends()).toHaveLength(0);
  });

  it("never lets a delivery failure escape to the caller", async () => {
    // Delivery is a side effect of creating an approval. A provider outage must
    // not fail the request that created it, or an unreachable Telegram takes
    // the whole governed-action flow down with it.
    const { approval } = await seed();
    vi.stubGlobal("fetch", async () => {
      throw new Error("provider unreachable");
    });

    await expect(
      approvalCardDeliveryService(db).deliverForApproval(approval.id),
    ).resolves.toBeUndefined();
  });

  it("delivers a fresh card after a resubmit advances the revision", async () => {
    const { approval } = await seed();
    const svc = approvalCardDeliveryService(db);
    await svc.deliverForApproval(approval.id);

    await db.update(approvals).set({ revision: 2 }).where(eq(approvals.id, approval.id));
    await svc.deliverForApproval(approval.id);

    expect(cardSends()).toHaveLength(2);
    const tokens = await db
      .select()
      .from(channelCallbackTokens)
      .where(eq(channelCallbackTokens.approvalId, approval.id));
    // The old revision's tokens still exist but are dead on arrival; the new
    // card must carry the new revision or the steward cannot decide at all.
    expect(tokens.filter((row) => row.approvalRevision === 2)).toHaveLength(2);
  });

  it("delivers when an approval is created through the API, not only when the service is called", async () => {
    // The gap this whole file exists for: the delivery service could be
    // perfect and still never run. Asserting it through the route is what
    // proves the wiring, and the wiring is what was missing.
    const { company, agent } = await seed({ binding: "verified" });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds: [company.id],
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      };
      next();
    });
    app.use("/api", approvalRoutes(db, { autoDispatchQueuedRuns: false }));
    app.use(errorHandler);

    const { createServer } = await import("node:http");
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const res = await request(`http://127.0.0.1:${address.port}`)
        .post(`/api/companies/${company.id}/approvals`)
        .send({
          type: "request_board_approval",
          requestedByAgentId: agent.id,
          payload: { summary: "Publish pricing" },
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }

    const cards = cardSends();
    expect(cards, "creating an approval sent no card to the paired steward").toHaveLength(1);
    expect(String(cards[0].body.text ?? "")).toContain("Publish pricing");
  });
});
