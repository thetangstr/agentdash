// AgentDash (security): connector send paths must decrypt and use ONLY the
// connection authorization returned — never a caller-supplied connection that
// belongs to another company or to another human.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  connections,
  connectorWorkspaceDefaults,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Record which Slack token actually reaches the Slack API.
const slackTokensUsed: string[] = [];
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    chat: { postMessage: (payload: { channel: string }) => Promise<{ ts: string; channel: string }> };
    constructor(token: string) {
      slackTokensUsed.push(token);
      this.chat = {
        postMessage: async (payload) => ({ ts: "1700000000.000100", channel: payload.channel }),
      };
    }
  },
}));

// Record which connection the Gmail send is executed against.
const gmailSendCalls: string[] = [];
vi.mock("../services/gmail-connector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/gmail-connector.js")>();
  return {
    ...actual,
    gmailConnectorService: () => ({
      sendEmail: async (connectionId: string) => {
        gmailSendCalls.push(connectionId);
        return { type: "sent", result: { id: "m1", threadId: "t1" } };
      },
    }),
  };
});

const { connectorService } = await import("../services/connectors.js");
const { slackConnectorService } = await import("../services/slack-connector.js");
const { slackConnectorRoutes } = await import("../routes/slack-connector.js");
const { gmailRoutes } = await import("../routes/gmail.js");
const { errorHandler } = await import("../middleware/index.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

describeEmbeddedPostgres("connector send paths bind the token to the authorized connection", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connector-binding-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    slackTokensUsed.length = 0;
    gmailSendCalls.length = 0;
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connections);
    await db.delete(connectorWorkspaceDefaults);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const company = await db
      .insert(companies)
      .values({
        name: `Bind ${randomUUID()}`,
        issuePrefix: `B${randomUUID().slice(0, 6).toUpperCase()}`,
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
    return { company, agent };
  }

  const fullSend = { read: "full", draft: "full", send: "full" } as const;

  async function seedWorld(provider: "slack" | "google") {
    const svc = connectorService(db);
    const a = await seedCompany();
    const b = await seedCompany();
    // The connection company A's agent is legitimately allowed to use.
    const authorized = await svc.create(a.company.id, {
      ownerType: "agent",
      ownerId: a.agent.id,
      provider,
      scopes: provider === "google" ? ["gmail.readonly", "gmail.send"] : [],
      autonomy: { ...fullSend },
      visibility: "private",
      token: { accessToken: "token-A-authorized" },
    });
    // Another human's private connection inside company A.
    const colleaguePrivate = await svc.create(a.company.id, {
      ownerType: "user",
      ownerId: randomUUID(),
      provider,
      autonomy: { ...fullSend },
      visibility: "private",
      token: { accessToken: "token-A-colleague-private" },
    });
    // Company B's connection, workspace-visible inside B.
    const otherCompany = await svc.create(b.company.id, {
      ownerType: "agent",
      ownerId: b.agent.id,
      provider,
      autonomy: { ...fullSend },
      visibility: "workspace",
      token: { accessToken: "token-B-foreign" },
    });
    return { a, b, authorized, colleaguePrivate, otherCompany };
  }

  describe("resolveActingAs with a named connection", () => {
    it("refuses another company's connection and a colleague's private one", async () => {
      const { a, authorized, colleaguePrivate, otherCompany } = await seedWorld("slack");
      const svc = connectorService(db);

      const foreign = await svc.resolveActingAs(a.company.id, a.agent.id, "send", "slack", {
        connectionId: otherCompany.id,
      });
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.blocked.reason).toBe("not_authorized");

      const privateOther = await svc.resolveActingAs(a.company.id, a.agent.id, "send", "slack", {
        connectionId: colleaguePrivate.id,
      });
      expect(privateOther.ok).toBe(false);

      const own = await svc.resolveActingAs(a.company.id, a.agent.id, "send", "slack", {
        connectionId: authorized.id,
      });
      expect(own.ok).toBe(true);
      if (own.ok) expect(own.resolution.connectionId).toBe(authorized.id);
    });
  });

  describe("slack postMessage", () => {
    it("rejects another company's connectionId and never uses its token", async () => {
      const { a, otherCompany } = await seedWorld("slack");
      const slack = slackConnectorService(db);

      await expect(
        slack.postMessage(otherCompany.id, {
          channel: "C1",
          text: "hi",
          companyId: a.company.id,
          agentId: a.agent.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(slackTokensUsed).not.toContain("token-B-foreign");
      expect(slackTokensUsed).toHaveLength(0);
    });

    it("rejects another human's private connection in the same company", async () => {
      const { a, colleaguePrivate } = await seedWorld("slack");
      const slack = slackConnectorService(db);

      await expect(
        slack.postMessage(colleaguePrivate.id, {
          channel: "C1",
          text: "hi",
          companyId: a.company.id,
          agentId: a.agent.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(slackTokensUsed).toHaveLength(0);
    });

    it("sends with the authorized connection's token on the happy path", async () => {
      const { a, authorized } = await seedWorld("slack");
      const slack = slackConnectorService(db);

      const result = await slack.postMessage(authorized.id, {
        channel: "C1",
        text: "hi",
        companyId: a.company.id,
        agentId: a.agent.id,
      });
      expect(result).toMatchObject({ posted: true, channel: "C1" });
      expect(slackTokensUsed).toEqual(["token-A-authorized"]);
    });

    it("route returns 403 for a foreign connectionId", async () => {
      const { a, otherCompany } = await seedWorld("slack");
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = {
          type: "board",
          userId: randomUUID(),
          source: "session",
          isInstanceAdmin: false,
          companyIds: [a.company.id],
          memberships: [{ companyId: a.company.id, membershipRole: "operator", status: "active" }],
        };
        next();
      });
      app.use("/api/connectors", slackConnectorRoutes(db));
      app.use(errorHandler);

      const res = await request(app).post("/api/connectors/slack/send").send({
        companyId: a.company.id,
        connectionId: otherCompany.id,
        channel: "C1",
        text: "hi",
        agentId: a.agent.id,
      });
      expect(res.status).toBe(403);
      expect(slackTokensUsed).toHaveLength(0);
    });
  });

  describe("gmail send route", () => {
    function createApp(companyId: string) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = {
          type: "board",
          userId: "local-board",
          source: "local_implicit",
          isInstanceAdmin: true,
          companyIds: [companyId],
        };
        next();
      });
      app.use("/api", gmailRoutes(db));
      app.use(errorHandler);
      return app;
    }

    const body = (agentId: string) => ({ to: "x@example.com", subject: "s", body: "b", agentId });

    it("rejects another company's connection", async () => {
      const { a, otherCompany } = await seedWorld("google");
      const res = await request(createApp(a.company.id))
        .post(`/api/companies/${a.company.id}/connectors/gmail/${otherCompany.id}/send`)
        .send(body(a.agent.id));
      expect(res.status).toBe(403);
      expect(gmailSendCalls).toHaveLength(0);
    });

    it("rejects another human's private connection in the same company", async () => {
      const { a, colleaguePrivate } = await seedWorld("google");
      const res = await request(createApp(a.company.id))
        .post(`/api/companies/${a.company.id}/connectors/gmail/${colleaguePrivate.id}/send`)
        .send(body(a.agent.id));
      expect(res.status).toBe(403);
      expect(gmailSendCalls).toHaveLength(0);
    });

    it("sends through the authorized connection on the happy path", async () => {
      const { a, authorized } = await seedWorld("google");
      const res = await request(createApp(a.company.id))
        .post(`/api/companies/${a.company.id}/connectors/gmail/${authorized.id}/send`)
        .send(body(a.agent.id));
      expect(res.status).toBe(200);
      expect(gmailSendCalls).toEqual([authorized.id]);
    });
  });
});
