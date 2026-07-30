import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentStewardships,
  agents,
  channelPairingChallenges,
  companies,
  companyMemberships,
  createDb,
  humanChannelBindings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { humanChannelRoutes } from "../routes/human-channels.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

/**
 * The mint half of the pairing ceremony.
 *
 * The redemption half lives in `telegram-connector.test.ts` because it arrives
 * through the webhook, not the authenticated API.
 */
describeEmbeddedPostgres("channel pairing routes", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pairing-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    process.env.TELEGRAM_BOT_USERNAME = "agentdash_test_bot";
    process.env.WHATSAPP_BUSINESS_NUMBER = "+1 555 010 9999";
  });

  afterEach(async () => {
    delete process.env.TELEGRAM_BOT_USERNAME;
    delete process.env.WHATSAPP_BUSINESS_NUMBER;
    await db.delete(activityLog);
    await db.delete(channelPairingChallenges);
    await db.delete(humanChannelBindings);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(profile: "agentdash_mk" | "default" = "agentdash_mk") {
    const company = await db
      .insert(companies)
      .values({
        name: `Pair ${randomUUID()}`,
        issuePrefix: `PR${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: profile,
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

  function boardActor(companyId: string, userId: string) {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor, companyIds: [...((actor.companyIds as string[]) ?? [])] };
      next();
    });
    app.use("/api", humanChannelRoutes(db));
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

  it("mints a pairing challenge and returns a deep link for the caller", async () => {
    const { company, steward } = await seed();
    const app = createApp(boardActor(company.id, steward.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/me/channels/telegram/pairing`).send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deepLink).toMatch(/^https:\/\/t\.me\/agentdash_test_bot\?start=/);
    expect(typeof res.body.expiresAt).toBe("string");

    const rows = await db.select().from(channelPairingChallenges);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(steward.principalId);
    // The token is the credential; it must not also be echoed anywhere it could
    // be logged separately from the link the user is meant to open.
    expect(res.body.token).toBeUndefined();
  });

  it("replaces an outstanding challenge rather than leaving two live tokens", async () => {
    const { company, steward } = await seed();
    const app = createApp(boardActor(company.id, steward.principalId));

    await call(app, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/me/channels/telegram/pairing`).send({}),
    );
    await call(app, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/me/channels/telegram/pairing`).send({}),
    );

    const rows = await db.select().from(channelPairingChallenges);
    expect(rows).toHaveLength(2);
    // Exactly one is still redeemable. The abandoned link already travelled
    // through a channel someone else may have seen.
    expect(rows.filter((row) => row.consumedAt === null)).toHaveLength(1);
  });

  it("mints for the authenticated caller and nobody else", async () => {
    const { company, steward, owner } = await seed();
    const app = createApp(boardActor(company.id, steward.principalId));

    await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/me/channels/telegram/pairing`)
        // A body-supplied userId must be ignored, not honored — otherwise one
        // member mints a link that binds THEIR telegram account to another
        // member's agent.
        .send({ userId: owner.principalId }),
    );

    const rows = await db.select().from(channelPairingChallenges);
    expect(rows[0].userId).toBe(steward.principalId);
  });

  it("refuses to mint for a human who stewards no agent", async () => {
    const { company, owner } = await seed();
    const app = createApp(boardActor(company.id, owner.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/me/channels/telegram/pairing`).send({}),
    );

    expect(res.status).toBe(409);
  });

  it("404s for a company that is not agentdash_mk", async () => {
    const { company, steward } = await seed("default");
    const app = createApp(boardActor(company.id, steward.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/me/channels/telegram/pairing`).send({}),
    );

    expect(res.status).toBe(404);
  });

  it("reports a configuration gap instead of a broken link when the bot name is unset", async () => {
    delete process.env.TELEGRAM_BOT_USERNAME;
    const { company, steward } = await seed();
    const app = createApp(boardActor(company.id, steward.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/me/channels/telegram/pairing`).send({}),
    );

    // A link to `https://t.me/undefined?start=…` looks like it works and never
    // will. Fail loudly and spend no token.
    expect(res.status).toBe(503);
    expect(await db.select().from(channelPairingChallenges)).toHaveLength(0);
  });

  it("no longer accepts a self-asserted telegram identity on the generic bind route", async () => {
    // Before the ceremony existed this route was the only way to pair. It let
    // the caller name any telegram user id, so a member could bind a stranger's
    // account — or a colleague's — to their own agent. Telegram now has a
    // verified path, so this one must refuse it.
    const { company, steward } = await seed();
    const app = createApp(boardActor(company.id, steward.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/me/channels`)
        .send({ provider: "telegram", externalUserId: "99999" }),
    );

    expect(res.status).toBe(400);
    expect(await db.select().from(humanChannelBindings)).toHaveLength(0);
  });

  it("still accepts providers that have no ceremony yet", async () => {
    const { company, steward } = await seed();
    const app = createApp(boardActor(company.id, steward.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/me/channels`)
        .send({ provider: "teams", externalUserId: "teams-1", externalTenantId: "tenant-1" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("mints a whatsapp pairing link that carries the token and no phone number", async () => {
    const { company, steward } = await seed();
    const app = createApp(boardActor(company.id, steward.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/me/channels/whatsapp/pairing`).send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deepLink).toMatch(/^https:\/\/wa\.me\/15550109999\?text=/);
    expect(res.body.token).toBeUndefined();

    const rows = await db.select().from(channelPairingChallenges);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("whatsapp");
    expect(rows[0].userId).toBe(steward.principalId);
  });

  it("no longer accepts a self-asserted whatsapp number on the generic bind route", async () => {
    // Phone numbers are guessable in a way a Telegram user id is not, so this
    // route was the sharpest edge of the same self-asserted-identity problem.
    const { company, steward } = await seed();
    const app = createApp(boardActor(company.id, steward.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/me/channels`)
        .send({ provider: "whatsapp", externalUserId: "15550000000" }),
    );

    expect(res.status).toBe(400);
    expect(await db.select().from(humanChannelBindings)).toHaveLength(0);
  });

  it("reports a configuration gap when the business number is unset", async () => {
    delete process.env.WHATSAPP_BUSINESS_NUMBER;
    const { company, steward } = await seed();
    const app = createApp(boardActor(company.id, steward.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/me/channels/whatsapp/pairing`).send({}),
    );

    expect(res.status).toBe(503);
    expect(await db.select().from(channelPairingChallenges)).toHaveLength(0);
  });
});
