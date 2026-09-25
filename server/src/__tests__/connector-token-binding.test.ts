// AgentDash (security): connector send paths must decrypt and use ONLY the
// connection authorization returned — never a caller-supplied connection that
// belongs to another company or to another human.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentGovernancePolicies,
  agentStewardships,
  agents,
  companies,
  companyMemberships,
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

// Record which connection each Gmail call is executed against.
const gmailSendCalls: string[] = [];
const gmailReadCalls: Array<{ op: string; connectionId: string }> = [];
vi.mock("../services/gmail-connector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/gmail-connector.js")>();
  return {
    ...actual,
    gmailConnectorService: () => ({
      sendEmail: async (connectionId: string) => {
        gmailSendCalls.push(connectionId);
        return { type: "sent", result: { id: "m1", threadId: "t1" } };
      },
      search: async (connectionId: string) => {
        gmailReadCalls.push({ op: "search", connectionId });
        return { messages: [], nextPageToken: null };
      },
      listMessages: async (connectionId: string) => {
        gmailReadCalls.push({ op: "messages", connectionId });
        return { messages: [], nextPageToken: null };
      },
      readThread: async (connectionId: string) => {
        gmailReadCalls.push({ op: "thread", connectionId });
        return { id: "t1", messages: [] };
      },
      createDraft: async (connectionId: string) => {
        gmailReadCalls.push({ op: "draft", connectionId });
        return { draftId: "d1" };
      },
    }),
  };
});

const { connectorService } = await import("../services/connectors.js");
const { slackConnectorService } = await import("../services/slack-connector.js");
const { slackConnectorRoutes } = await import("../routes/slack-connector.js");
const { gmailRoutes } = await import("../routes/gmail.js");
const { errorHandler } = await import("../middleware/index.js");
const { agentStewardshipService } = await import("../services/agent-stewardships.js");

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
    gmailReadCalls.length = 0;
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connections);
    await db.delete(connectorWorkspaceDefaults);
    await db.delete(agentGovernancePolicies);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
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
  describe("gmail read and draft routes (closes #720)", () => {
    type Actor = Record<string, unknown>;
    function appFor(actor: Actor) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      app.use("/api", gmailRoutes(db));
      app.use(errorHandler);
      return app;
    }
    const member = (userId: string, companyId: string, role = "operator"): Actor => ({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
    });
    const agentKey = (agentId: string, companyId: string): Actor => ({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    });

    async function seedMailboxes() {
      const svc = connectorService(db);
      const a = await seedCompany();
      const userA = `user-a-${randomUUID()}`;
      const userB = `user-b-${randomUUID()}`;
      const aPrivate = await svc.create(a.company.id, {
        ownerType: "user",
        ownerId: userA,
        provider: "google",
        scopes: ["gmail.readonly", "gmail.send"],
        autonomy: { ...fullSend },
        visibility: "private",
        token: { accessToken: "token-userA-private" },
      });
      const agentOwn = await svc.create(a.company.id, {
        ownerType: "agent",
        ownerId: a.agent.id,
        provider: "google",
        scopes: ["gmail.readonly"],
        autonomy: { ...fullSend },
        visibility: "private",
        token: { accessToken: "token-agent-own" },
      });
      const sharedReadOnly = await svc.create(a.company.id, {
        ownerType: "user",
        ownerId: userA,
        provider: "google",
        scopes: ["gmail.readonly"],
        autonomy: { read: "full", draft: "blocked", send: "blocked" },
        visibility: "workspace",
        token: { accessToken: "token-shared" },
      });
      return { a, userA, userB, aPrivate, agentOwn, sharedReadOnly };
    }

    const readPaths = (companyId: string, connectionId: string) => [
      `/api/companies/${companyId}/connectors/gmail/${connectionId}/search?q=invoice`,
      `/api/companies/${companyId}/connectors/gmail/${connectionId}/messages`,
      `/api/companies/${companyId}/connectors/gmail/${connectionId}/threads/t1`,
    ];
    const draftBody = { to: "x@example.com", subject: "s", body: "b" };

    it("a member cannot search, list, read threads, or draft in a colleague's private connection", async () => {
      const { a, userB, aPrivate } = await seedMailboxes();
      const app = appFor(member(userB, a.company.id));
      for (const path of readPaths(a.company.id, aPrivate.id)) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(403);
      }
      // Even a company admin may not draft in a member's private mailbox.
      const adminApp = appFor(member(userB, a.company.id, "owner"));
      const draft = await request(adminApp)
        .post(`/api/companies/${a.company.id}/connectors/gmail/${aPrivate.id}/drafts`)
        .send(draftBody);
      expect(draft.status).toBe(403);
      const adminRead = await request(adminApp).get(readPaths(a.company.id, aPrivate.id)[0]!);
      expect(adminRead.status).toBe(403);
      expect(gmailReadCalls).toHaveLength(0);
    });

    it("a member cannot reach a colleague's private connection by naming an agent", async () => {
      const { a, userB, aPrivate } = await seedMailboxes();
      const app = appFor(member(userB, a.company.id, "owner"));
      const res = await request(app)
        .post(`/api/companies/${a.company.id}/connectors/gmail/${aPrivate.id}/send`)
        .send({ ...draftBody, agentId: a.agent.id });
      expect(res.status).toBe(403);
      expect(gmailSendCalls).toHaveLength(0);
    });

    it("an agent key cannot read a human's private connection or act as another agent", async () => {
      const { a, aPrivate, agentOwn } = await seedMailboxes();
      const app = appFor(agentKey(a.agent.id, a.company.id));
      for (const path of readPaths(a.company.id, aPrivate.id)) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(403);
      }
      expect(gmailReadCalls).toHaveLength(0);

      // Legitimate: the agent reads its own connection.
      const own = await request(app).get(readPaths(a.company.id, agentOwn.id)[0]!);
      expect(own.status).toBe(200);
      expect(gmailReadCalls).toEqual([{ op: "search", connectionId: agentOwn.id }]);
    });

    it("the owner can search, list, read, draft, and send from their own private connection", async () => {
      const { a, userA, aPrivate } = await seedMailboxes();
      const app = appFor(member(userA, a.company.id, "owner"));
      for (const path of readPaths(a.company.id, aPrivate.id)) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(200);
      }
      const draft = await request(app)
        .post(`/api/companies/${a.company.id}/connectors/gmail/${aPrivate.id}/drafts`)
        .send(draftBody);
      expect(draft.status).toBe(201);
      const send = await request(app)
        .post(`/api/companies/${a.company.id}/connectors/gmail/${aPrivate.id}/send`)
        .send(draftBody);
      expect(send.status).toBe(200);
      expect(gmailReadCalls.map((c) => c.op)).toEqual(["search", "messages", "thread", "draft"]);
      expect(gmailReadCalls.every((c) => c.connectionId === aPrivate.id)).toBe(true);
      expect(gmailSendCalls).toEqual([aPrivate.id]);
    });

    it("a workspace-visible connection follows its autonomy settings", async () => {
      const { a, userB, sharedReadOnly } = await seedMailboxes();
      const app = appFor(member(userB, a.company.id, "owner"));
      const read = await request(app).get(readPaths(a.company.id, sharedReadOnly.id)[0]!);
      expect(read.status).toBe(200);
      const draft = await request(app)
        .post(`/api/companies/${a.company.id}/connectors/gmail/${sharedReadOnly.id}/drafts`)
        .send(draftBody);
      expect(draft.status).toBe(403);
      expect(draft.body.code).toBe("autonomy_blocked");
      expect(gmailReadCalls).toEqual([{ op: "search", connectionId: sharedReadOnly.id }]);
    });
  });
  describe("steward fallback: a human naming a colleague's stewarded agent (agentdash_mk)", () => {
    async function seedStewarded(provider: "slack" | "google") {
      const company = await db
        .insert(companies)
        .values({
          name: `Stew ${randomUUID()}`,
          issuePrefix: `S${randomUUID().slice(0, 6).toUpperCase()}`,
          productProfile: "agentdash_mk",
        })
        .returning()
        .then((rows) => rows[0]!);
      const agent = await db
        .insert(agents)
        .values({ companyId: company.id, name: `Agent ${randomUUID()}`, role: "engineer", status: "idle", adapterType: "process" })
        .returning()
        .then((rows) => rows[0]!);
      const steward = randomUUID();
      const colleague = randomUUID();
      const owner = randomUUID();
      await db.insert(companyMemberships).values([
        { companyId: company.id, principalType: "user", principalId: steward, status: "active", membershipRole: "operator" },
        { companyId: company.id, principalType: "user", principalId: colleague, status: "active", membershipRole: "owner" },
        { companyId: company.id, principalType: "user", principalId: owner, status: "active", membershipRole: "owner" },
      ]);
      await agentStewardshipService(db).assign(company.id, {
        agentId: agent.id,
        userId: steward,
        assignedByUserId: owner,
      });
      const stewardPrivate = await connectorService(db).create(company.id, {
        ownerType: "user",
        ownerId: steward,
        provider,
        autonomy: { ...fullSend },
        visibility: "private",
        token: { accessToken: "token-steward-private" },
      });
      return { company, agent, steward, colleague, stewardPrivate };
    }

    function appAs(userId: string, companyId: string, role: string, mount: "slack" | "gmail") {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = {
          type: "board",
          userId,
          source: "session",
          isInstanceAdmin: false,
          companyIds: [companyId],
          memberships: [{ companyId, membershipRole: role, status: "active" }],
        };
        next();
      });
      if (mount === "slack") app.use("/api/connectors", slackConnectorRoutes(db));
      else app.use("/api", gmailRoutes(db));
      app.use(errorHandler);
      return app;
    }

    it("the resolver does fall back to the steward's private connection for the agent", async () => {
      const { company, agent, stewardPrivate } = await seedStewarded("slack");
      const r = await connectorService(db).resolveActingAs(company.id, agent.id, "send", "slack", {
        connectionId: stewardPrivate.id,
      });
      expect(r.ok).toBe(true);
    });

    it("slack: a colleague naming the stewarded agent cannot send with the steward's private token", async () => {
      const { company, agent, colleague, stewardPrivate } = await seedStewarded("slack");
      const res = await request(appAs(colleague, company.id, "owner", "slack"))
        .post("/api/connectors/slack/send")
        .send({ companyId: company.id, connectionId: stewardPrivate.id, channel: "C1", text: "hi", agentId: agent.id });
      expect(res.status).toBe(403);
      expect(slackTokensUsed).toHaveLength(0);
    });

    it("slack: the steward can send through their agent with their own private connection", async () => {
      const { company, agent, steward, stewardPrivate } = await seedStewarded("slack");
      const res = await request(appAs(steward, company.id, "operator", "slack"))
        .post("/api/connectors/slack/send")
        .send({ companyId: company.id, connectionId: stewardPrivate.id, channel: "C1", text: "hi", agentId: agent.id });
      expect(res.status).toBe(200);
      expect(slackTokensUsed).toEqual(["token-steward-private"]);
    });

    it("gmail: a colleague naming the stewarded agent cannot send from the steward's private mailbox", async () => {
      const { company, agent, colleague, stewardPrivate } = await seedStewarded("google");
      const res = await request(appAs(colleague, company.id, "owner", "gmail"))
        .post(`/api/companies/${company.id}/connectors/gmail/${stewardPrivate.id}/send`)
        .send({ to: "x@example.com", subject: "s", body: "b", agentId: agent.id });
      expect(res.status).toBe(403);
      expect(gmailSendCalls).toHaveLength(0);
    });

    it("gmail: the steward can send through their agent from their own private mailbox", async () => {
      const { company, agent, steward, stewardPrivate } = await seedStewarded("google");
      const res = await request(appAs(steward, company.id, "owner", "gmail"))
        .post(`/api/companies/${company.id}/connectors/gmail/${stewardPrivate.id}/send`)
        .send({ to: "x@example.com", subject: "s", body: "b", agentId: agent.id });
      expect(res.status).toBe(200);
      expect(gmailSendCalls).toEqual([stewardPrivate.id]);
    });
  });
});
