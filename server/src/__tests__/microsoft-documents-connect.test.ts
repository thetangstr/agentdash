// AgentDash (per-steward document access, slice 2): a person connects their
// own Microsoft 365 account from My Agent with authorization code + PKCE, and
// the server keeps a refresh token so access outlives the first hour.
//
// Against a real database and a local HTTP server standing in for both the
// Microsoft identity platform (authorize/token) and Microsoft Graph (`/me`).
// Nothing here calls Microsoft. Connections are created only through the
// production routes, never hand-built, so the tests exercise the same row
// shape that slice 1's resolver reads.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentStewardships,
  agents,
  companies,
  companyMemberships,
  connections,
  createDb,
  featureFlags,
} from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { microsoftDocumentsRoutes } from "../routes/microsoft-documents.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { connectorService } from "../services/connectors.js";
import { featureFlagsService } from "../services/feature-flags.js";
import {
  __resetMicrosoftGraphAuthState,
  MICROSOFT_READ_SCOPES,
  MicrosoftGraphAuthError,
  microsoftGraphAuthService,
} from "../services/microsoft-graph-auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const TENANT = "tenant-under-test";
const REDIRECT_URI = "https://agentdash.example.test/connect/microsoft/callback";
const PUBLIC_URL = "https://agentdash.example.test";
// Every variable `mintingOrigins()` / `configuredPublicBaseUrl()` read, so the
// host environment never decides which redirect URI these tests accept.
const ORIGIN_ENV_KEYS = [
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_CANONICAL_ORIGIN",
  "PAPERCLIP_ORIGINS",
  "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
] as const;
const ENV_KEYS = [
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "ENTRA_CLIENT_SECRET",
  "ENTRA_AUTHORITY_URL",
  "MICROSOFT_GRAPH_BASE_URL",
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  ...ORIGIN_ENV_KEYS,
] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitUntil(condition: () => boolean, what: string) {
  for (let i = 0; i < 300 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 10));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("microsoft-graph-auth source (slice 2)", () => {
  const source = readFileSync(path.join(repoRoot, "server/src/services/microsoft-graph-auth.ts"), "utf8");

  it("never asks for tenant-wide write scopes (D5, D11)", () => {
    expect(source).not.toMatch(/Files\.ReadWrite\.All/);
    expect(source).not.toMatch(/Sites\.ReadWrite\.All/);
  });

  it("has a non-test caller: the routes are mounted in app.ts", () => {
    const app = readFileSync(path.join(repoRoot, "server/src/app.ts"), "utf8");
    expect(app.includes("microsoftDocumentsRoutes(")).toBe(true);
  });
});

describeEmbeddedPostgres("Microsoft connect from My Agent (slice 2)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const savedEnv: Record<string, string | undefined> = {};

  let msServer: Server | null = null;
  let msBaseUrl = "";

  type TokenCall = Record<string, string>;
  type GraphCall = { method: string; path: string; bearer: string };
  let tokenCalls: TokenCall[] = [];
  let graphCalls: GraphCall[] = [];
  type MockResponse = { status: number; body: unknown };
  let tokenHandler: (call: TokenCall) => MockResponse | Promise<MockResponse>;
  /** The default Microsoft: echoes the requested scopes, like a plain consent. */
  let echoTokenHandler: (call: TokenCall) => MockResponse;
  let meHandler: (bearer: string) => { status: number; body: unknown };
  let issued = 0;

  // Person A and Person B are members of the flagged company; Agent A is
  // stewarded by Person A. A second company has the flag off.
  let FLAGGED = "";
  let UNFLAGGED = "";
  let PERSON_A = "";
  let PERSON_B = "";
  let AGENT_A = "";

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    home = await mkdtemp(path.join(tmpdir(), "microsoft-connect-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "microsoft-connect-test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "d".repeat(64);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ms-connect-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    __resetMicrosoftGraphAuthState();
    tokenCalls = [];
    graphCalls = [];
    issued = 0;

    // Default Microsoft: every code and refresh token is honoured, each
    // response carries a fresh, distinguishable access and refresh token, and
    // the granted scopes are exactly the requested ones (code and refresh).
    echoTokenHandler = (call) => {
      issued += 1;
      const scope = (call.scope ?? "")
        .split(" ")
        .filter((s) => s && !["openid", "profile", "offline_access"].includes(s))
        .concat(["openid", "profile"])
        .join(" ");
      return {
        status: 200,
        body: {
          token_type: "Bearer",
          access_token: `access-${issued}-${randomUUID()}`,
          refresh_token: `refresh-${issued}-${randomUUID()}`,
          expires_in: 3600,
          scope,
        },
      };
    };
    tokenHandler = echoTokenHandler;
    meHandler = () => ({
      status: 200,
      body: { id: "graph-user-a", userPrincipalName: "person.a@tenant.example.test", displayName: "Person A" },
    });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.post(`/entra/${TENANT}/oauth2/v2.0/token`, async (req, res) => {
      const call = Object.fromEntries(Object.entries(req.body as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      tokenCalls.push(call);
      const { status, body } = await tokenHandler(call);
      res.status(status).json(body);
    });
    app.all(/^\/graph\/.*/, (req, res) => {
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      graphCalls.push({ method: req.method, path: req.originalUrl.slice("/graph".length), bearer });
      const { status, body } = meHandler(bearer);
      res.status(status).json(body);
    });
    msServer = createServer(app);
    await new Promise<void>((resolve) => msServer!.listen(0, "127.0.0.1", resolve));
    const address = msServer.address();
    if (!address || typeof address === "string") throw new Error("no port");
    msBaseUrl = `http://127.0.0.1:${address.port}`;

    process.env.ENTRA_TENANT_ID = TENANT;
    process.env.ENTRA_CLIENT_ID = "app-client-id";
    process.env.ENTRA_CLIENT_SECRET = "app-client-secret";
    process.env.ENTRA_AUTHORITY_URL = `${msBaseUrl}/entra`;
    process.env.MICROSOFT_GRAPH_BASE_URL = `${msBaseUrl}/graph`;
    for (const key of ORIGIN_ENV_KEYS) delete process.env[key];
    process.env.PAPERCLIP_PUBLIC_URL = PUBLIC_URL;

    // Fixtures.
    const [flagged, unflagged] = await db
      .insert(companies)
      .values([
        { name: `Flagged ${randomUUID()}`, issuePrefix: `MF${randomUUID().slice(0, 5).toUpperCase()}` },
        { name: `Plain ${randomUUID()}`, issuePrefix: `MP${randomUUID().slice(0, 5).toUpperCase()}` },
      ])
      .returning();
    FLAGGED = flagged!.id;
    UNFLAGGED = unflagged!.id;
    PERSON_A = `person-a-${randomUUID()}`;
    PERSON_B = `person-b-${randomUUID()}`;
    for (const companyId of [FLAGGED, UNFLAGGED]) {
      for (const userId of [PERSON_A, PERSON_B]) {
        await db.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "member",
        });
      }
    }
    await featureFlagsService(db).set(FLAGGED, FEATURE_FLAG_KEYS.DOCUMENT_ACCESS, true);
    const agent = await db
      .insert(agents)
      .values({ companyId: FLAGGED, name: "Agent A", role: "engineer", status: "idle", adapterType: "process" })
      .returning()
      .then((rows) => rows[0]!);
    AGENT_A = agent.id;
    await agentStewardshipService(db).assign(FLAGGED, {
      agentId: AGENT_A,
      userId: PERSON_A,
      assignedByUserId: PERSON_A,
    });
  });

  afterEach(async () => {
    for (const key of ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_AUTHORITY_URL", "MICROSOFT_GRAPH_BASE_URL", ...ORIGIN_ENV_KEYS]) {
      delete process.env[key];
    }
    if (msServer?.listening) {
      await new Promise<void>((resolve, reject) => msServer!.close((e) => (e ? reject(e) : resolve())));
    }
    msServer = null;
    await db.delete(activityLog);
    await db.delete(connections);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(featureFlags);
    await db.delete(companies);
  });

  // -- helpers --------------------------------------------------------------

  function appAs(actor: Record<string, unknown>, routeOpts?: Parameters<typeof microsoftDocumentsRoutes>[1]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", microsoftDocumentsRoutes(db, routeOpts));
    app.use(errorHandler);
    return app;
  }

  const asPerson = (userId: string, routeOpts?: Parameters<typeof microsoftDocumentsRoutes>[1]) =>
    appAs({
      type: "board",
      source: "session",
      userId,
      companyIds: [FLAGGED, UNFLAGGED],
      memberships: [
        { companyId: FLAGGED, membershipRole: "member", status: "active" },
        { companyId: UNFLAGGED, membershipRole: "member", status: "active" },
      ],
    }, routeOpts);

  const base = (companyId: string) => `/api/companies/${companyId}/me/connections/microsoft`;

  async function initiate(userId: string, tier: "read" | "read_propose" = "read", companyId = FLAGGED) {
    const res = await request(asPerson(userId))
      .post(`${base(companyId)}/oauth/initiate`)
      .send({ redirectUri: REDIRECT_URI, tier });
    return res;
  }

  function authorizeParams(authorizationUrl: string) {
    const url = new URL(authorizationUrl);
    return { url, params: url.searchParams };
  }

  async function connect(userId: string, tier: "read" | "read_propose" = "read") {
    const started = await initiate(userId, tier);
    expect(started.status).toBe(200);
    const { params } = authorizeParams(started.body.authorizationUrl);
    const code = `auth-code-${randomUUID()}`;
    const done = await request(asPerson(userId))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ code, state: params.get("state"), redirectUri: REDIRECT_URI });
    return { started, done, code, params };
  }

  async function rowsFor(userId: string) {
    return db
      .select()
      .from(connections)
      .where(and(eq(connections.provider, "microsoft"), eq(connections.ownerId, userId)));
  }

  // -- gate -----------------------------------------------------------------

  it("answers 404 on every route while the company's flag is off", async () => {
    const app = asPerson(PERSON_A);
    const responses = await Promise.all([
      request(app).get(base(UNFLAGGED)),
      request(app).post(`${base(UNFLAGGED)}/oauth/initiate`).send({ redirectUri: REDIRECT_URI, tier: "read" }),
      request(app).post(`${base(UNFLAGGED)}/oauth/callback`).send({ code: "x", state: "y:z", redirectUri: REDIRECT_URI }),
      request(app).post(`${base(UNFLAGGED)}/revoke`).send({}),
    ]);
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(await rowsFor(PERSON_A)).toHaveLength(0);
  });

  it("refuses agents: the connection is the person's own", async () => {
    const app = appAs({ type: "agent", agentId: AGENT_A, companyId: FLAGGED, source: "agent_key" });
    const res = await request(app).post(`${base(FLAGGED)}/oauth/initiate`).send({ redirectUri: REDIRECT_URI, tier: "read" });
    expect(res.status).toBe(403);
    expect(await rowsFor(AGENT_A)).toHaveLength(0);
  });

  it("says plainly that Microsoft sign-in is not configured when ENTRA_* is missing", async () => {
    delete process.env.ENTRA_CLIENT_SECRET;
    const res = await initiate(PERSON_A);
    expect(res.status).toBe(503);
    expect(res.body.code ?? res.body.details?.code).toBe("microsoft_not_configured");
    expect(String(res.body.error)).toMatch(/not configured/i);
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.status).toBe(200);
    expect(health.body.configured).toBe(false);
    expect(await rowsFor(PERSON_A)).toHaveLength(0);
  });

  // -- initiate ---------------------------------------------------------------

  it("builds the authorize URL with PKCE and only the read scopes for the read tier", async () => {
    const res = await initiate(PERSON_A, "read");
    expect(res.status).toBe(200);
    const { url, params } = authorizeParams(res.body.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${msBaseUrl}/entra/${TENANT}/oauth2/v2.0/authorize`);
    expect(params.get("client_id")).toBe("app-client-id");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(params.get("scope")!.split(" "))).toEqual(
      new Set(["openid", "profile", "offline_access", "User.Read", "Files.Read.All", "Sites.Read.All"]),
    );
    // The browser sees the challenge, never the verifier or the client secret.
    expect(res.text).not.toContain("app-client-secret");
    expect(JSON.stringify(res.body)).not.toMatch(/verifier/i);
  });

  it("adds Files.ReadWrite and User.ReadBasic.All, and nothing tenant-wide, for read_propose", async () => {
    const res = await initiate(PERSON_A, "read_propose");
    const scopes = new Set(authorizeParams(res.body.authorizationUrl).params.get("scope")!.split(" "));
    expect(scopes.has("Files.ReadWrite")).toBe(true);
    expect(scopes.has("User.ReadBasic.All")).toBe(true);
    expect(scopes.has("Files.ReadWrite.All")).toBe(false);
    expect(scopes.has("Sites.ReadWrite.All")).toBe(false);
    for (const read of MICROSOFT_READ_SCOPES) expect(scopes.has(read)).toBe(true);
  });

  it("refuses a redirect URI that is not the Microsoft callback page", async () => {
    const res = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/initiate`)
      .send({ redirectUri: "https://attacker.example.test/steal", tier: "read" });
    expect(res.status).toBe(400);
    const insecure = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/initiate`)
      .send({ redirectUri: "http://agentdash.example.test/connect/microsoft/callback", tier: "read" });
    expect(insecure.status).toBe(400);
    expect(await rowsFor(PERSON_A)).toHaveLength(0);
  });

  it("reuses the person's pending row, so repeated or concurrent initiates never trip the unique index", async () => {
    const [first, second] = await Promise.all([initiate(PERSON_A), initiate(PERSON_A)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const third = await initiate(PERSON_A);
    expect(third.status).toBe(200);
    const rows = await rowsFor(PERSON_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.encryptedToken).toBeNull();
    expect(rows[0]!.visibility).toBe("private");
    expect(rows[0]!.ownerType).toBe("user");
    // Only the newest state is live: an older authorize URL cannot complete.
    const stale = authorizeParams(first.body.authorizationUrl).params.get("state");
    const latest = authorizeParams(third.body.authorizationUrl).params.get("state");
    expect(stale).not.toBe(latest);
    const res = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ code: "c", state: stale, redirectUri: REDIRECT_URI });
    expect(res.status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
  });

  // -- callback -------------------------------------------------------------

  it("exchanges the code with the PKCE verifier and stores an encrypted refresh token, never the code", async () => {
    const { done, code, params } = await connect(PERSON_A, "read");
    expect(done.status).toBe(200);

    expect(tokenCalls).toHaveLength(1);
    const call = tokenCalls[0]!;
    expect(call.grant_type).toBe("authorization_code");
    expect(call.code).toBe(code);
    expect(call.redirect_uri).toBe(REDIRECT_URI);
    expect(call.client_id).toBe("app-client-id");
    expect(call.client_secret).toBe("app-client-secret");
    // The verifier the server sent hashes to the challenge the browser carried.
    expect(base64Url(createHash("sha256").update(call.code_verifier!).digest())).toBe(params.get("code_challenge"));
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]!.method).toBe("GET");
    expect(graphCalls[0]!.path.split("?")[0]).toBe("/me");
    expect(graphCalls[0]!.bearer).toMatch(/^access-1-/);

    const rows = await rowsFor(PERSON_A);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.accountLabel).toBe("person.a@tenant.example.test");
    expect(row.visibility).toBe("private");
    expect(row.ownerType).toBe("user");
    expect(row.status).toBe("active");
    expect(row.oauthState).toBeNull();
    expect(row.scopes).toEqual(expect.arrayContaining(["User.Read", "Files.Read.All", "Sites.Read.All"]));
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain("refresh-1-");
    expect(stored).not.toContain("access-1-");

    const token = await connectorService(db).getDecryptedToken(row.id);
    expect(token?.refreshToken).toMatch(/^refresh-1-/);
    expect(token?.accessToken).toMatch(/^access-1-/);
    expect(Date.parse(token!.expiresAt!)).toBeGreaterThan(Date.now() + 3000_000);

    // The response describes the connection and carries no credential.
    expect(done.body.connection.account).toBe("person.a@tenant.example.test");
    expect(done.body.connection.tier).toBe("read");
    expect(done.text).not.toMatch(/access-1-|refresh-1-|accessToken|refresh_token|refreshToken/);
  });

  it("makes the person's row the one their stewarded agent resolves (slice 1), and only once connected", async () => {
    const connectors = connectorService(db);
    await initiate(PERSON_A);
    const pending = await connectors.resolveActingAs(FLAGGED, AGENT_A, "read", "microsoft");
    expect(pending.ok).toBe(false);

    const second = await initiate(PERSON_A);
    const state = authorizeParams(second.body.authorizationUrl).params.get("state");
    const done = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ code: "code-x", state, redirectUri: REDIRECT_URI });
    expect(done.status).toBe(200);
    const resolved = await connectors.resolveActingAs(FLAGGED, AGENT_A, "read", "microsoft");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.resolution.connectionId).toBe(done.body.connection.id);
  });

  it("refuses a mismatched state and stores nothing", async () => {
    const started = await initiate(PERSON_A);
    const state = authorizeParams(started.body.authorizationUrl).params.get("state")!;
    const [rowId] = state.split(":");
    const res = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ code: "code-y", state: `${rowId}:not-the-token`, redirectUri: REDIRECT_URI });
    expect(res.status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
    const [row] = await rowsFor(PERSON_A);
    expect(row!.encryptedToken).toBeNull();
    // The real state still works afterwards: a guess does not burn it.
    const ok = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ code: "code-y", state, redirectUri: REDIRECT_URI });
    expect(ok.status).toBe(200);
  });

  it("refuses a reused state: the second callback 400s and makes no token call", async () => {
    const { done, params } = await connect(PERSON_A);
    expect(done.status).toBe(200);
    const replay = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ code: "another-code", state: params.get("state"), redirectUri: REDIRECT_URI });
    expect(replay.status).toBe(400);
    expect(tokenCalls).toHaveLength(1);
  });

  it("binds the state to the person who started it", async () => {
    const started = await initiate(PERSON_A);
    const state = authorizeParams(started.body.authorizationUrl).params.get("state");
    const res = await request(asPerson(PERSON_B))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ code: "code-z", state, redirectUri: REDIRECT_URI });
    expect(res.status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
    expect(await rowsFor(PERSON_B)).toHaveLength(0);
    const [row] = await rowsFor(PERSON_A);
    expect(row!.encryptedToken).toBeNull();
  });

  it("refuses a callback whose redirect URI differs from the one the flow started with", async () => {
    const started = await initiate(PERSON_A);
    const state = authorizeParams(started.body.authorizationUrl).params.get("state");
    const res = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ code: "code-r", state, redirectUri: "https://other.example.test/connect/microsoft/callback" });
    expect(res.status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
  });

  it("refuses a token response without a refresh token and records the failure as lastError", async () => {
    tokenHandler = () => ({
      status: 200,
      body: { token_type: "Bearer", access_token: "access-only", expires_in: 3600, scope: "User.Read Files.Read.All" },
    });
    const { done } = await connect(PERSON_A);
    expect(done.status).toBe(502);
    const [row] = await rowsFor(PERSON_A);
    expect(row!.encryptedToken).toBeNull();
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.body.connection.status).toBe("pending");
    expect(health.body.connection.lastError).toEqual(
      expect.objectContaining({ reason: "malformed_token_response" }),
    );
  });

  it("records a declined consent as lastError without exchanging anything", async () => {
    const started = await initiate(PERSON_A);
    const state = authorizeParams(started.body.authorizationUrl).params.get("state");
    const res = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ error: "access_denied", state, redirectUri: REDIRECT_URI });
    expect(res.status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.body.connection.lastError).toEqual(expect.objectContaining({ reason: "consent_declined" }));
  });

  it.each([
    ["consent_required"],
    ["interaction_required"],
  ])("tells the person an administrator must approve when Microsoft answers %s", async (providerError) => {
    const started = await initiate(PERSON_A);
    const state = authorizeParams(started.body.authorizationUrl).params.get("state");
    const res = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ error: providerError, state, redirectUri: REDIRECT_URI });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/administrator/i);
    expect(res.body.error).not.toMatch(/declined/i);
    expect(tokenCalls).toHaveLength(0);
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.body.connection.lastError).toEqual(
      expect.objectContaining({ reason: "admin_consent_required", message: res.body.error }),
    );
  });

  it("keeps the declined message for access_denied and a fixed generic one for anything else Microsoft sends", async () => {
    const declined = await initiate(PERSON_A);
    const declinedRes = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({
        error: "access_denied",
        state: authorizeParams(declined.body.authorizationUrl).params.get("state"),
        redirectUri: REDIRECT_URI,
      });
    expect(declinedRes.status).toBe(400);
    expect(declinedRes.body.error).toMatch(/cancelled or declined/);

    // An unknown code, even one shaped like text to show, is never echoed.
    const other = await initiate(PERSON_A);
    const otherRes = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({
        error: "server_error <Call 555-0100>",
        state: authorizeParams(other.body.authorizationUrl).params.get("state"),
        redirectUri: REDIRECT_URI,
      });
    expect(otherRes.status).toBe(502);
    expect(otherRes.body.error).not.toContain("555-0100");
    expect(otherRes.body.error).not.toMatch(/declined/i);
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.body.connection.lastError).toEqual(expect.objectContaining({ reason: "provider_error" }));
    expect(tokenCalls).toHaveLength(0);
  });

  // -- reconnect --------------------------------------------------------------

  it("reconnects in place: the live token keeps working until the new grant lands, then the tier upgrades", async () => {
    const first = await connect(PERSON_A, "read");
    const connectionId = first.done.body.connection.id;
    const auth = microsoftGraphAuthService(db);
    const before = await auth.tokenForConnection(connectionId);

    const restarted = await initiate(PERSON_A, "read_propose");
    expect(restarted.status).toBe(200);
    // Still one row, still resolvable while the person is at Microsoft.
    expect(await rowsFor(PERSON_A)).toHaveLength(1);
    expect((await auth.tokenForConnection(connectionId)).accessToken).toBe(before.accessToken);

    const state = authorizeParams(restarted.body.authorizationUrl).params.get("state");
    const done = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ code: "code-upgrade", state, redirectUri: REDIRECT_URI });
    expect(done.status).toBe(200);
    expect(done.body.connection.id).toBe(connectionId);
    expect(done.body.connection.tier).toBe("read_propose");
    const rows = await rowsFor(PERSON_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopes).toEqual(expect.arrayContaining(["Files.ReadWrite", "User.ReadBasic.All"]));
    const after = await auth.tokenForConnection(connectionId);
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.grantedScopes).toEqual(expect.arrayContaining(["Files.ReadWrite"]));
  });

  // -- health and revoke ------------------------------------------------------

  it("health describes the connection and never returns token material", async () => {
    const { done } = await connect(PERSON_A, "read_propose");
    const token = await connectorService(db).getDecryptedToken(done.body.connection.id);
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.status).toBe(200);
    expect(health.body.configured).toBe(true);
    expect(health.body.connection).toEqual(
      expect.objectContaining({
        id: done.body.connection.id,
        account: "person.a@tenant.example.test",
        status: "active",
        tier: "read_propose",
        lastError: null,
      }),
    );
    const text = health.text;
    expect(text).not.toContain(token!.accessToken);
    expect(text).not.toContain(token!.refreshToken!);
    expect(text).not.toMatch(/accessToken|refreshToken|refresh_token|access_token|encryptedToken|oauthState|verifier/);

    // Person B sees only their own (absent) connection.
    const other = await request(asPerson(PERSON_B)).get(base(FLAGGED));
    expect(other.body.connection).toBeNull();
  });

  it("revoke clears the credential; the next connect inserts a fresh row", async () => {
    const { done } = await connect(PERSON_A);
    const connectionId = done.body.connection.id;
    const revoked = await request(asPerson(PERSON_A)).post(`${base(FLAGGED)}/revoke`).send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ connectionId, revoked: true });
    const [row] = await rowsFor(PERSON_A);
    expect(row!.encryptedToken).toBeNull();
    expect(row!.revokedAt).not.toBeNull();
    await expect(microsoftGraphAuthService(db).tokenForConnection(connectionId)).rejects.toMatchObject({
      reason: "not_connected",
    });
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.body.connection).toBeNull();

    const again = await connect(PERSON_A);
    expect(again.done.status).toBe(200);
    expect(again.done.body.connection.id).not.toBe(connectionId);

    const nothing = await request(asPerson(PERSON_B)).post(`${base(FLAGGED)}/revoke`).send({});
    expect(nothing.status).toBe(404);
  });

  // -- tokenForConnection -----------------------------------------------------

  async function setExpiry(connectionId: string, msFromNow: number) {
    const connectors = connectorService(db);
    const token = await connectors.getDecryptedToken(connectionId);
    await connectors.refreshToken(connectionId, { ...token!, expiresAt: new Date(Date.now() + msFromNow).toISOString() });
    return token!;
  }

  it("returns the stored access token without calling Microsoft while it is fresh", async () => {
    const { done } = await connect(PERSON_A);
    const before = tokenCalls.length;
    const result = await microsoftGraphAuthService(db).tokenForConnection(done.body.connection.id);
    expect(Object.keys(result).sort()).toEqual(["accessToken", "grantedScopes"]);
    expect(result.accessToken).toMatch(/^access-1-/);
    expect(tokenCalls).toHaveLength(before);
  });

  it("refreshes within 60 s of expiry and persists the new access token and the rotated refresh token", async () => {
    const { done } = await connect(PERSON_A);
    const connectionId = done.body.connection.id;
    const old = await setExpiry(connectionId, 30_000);

    const result = await microsoftGraphAuthService(db).tokenForConnection(connectionId);
    expect(Object.keys(result).sort()).toEqual(["accessToken", "grantedScopes"]);
    expect(JSON.stringify(result)).not.toMatch(/refresh/);
    const refreshCall = tokenCalls.at(-1)!;
    expect(refreshCall.grant_type).toBe("refresh_token");
    expect(refreshCall.refresh_token).toBe(old.refreshToken);
    expect(refreshCall.client_secret).toBe("app-client-secret");

    const stored = await connectorService(db).getDecryptedToken(connectionId);
    expect(stored!.accessToken).toBe(result.accessToken);
    expect(stored!.accessToken).not.toBe(old.accessToken);
    expect(stored!.refreshToken).not.toBe(old.refreshToken);
    expect(stored!.refreshToken).toMatch(/^refresh-2-/);
    expect(Date.parse(stored!.expiresAt!)).toBeGreaterThan(Date.now() + 3000_000);
  });

  it("keeps the old refresh token when Microsoft does not rotate it", async () => {
    const { done } = await connect(PERSON_A);
    const connectionId = done.body.connection.id;
    const old = await setExpiry(connectionId, -1_000);
    tokenHandler = () => ({
      status: 200,
      body: { token_type: "Bearer", access_token: "access-no-rotate", expires_in: 3600, scope: "User.Read Files.Read.All" },
    });
    const result = await microsoftGraphAuthService(db).tokenForConnection(connectionId);
    expect(result.accessToken).toBe("access-no-rotate");
    const stored = await connectorService(db).getDecryptedToken(connectionId);
    expect(stored!.refreshToken).toBe(old.refreshToken);
  });

  it("refreshes once for concurrent callers", async () => {
    const { done } = await connect(PERSON_A);
    const connectionId = done.body.connection.id;
    await setExpiry(connectionId, 10_000);
    const before = tokenCalls.length;
    const auth = microsoftGraphAuthService(db);
    const [a, b] = await Promise.all([auth.tokenForConnection(connectionId), auth.tokenForConnection(connectionId)]);
    expect(a.accessToken).toBe(b.accessToken);
    expect(tokenCalls.length - before).toBe(1);
  });

  it("marks the row error on a refused refresh, surfaces lastError, and stops calling Microsoft", async () => {
    const { done } = await connect(PERSON_A);
    const connectionId = done.body.connection.id;
    await setExpiry(connectionId, -1_000);
    tokenHandler = () => ({ status: 400, body: { error: "invalid_grant", error_description: "AADSTS70000: expired" } });

    const auth = microsoftGraphAuthService(db);
    const failure = await auth.tokenForConnection(connectionId).catch((e) => e);
    expect(failure).toBeInstanceOf(MicrosoftGraphAuthError);
    expect(failure.reason).toBe("reconnect_required");
    const [row] = await rowsFor(PERSON_A);
    expect(row!.status).toBe("error");

    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.body.connection.status).toBe("error");
    expect(health.body.connection.lastError).toEqual(expect.objectContaining({ reason: "reconnect_required" }));
    expect(health.text).not.toContain("AADSTS");

    const calls = tokenCalls.length;
    await expect(auth.tokenForConnection(connectionId)).rejects.toMatchObject({ reason: "reconnect_required" });
    expect(tokenCalls).toHaveLength(calls);

    // Reconnecting clears the error.
    tokenHandler = () => ({
      status: 200,
      body: {
        token_type: "Bearer",
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        scope: "User.Read Files.Read.All Sites.Read.All",
      },
    });
    const again = await connect(PERSON_A);
    expect(again.done.status).toBe(200);
    const healed = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(healed.body.connection.status).toBe("active");
    expect(healed.body.connection.lastError).toBeNull();
  });

  it("does not mark the row error when Microsoft is unreachable", async () => {
    const { done } = await connect(PERSON_A);
    const connectionId = done.body.connection.id;
    await setExpiry(connectionId, -1_000);
    process.env.ENTRA_AUTHORITY_URL = "http://127.0.0.1:1/entra";
    await expect(microsoftGraphAuthService(db).tokenForConnection(connectionId)).rejects.toMatchObject({
      reason: "microsoft_unreachable",
    });
    const [row] = await rowsFor(PERSON_A);
    expect(row!.status).toBe("active");
  });

  it("refuses a connection that is not a Microsoft row", async () => {
    const other = await connectorService(db).create(FLAGGED, {
      ownerType: "user",
      ownerId: PERSON_A,
      provider: "hubspot",
      token: { accessToken: "hubspot-key" },
    });
    await expect(microsoftGraphAuthService(db).tokenForConnection(other.id)).rejects.toMatchObject({
      reason: "not_connected",
    });
  });

  // -- review fixes: the tier is an upper bound ---------------------------------

  async function activityFor(connectionId: string) {
    return db.select().from(activityLog).where(eq(activityLog.entityId, connectionId));
  }

  it("keeps a read-tier connection read-only when Microsoft lists more consented scopes", async () => {
    // Tenant-wide admin consent on a shared app can make Microsoft list scopes
    // nobody asked for. The person chose `read`; that choice is the limit.
    tokenHandler = (call) => {
      issued += 1;
      return {
        status: 200,
        body: {
          token_type: "Bearer",
          access_token: `access-${issued}-${randomUUID()}`,
          refresh_token: `refresh-${issued}-${randomUUID()}`,
          expires_in: 3600,
          scope:
            "openid profile User.Read Files.Read.All Sites.Read.All Files.ReadWrite Files.ReadWrite.All User.ReadBasic.All",
          grant: call.grant_type,
        },
      };
    };
    const { done } = await connect(PERSON_A, "read");
    expect(done.status).toBe(200);
    expect(done.body.connection.tier).toBe("read");
    expect(done.body.connection.writeScopes).toEqual([]);
    const connectionId = done.body.connection.id;
    const [row] = await rowsFor(PERSON_A);
    for (const wide of ["Files.ReadWrite", "Files.ReadWrite.All", "User.ReadBasic.All"]) {
      expect(row!.scopes).not.toContain(wide);
    }
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.body.connection.tier).toBe("read");
    expect(health.body.connection.writeScopes).toEqual([]);

    const fresh = await microsoftGraphAuthService(db).tokenForConnection(connectionId);
    expect(fresh.grantedScopes).not.toContain("Files.ReadWrite");

    // A refresh asks only for the bounded set and stays bounded.
    await setExpiry(connectionId, -1_000);
    const refreshed = await microsoftGraphAuthService(db).tokenForConnection(connectionId);
    const refreshCall = tokenCalls.at(-1)!;
    expect(refreshCall.grant_type).toBe("refresh_token");
    expect(refreshCall.scope!.split(" ")).not.toContain("Files.ReadWrite");
    expect(refreshCall.scope!.split(" ")).not.toContain("User.ReadBasic.All");
    expect(refreshed.grantedScopes).not.toContain("Files.ReadWrite");
    expect(refreshed.grantedScopes).not.toContain("Files.ReadWrite.All");
    const [after] = await rowsFor(PERSON_A);
    expect(after!.scopes).not.toContain("Files.ReadWrite");
  });

  it("refreshes a read_propose connection with its write scope and keeps the tier", async () => {
    const { done } = await connect(PERSON_A, "read_propose");
    const connectionId = done.body.connection.id;
    await setExpiry(connectionId, -1_000);
    const refreshed = await microsoftGraphAuthService(db).tokenForConnection(connectionId);
    const refreshCall = tokenCalls.at(-1)!;
    expect(refreshCall.grant_type).toBe("refresh_token");
    expect(refreshCall.scope!.split(" ")).toEqual(expect.arrayContaining(["Files.ReadWrite", "offline_access"]));
    expect(refreshed.grantedScopes).toEqual(expect.arrayContaining(["Files.ReadWrite", "User.ReadBasic.All"]));
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.body.connection.tier).toBe("read_propose");
  });

  it("treats a code redemption without a scope field as granting the requested scopes", async () => {
    tokenHandler = () => {
      issued += 1;
      return {
        status: 200,
        body: {
          token_type: "Bearer",
          access_token: `access-${issued}-${randomUUID()}`,
          refresh_token: `refresh-${issued}-${randomUUID()}`,
          expires_in: 3600,
        },
      };
    };
    const { done } = await connect(PERSON_A, "read_propose");
    expect(done.status).toBe(200);
    expect(done.body.connection.tier).toBe("read_propose");
    const [row] = await rowsFor(PERSON_A);
    expect(row!.scopes).toEqual(
      expect.arrayContaining(["User.Read", "Files.Read.All", "Sites.Read.All", "Files.ReadWrite"]),
    );
  });

  it("refuses a grant without the read permissions and names what is missing", async () => {
    tokenHandler = () => ({
      status: 200,
      body: {
        token_type: "Bearer",
        access_token: "access-partial",
        refresh_token: "refresh-partial",
        expires_in: 3600,
        scope: "openid profile User.Read",
      },
    });
    const { done } = await connect(PERSON_A, "read");
    expect(done.status).toBe(403);
    expect(done.body.details?.code ?? done.body.code).toBe("consent_incomplete");
    expect(String(done.body.error)).toContain("Files.Read.All");
    expect(String(done.body.error)).toContain("Sites.Read.All");
    const [row] = await rowsFor(PERSON_A);
    expect(row!.encryptedToken).toBeNull();
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.body.connection.status).toBe("pending");
    expect(health.body.connection.lastError).toEqual(expect.objectContaining({ reason: "consent_incomplete" }));
  });

  // -- review fixes: a refresh is tied to the credential it started from -------

  it("does not let an in-flight refresh overwrite a reconnect that finished meanwhile", async () => {
    const first = await connect(PERSON_A, "read");
    const connectionId = first.done.body.connection.id;
    await setExpiry(connectionId, -1_000);

    const gate = deferred<void>();
    tokenHandler = async (call) => {
      if (call.grant_type === "refresh_token") {
        await gate.promise;
        return {
          status: 200,
          body: {
            token_type: "Bearer",
            access_token: "access-stale-refresh",
            refresh_token: "refresh-stale-refresh",
            expires_in: 3600,
            scope: "openid profile User.Read Files.Read.All Sites.Read.All",
          },
        };
      }
      return echoTokenHandler(call);
    };
    const auth = microsoftGraphAuthService(db);
    const inFlight = auth.tokenForConnection(connectionId);
    await waitUntil(() => tokenCalls.some((c) => c.grant_type === "refresh_token"), "the refresh call");

    const upgraded = await connect(PERSON_A, "read_propose");
    expect(upgraded.done.status).toBe(200);
    const reconnected = await connectorService(db).getDecryptedToken(connectionId);

    gate.resolve();
    const result = await inFlight;
    expect(result.accessToken).toBe(reconnected!.accessToken);
    expect(result.accessToken).not.toBe("access-stale-refresh");
    const stored = await connectorService(db).getDecryptedToken(connectionId);
    expect(stored!.accessToken).toBe(reconnected!.accessToken);
    expect(stored!.refreshToken).toBe(reconnected!.refreshToken);
    const [row] = await rowsFor(PERSON_A);
    expect(row!.scopes).toEqual(expect.arrayContaining(["Files.ReadWrite"]));
  });

  it("does not mark a fresh reconnect as error when a stale refresh is refused", async () => {
    const first = await connect(PERSON_A, "read");
    const connectionId = first.done.body.connection.id;
    await setExpiry(connectionId, -1_000);

    const gate = deferred<void>();
    tokenHandler = async (call) => {
      if (call.grant_type === "refresh_token") {
        await gate.promise;
        return { status: 400, body: { error: "invalid_grant" } };
      }
      return echoTokenHandler(call);
    };
    const inFlight = microsoftGraphAuthService(db).tokenForConnection(connectionId);
    await waitUntil(() => tokenCalls.some((c) => c.grant_type === "refresh_token"), "the refresh call");
    const again = await connect(PERSON_A, "read");
    expect(again.done.status).toBe(200);
    const reconnected = await connectorService(db).getDecryptedToken(connectionId);

    gate.resolve();
    const result = await inFlight;
    expect(result.accessToken).toBe(reconnected!.accessToken);
    const [row] = await rowsFor(PERSON_A);
    expect(row!.status).toBe("active");
    const actions = (await activityFor(connectionId)).map((a) => a.action);
    expect(actions).not.toContain("connection.microsoft_refresh_failed");
    const health = await request(asPerson(PERSON_A)).get(base(FLAGGED));
    expect(health.body.connection.status).toBe("active");
    expect(health.body.connection.lastError).toBeNull();
  });

  it("returns no token when the person disconnects while a refresh is in flight", async () => {
    const { done } = await connect(PERSON_A);
    const connectionId = done.body.connection.id;
    await setExpiry(connectionId, -1_000);

    const gate = deferred<void>();
    tokenHandler = async (call) => {
      await gate.promise;
      return echoTokenHandler(call);
    };
    const inFlight = microsoftGraphAuthService(db).tokenForConnection(connectionId).catch((e) => e);
    await waitUntil(() => tokenCalls.some((c) => c.grant_type === "refresh_token"), "the refresh call");
    const revoked = await request(asPerson(PERSON_A)).post(`${base(FLAGGED)}/revoke`).send({});
    expect(revoked.status).toBe(200);

    gate.resolve();
    const failure = await inFlight;
    expect(failure).toBeInstanceOf(MicrosoftGraphAuthError);
    expect(failure.reason).toBe("not_connected");
    const [row] = await rowsFor(PERSON_A);
    expect(row!.encryptedToken).toBeNull();
    expect(row!.revokedAt).not.toBeNull();
  });

  // -- review fixes: untested safety branches --------------------------------

  it("refuses an authorize URL older than 15 minutes without calling Microsoft", async () => {
    const started = await initiate(PERSON_A);
    const state = authorizeParams(started.body.authorizationUrl).params.get("state")!;
    const [row] = await rowsFor(PERSON_A);
    const oauthState = { ...(row!.oauthState as Record<string, unknown>) };
    oauthState.issuedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    await db.update(connections).set({ oauthState }).where(eq(connections.id, row!.id));

    const res = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/callback`)
      .send({ code: "code-late", state, redirectUri: REDIRECT_URI });
    expect(res.status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
    const [after] = await rowsFor(PERSON_A);
    expect(after!.encryptedToken).toBeNull();
  });

  it("reports not_configured and leaves the row active when Microsoft rejects the app's credentials on refresh", async () => {
    const { done } = await connect(PERSON_A);
    const connectionId = done.body.connection.id;
    await setExpiry(connectionId, -1_000);
    tokenHandler = () => ({ status: 401, body: { error: "invalid_client" } });
    await expect(microsoftGraphAuthService(db).tokenForConnection(connectionId)).rejects.toMatchObject({
      reason: "not_configured",
    });
    const [row] = await rowsFor(PERSON_A);
    expect(row!.status).toBe("active");
    const actions = (await activityFor(connectionId)).map((a) => a.action);
    expect(actions).not.toContain("connection.microsoft_refresh_failed");
  });

  // -- review fixes: the redirect URI is this instance's ----------------------

  it("refuses a redirect URI on another origin, even with the right callback path", async () => {
    const res = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/initiate`)
      .send({ redirectUri: "https://another-instance.example.test/connect/microsoft/callback", tier: "read" });
    expect(res.status).toBe(400);
    expect(await rowsFor(PERSON_A)).toHaveLength(0);
  });

  it("refuses a loopback redirect URI unless the instance runs in local mode", async () => {
    const loopback = "http://localhost:3100/connect/microsoft/callback";
    const strict = await request(asPerson(PERSON_A))
      .post(`${base(FLAGGED)}/oauth/initiate`)
      .send({ redirectUri: loopback, tier: "read" });
    expect(strict.status).toBe(400);
    expect(await rowsFor(PERSON_A)).toHaveLength(0);

    const local = await request(asPerson(PERSON_A, { deploymentMode: "local_trusted" }))
      .post(`${base(FLAGGED)}/oauth/initiate`)
      .send({ redirectUri: loopback, tier: "read" });
    expect(local.status).toBe(200);
  });

  it("refuses every non-loopback redirect URI when the instance has no public URL", async () => {
    delete process.env.PAPERCLIP_PUBLIC_URL;
    const res = await initiate(PERSON_A);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/PAPERCLIP_PUBLIC_URL/);
    expect(await rowsFor(PERSON_A)).toHaveLength(0);
  });

  // -- storeOAuthState shape check -------------------------------------------

  it("storeOAuthState refuses an agent-owned document-provider row", async () => {
    await expect(
      connectorService(db).storeOAuthState(FLAGGED, "agent", AGENT_A, "microsoft", { stateToken: "x" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await rowsFor(AGENT_A)).toHaveLength(0);
  });
});
