import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentStewardships,
  agents,
  approvals,
  bridgeEndpoints,
  bridgeTasks,
  channelCallbackTokens,
  channelPairingChallenges,
  companies,
  companyMemberships,
  createDb,
  externalChannelEvents,
  humanChannelBindings,
  workflowEvents,
} from "@paperclipai/db";
import { HUMAN_CHANNEL_PROVIDERS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { bridgeRoutes } from "../routes/bridge.js";
import { humanChannelRoutes } from "../routes/human-channels.js";
import { teamsConnectorRoutes } from "../routes/teams-connector.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { bridgeService } from "../services/bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const TENANT = "tenant-mk";
const AAD_ID = "aad-steward-1";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

/**
 * AgentDash-MK Slice D — Teams delivery.
 *
 * Teams is the notification channel for every stalled escalation, which is why
 * it moved from parked to critical path. The security-critical half already
 * existed: opaque callback tokens, a single decision boundary, replay refused
 * at the token. What did not exist was anything that DELIVERED a card, or any
 * way to create a Teams binding at all.
 *
 * The property these tests defend, in one line: **the button is never the
 * authority.** What travels to Teams is an opaque handle; what comes back is
 * re-resolved against current state and spent exactly once.
 */
describe("teams delivery caller existence", () => {
  /**
   * G1, and the gate the plan names for this slice specifically.
   *
   * `buildApprovalKeyboard` shipped here with nine passing tests and no caller
   * outside them; `buildApprovalCard` and `resolveConversationReference` were
   * the same shape one connector over. A function only its own tests call is a
   * function that has never run in production, and no amount of coverage on it
   * says otherwise.
   *
   * Reads from disk rather than from a list, so a future refactor that deletes
   * the caller fails here instead of quietly restoring the defect.
   */
  function sourceFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const absolute = path.join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        out.push(...sourceFilesUnder(absolute));
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(absolute);
    }
    return out;
  }

  const definingFile = path.join(repoRoot, "server/src/services/teams-connector.ts");

  it.each(["buildApprovalCard", "resolveConversationReference"])(
    "%s is called from production code outside its own module",
    (fnName) => {
      const callers = sourceFilesUnder(path.join(repoRoot, "server/src"))
        .filter((file) => file !== definingFile)
        .filter((file) => new RegExp(`\\.${fnName}\\s*\\(`).test(readFileSync(file, "utf8")))
        .map((file) => path.relative(repoRoot, file));

      expect(
        callers,
        `${fnName} has no non-test caller; it is tested code that has never run`,
      ).not.toHaveLength(0);
    },
  );
});

describeEmbeddedPostgres("agentdash-mk teams delivery", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  /** A stand-in for both the Entra token authority and the Bot Framework. */
  let botServer: Server | null = null;
  let botBaseUrl = "";
  let sentActivities: Array<{ path: string; auth: string | undefined; body: any }> = [];
  let tokenRequests = 0;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-teams-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    sentActivities = [];
    tokenRequests = 0;
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.post("/oauth2/token", (_req, res) => {
      tokenRequests += 1;
      res.json({ access_token: "bot-access-token", expires_in: 3600 });
    });
    app.all(/.*/, (req, res) => {
      sentActivities.push({
        path: req.path,
        auth: req.header("authorization"),
        body: req.body,
      });
      res.json({ id: randomUUID() });
    });
    botServer = createServer(app);
    await new Promise<void>((resolve) => botServer!.listen(0, "127.0.0.1", resolve));
    const address = botServer.address();
    if (!address || typeof address === "string") throw new Error("no port");
    botBaseUrl = `http://127.0.0.1:${address.port}`;

    for (const key of [
      "TEAMS_BOT_APP_ID",
      "TEAMS_BOT_APP_PASSWORD",
      "TEAMS_BOT_TOKEN_URL",
    ] as const) {
      savedEnv[key] = process.env[key];
    }
    process.env.TEAMS_BOT_APP_ID = "bot-app-id";
    process.env.TEAMS_BOT_APP_PASSWORD = "bot-app-password";
    process.env.TEAMS_BOT_TOKEN_URL = `${botBaseUrl}/oauth2/token`;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (botServer?.listening) {
      await new Promise<void>((resolve, reject) =>
        botServer!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    botServer = null;

    await db.delete(workflowEvents);
    await db.delete(activityLog);
    await db.delete(channelCallbackTokens);
    await db.delete(channelPairingChallenges);
    await db.delete(externalChannelEvents);
    await db.delete(humanChannelBindings);
    await db.delete(bridgeTasks);
    await db.delete(bridgeEndpoints);
    await db.delete(approvals);
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
        name: `Teams ${randomUUID()}`,
        issuePrefix: `TD${randomUUID().slice(0, 6).toUpperCase()}`,
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
        name: `Agent ${randomUUID().slice(0, 8)}`,
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

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, source: "agent_key", companyIds: [companyId] };
  }

  function createApp(
    mount: (app: express.Express) => void,
    actor?: Record<string, unknown>,
  ) {
    const app = express();
    app.use(express.json());
    if (actor) {
      app.use((req, _res, next) => {
        (req as any).actor = { ...actor, companyIds: [...((actor.companyIds as string[]) ?? [])] };
        next();
      });
    }
    mount(app);
    app.use(errorHandler);
    return app;
  }

  async function call(app: express.Express, build: (baseUrl: string) => request.Test) {
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

  /**
   * Stand-in for the SDK's activity-token validation.
   *
   * Identity comes from the validator, exactly as it does in production — the
   * route never reads `from` off the body itself. This one derives it from the
   * body only so a test can post as two different accounts.
   */
  const acceptActor = async (req: express.Request) => ({
    tenantId: (req.body?.channelData?.tenant?.id as string | undefined) ?? TENANT,
    aadObjectId: (req.body?.from?.aadObjectId as string | undefined) ?? AAD_ID,
  });

  /** Outbound activities that actually carried a card, not a text notice. */
  function approvalCards() {
    return sentActivities.filter((activity) => activity.body?.attachments?.length);
  }

  /** What a Teams client would send after following the pairing deep link. */
  function messageFromDeepLink(deepLink: string): string {
    const message = new URL(deepLink).searchParams.get("message");
    return message ?? "";
  }

  function teamsApp() {
    return createApp((app) =>
      app.use("/api", teamsConnectorRoutes(db, { verifyActivity: acceptActor })),
    );
  }

  /**
   * Pair a Teams account THROUGH THE REAL ROUTES (G3): a board user asks for a
   * pairing link, and the bot endpoint receives the token back from the account
   * that claims it.
   */
  async function pairTeams(companyId: string, userId: string) {
    const pairingApp = createApp(
      (app) => app.use("/api", humanChannelRoutes(db)),
      boardActor(companyId, userId),
    );
    const minted = await call(pairingApp, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${companyId}/me/channels/teams/pairing`).send({}),
    );
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);

    // The token is never echoed beside the link — the link is the only thing a
    // user should handle. Reading it back out of the deep link is exactly what
    // their Teams client does when it prefills the message.
    expect(minted.body.pairingToken, "the raw pairing token was echoed").toBeUndefined();
    const prefill = messageFromDeepLink(String(minted.body.deepLink ?? ""));
    expect(prefill, "the pairing link prefills nothing to send").not.toBe("");

    const delivered = await call(teamsApp(), (baseUrl) =>
      request(baseUrl)
        .post("/api/connectors/teams/messages")
        .send({
          id: `activity-${randomUUID()}`,
          type: "message",
          text: prefill,
          serviceUrl: `${botBaseUrl}/`,
          conversation: { id: "conversation-1" },
          from: { aadObjectId: AAD_ID },
          channelData: { tenant: { id: TENANT } },
        }),
    );
    expect(delivered.status).toBe(200);

    return db
      .select()
      .from(humanChannelBindings)
      .where(eq(humanChannelBindings.companyId, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function enrolledEndpoint(companyId: string, userId: string, approverId: string) {
    const svc = bridgeService(db);
    const enrollment = await svc.requestEnrollment(companyId, {
      userId,
      label: "work laptop",
      capabilities: ["bridge:read", "bridge:act"],
    });
    return svc.approveEnrollment(companyId, enrollment.enrollmentId, approverId);
  }

  // -- D3: a Teams binding can be created through the real route -------------

  it("creates a verified teams binding through the pairing ceremony", async () => {
    const { company, steward } = await seed();
    const binding = await pairTeams(company.id, steward.principalId);

    expect(binding, "no teams binding exists after the full pairing ceremony").not.toBeNull();
    expect(binding!.provider).toBe("teams");
    expect(binding!.userId).toBe(steward.principalId);
    expect(binding!.externalUserId).toBe(AAD_ID);
    expect(binding!.externalTenantId).toBe(TENANT);
    // The proactive send needs conversation coordinates, and the ONLY honest
    // source for them is the verified activity the account itself sent.
    expect((binding!.metadata as any)?.serviceUrl).toBe(`${botBaseUrl}/`);
    expect(binding!.verifiedAt).not.toBeNull();
  });

  it("spends a teams pairing token exactly once", async () => {
    const { company, steward } = await seed();
    const pairingApp = createApp(
      (app) => app.use("/api", humanChannelRoutes(db)),
      boardActor(company.id, steward.principalId),
    );
    const minted = await call(pairingApp, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/me/channels/teams/pairing`).send({}),
    );
    const prefill = messageFromDeepLink(String(minted.body.deepLink ?? ""));

    for (const suffix of ["first", "second"]) {
      await call(teamsApp(), (baseUrl) =>
        request(baseUrl)
          .post("/api/connectors/teams/messages")
          .send({
            id: `activity-${suffix}-${randomUUID()}`,
            type: "message",
            text: prefill,
            serviceUrl: `${botBaseUrl}/`,
            conversation: { id: `conversation-${suffix}` },
            from: { aadObjectId: `${AAD_ID}-${suffix}` },
            channelData: { tenant: { id: TENANT } },
          }),
      );
    }

    const bindings = await db.select().from(humanChannelBindings);
    expect(bindings, "a replayed pairing token bound a second account").toHaveLength(1);
    expect(bindings[0].externalUserId).toBe(`${AAD_ID}-first`);
  });

  // -- the self-assert guard must NOT have loosened -------------------------

  it("refuses to bind ANY provider by asserted identity, teams included", async () => {
    const { company, steward } = await seed();
    const app = createApp(
      (a) => a.use("/api", humanChannelRoutes(db)),
      boardActor(company.id, steward.principalId),
    );

    for (const provider of HUMAN_CHANNEL_PROVIDERS) {
      const res = await call(app, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${company.id}/me/channels`)
          .send({ provider, externalUserId: "someone-elses-id" }),
      );
      expect(
        res.status,
        `${provider} accepted an identity the caller merely asserted`,
      ).toBe(400);
    }

    const bindings = await db.select().from(humanChannelBindings);
    expect(bindings, "a self-asserted identity produced a binding").toHaveLength(0);
  });

  // -- D2 + D4: a stalled escalation delivers to Teams, at the route level ---

  it("delivers an approval card to Teams when an agent opens an act escalation", async () => {
    const { company, owner, steward, agent } = await seed();
    await pairTeams(company.id, steward.principalId);
    const endpoint = await enrolledEndpoint(company.id, steward.principalId, owner.principalId);

    const bridgeApp = createApp(
      (app) => app.use("/api", bridgeRoutes(db)),
      agentActor(company.id, agent.id),
    );
    const res = await call(bridgeApp, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/bridge/tasks`)
        .send({
          endpointId: endpoint.endpointId,
          taskClass: "act",
          instruction: "rotate the deploy key",
        }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.awaitingApproval).toBe(true);

    const cards = approvalCards();
    expect(cards, "the escalation notified nobody on Teams").not.toHaveLength(0);

    const card = cards[0];
    expect(card.path).toContain("conversation-1");
    // Bot Framework outbound is authenticated; an unauthenticated POST would be
    // refused by the real service and must be refused by our own expectations.
    expect(card.auth, "the outbound activity carried no bearer token").toMatch(/^Bearer /);
    expect(tokenRequests).toBeGreaterThan(0);

    const attachment = card.body?.attachments?.[0];
    expect(attachment?.contentType).toBe("application/vnd.microsoft.card.adaptive");
    const actions = attachment?.content?.actions ?? [];
    expect(actions.map((action: any) => action.title).sort()).toEqual(["Approve", "Reject"]);

    // The button is NOT the authority. What travels is an opaque handle, and
    // nothing in the card names the approval, the revision, or the decision in
    // a form a client could edit.
    const serialized = JSON.stringify(card.body);
    expect(serialized).not.toContain(res.body.approvalId);
    for (const action of actions) {
      expect(Object.keys(action.data)).toEqual(["token"]);
      const minted = await db
        .select()
        .from(channelCallbackTokens)
        .where(eq(channelCallbackTokens.token, action.data.token))
        .then((rows) => rows[0] ?? null);
      expect(minted, "a card action carried a token no server row backs").not.toBeNull();
      expect(minted!.approvalId).toBe(res.body.approvalId);
      expect(minted!.provider).toBe("teams");
    }
  });

  // -- D6: the escalation is measured ---------------------------------------

  it("emits escalation_opened for the run the Teams card belongs to", async () => {
    const { company, owner, steward, agent } = await seed();
    await pairTeams(company.id, steward.principalId);
    const endpoint = await enrolledEndpoint(company.id, steward.principalId, owner.principalId);

    const bridgeApp = createApp(
      (app) => app.use("/api", bridgeRoutes(db)),
      agentActor(company.id, agent.id),
    );
    const res = await call(bridgeApp, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/bridge/tasks`)
        .send({
          endpointId: endpoint.endpointId,
          taskClass: "act",
          instruction: "rotate the deploy key",
        }),
    );

    const events = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, res.body.taskId));
    const opened = events.find((event) => event.eventType === "escalation_opened");
    expect(opened, "the escalation that produced a Teams card was not measured").toBeTruthy();
    expect(opened!.actorKind).toBe("agent");
    expect(opened!.payload).toMatchObject({ taskClass: "act", approvalGated: true });
    // Measurement records what KIND of work stalled, never whose laptop it is.
    expect(JSON.stringify(events)).not.toContain(steward.principalId);
  });

  // -- D5 adversarial: the button is never the authority --------------------

  it("refuses a decision that arrives without a valid callback token", async () => {
    const { company, owner, steward, agent } = await seed();
    await pairTeams(company.id, steward.principalId);
    const endpoint = await enrolledEndpoint(company.id, steward.principalId, owner.principalId);

    const bridgeApp = createApp(
      (app) => app.use("/api", bridgeRoutes(db)),
      agentActor(company.id, agent.id),
    );
    const created = await call(bridgeApp, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/bridge/tasks`)
        .send({
          endpointId: endpoint.endpointId,
          taskClass: "act",
          instruction: "rotate the deploy key",
        }),
    );
    const approvalId = created.body.approvalId as string;

    // Three ways a client might try to decide without holding a real handle:
    // a token it invented, a token that belongs to nothing, and the approval id
    // itself — which is exactly what a card that WAS the authority would carry.
    for (const forged of [randomUUID(), "approved", approvalId]) {
      const res = await call(teamsApp(), (baseUrl) =>
        request(baseUrl)
          .post("/api/connectors/teams/messages")
          .send({
            id: `activity-${randomUUID()}`,
            type: "invoke",
            from: { aadObjectId: AAD_ID },
            channelData: { tenant: { id: TENANT } },
            value: { action: { data: { token: forged } } },
          }),
      );
      // Teams invokes are answered 200 with the refusal in the card body; a
      // non-2xx would make Teams retry a denied action forever.
      expect(res.status).toBe(200);
      expect(String(res.body.value ?? "")).toMatch(/expired|not permitted|no longer/i);
    }

    const approval = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0]!);
    expect(approval.status, "a forged token decided a real approval").toBe("pending");
    expect(approval.decidedByUserId).toBeNull();

    const task = await db
      .select()
      .from(bridgeTasks)
      .where(eq(bridgeTasks.approvalId, approvalId))
      .then((rows) => rows[0]!);
    expect(task.status, "a forged token released work onto a laptop").toBe("awaiting_approval");
  });

  it("refuses a replayed callback token", async () => {
    const { company, owner, steward, agent } = await seed();
    await pairTeams(company.id, steward.principalId);
    const endpoint = await enrolledEndpoint(company.id, steward.principalId, owner.principalId);

    const bridgeApp = createApp(
      (app) => app.use("/api", bridgeRoutes(db)),
      agentActor(company.id, agent.id),
    );
    const created = await call(bridgeApp, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/bridge/tasks`)
        .send({
          endpointId: endpoint.endpointId,
          taskClass: "act",
          instruction: "rotate the deploy key",
        }),
    );
    const approvalId = created.body.approvalId as string;

    const card = approvalCards()[0];
    const approveToken = card.body.attachments[0].content.actions.find(
      (action: any) => action.title === "Approve",
    ).data.token;

    async function invoke() {
      return call(teamsApp(), (baseUrl) =>
        request(baseUrl)
          .post("/api/connectors/teams/messages")
          .send({
            // A DIFFERENT activity id each time, so the inbound dedup cannot be
            // what refuses the replay. The token itself has to be single-use.
            id: `activity-${randomUUID()}`,
            type: "invoke",
            from: { aadObjectId: AAD_ID },
            channelData: { tenant: { id: TENANT } },
            value: { action: { data: { token: approveToken } } },
          }),
      );
    }

    const first = await invoke();
    expect(String(first.body.value ?? "")).toMatch(/approved/i);

    const replay = await invoke();
    expect(String(replay.body.value ?? "")).toMatch(/expired/i);

    const decided = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0]!);
    expect(decided.status).toBe("approved");

    const spent = await db
      .select()
      .from(channelCallbackTokens)
      .where(eq(channelCallbackTokens.token, approveToken))
      .then((rows) => rows[0]!);
    expect(spent.consumedAt, "a callback token survived being used").not.toBeNull();
  });

  // -- default-profile behaviour is unchanged -------------------------------

  it("404s the teams pairing route outside the mk profile", async () => {
    const { company, steward } = await seed("default");
    const app = createApp(
      (a) => a.use("/api", humanChannelRoutes(db)),
      boardActor(company.id, steward.principalId),
    );
    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/me/channels/teams/pairing`).send({}),
    );
    expect(res.status, "a profile-only route answered 403 instead of 404").toBe(404);
  });
});
