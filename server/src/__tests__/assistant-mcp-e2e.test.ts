import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import https from "node:https";
import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  discoverOAuthProtectedResourceMetadata,
  discoverOAuthMetadata,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { eq } from "drizzle-orm";
import {
  assistantAccessTokens,
  assistantAuthRequests,
  assistantGrants,
  assistantOauthClients,
  assistantRefreshTokens,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { oauthRoutes } from "../routes/oauth.js";
import { mcpRoutes } from "../routes/mcp.js";
import { assistantRoutes } from "../routes/assistant.js";

/**
 * GH #677 acceptance: a Node `@modelcontextprotocol/sdk` client completes
 * discovery → register → authorize → token → tools/list against a local
 * HTTPS instance. The OAuth legs use the SDK's own client/auth helpers — the
 * exact code path a conformant MCP client runs — and the consent step, which
 * needs a human, is driven through the consent API with the same session
 * actor a signed-in browser produces.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();

type TestDb = ReturnType<typeof createDb>;

const USER_ID = randomUUID();

function makeSelfSignedCert(): { key: string; cert: string } | null {
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "mcp-e2e-cert-"));
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
        `-days 1 -nodes -subj "/CN=localhost" ` +
        `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { stdio: "pipe" },
    );
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } catch {
    return null;
  }
}

const cert = makeSelfSignedCert();
const canRun = embeddedPostgresSupport.supported && cert !== null;
const describeE2e = canRun ? describe : describe.skip;

describeE2e("assistant MCP OAuth e2e (HTTPS + SDK client)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: https.Server | null = null;
  let baseUrl = "";
  let resourceUri = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-e2e-");
    db = createDb(tempDb.connectionString);

    const app: Express = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: USER_ID },
          user: { id: USER_ID, name: "E2E Person", email: "e2e@example.com" },
        }),
      }),
    );
    const api = express.Router();
    api.use(mcpRoutes());
    // list_pending_decisions' tool call loops back to this route on the
    // internal pcin_ credential — mounting the REAL route is what makes that
    // leg real (its assertBoard is the authz check under test).
    api.use(assistantRoutes(db));
    // Link-building context fetches /companies/:id and /health — minimal
    // stand-ins, still behind the real actorMiddleware, so a pcin_ that fails
    // to resolve surfaces as the tool's error, not a stub's silence.
    api.get("/companies/:id", async (req, res) => {
      const row = await db
        .select()
        .from(companies)
        .where(eq(companies.id, req.params.id as string))
        .then((rows) => rows[0]);
      if (!row) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ id: row.id, name: row.name, issuePrefix: row.issuePrefix });
    });
    api.get("/health", (_req, res) => {
      res.json({ publicBaseUrl: baseUrl });
    });
    app.use("/api", api);
    app.use(oauthRoutes(db));
    app.use(errorHandler);

    server = https.createServer({ key: cert!.key, cert: cert!.cert }, app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `https://localhost:${port}`;
    resourceUri = `${baseUrl}/api/mcp/assistant`;
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", baseUrl);
    // Self-signed test cert — this is the standard way Node accepts it.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    await db.insert(companies).values({
      name: "E2E Co",
      issuePrefix: `E2${randomUUID().slice(0, 4).toUpperCase()}`,
    });
    const company = await db.select().from(companies).then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: USER_ID,
      status: "active",
      membershipRole: "owner",
    });
  }, 90_000);

  afterEach(async () => {
    await db.delete(assistantAccessTokens);
    await db.delete(assistantRefreshTokens);
    await db.delete(assistantAuthRequests);
    await db.delete(assistantGrants);
    await db.delete(assistantOauthClients);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await tempDb?.cleanup();
  });

  async function companyId() {
    const company = await db.select().from(companies).then((rows) => rows[0]!);
    return company.id;
  }

  it("unauthenticated POST answers 401 with a Bearer challenge", async () => {
    const res = await fetch(`${baseUrl}/api/mcp/assistant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain("resource_metadata");
  });

  it("SDK client completes discovery → register → authorize → token → tools/list", async () => {
    // 1. Protected-resource discovery (RFC 9728).
    const prm = await discoverOAuthProtectedResourceMetadata(resourceUri);
    expect(prm.resource).toBe(resourceUri);
    expect(prm.authorization_servers).toContain(baseUrl);

    // 2. Authorization-server discovery (RFC 8414).
    const metadata = await discoverOAuthMetadata(baseUrl);
    expect(metadata).toBeTruthy();
    const asMetadata =
      metadata && "authorization_endpoint" in metadata ? metadata : undefined;
    expect(asMetadata?.token_endpoint).toBe(`${baseUrl}/oauth/token`);
    expect(asMetadata?.registration_endpoint).toBe(`${baseUrl}/oauth/register`);

    // 3. Dynamic client registration.
    const clientInfo = await registerClient(baseUrl, {
      metadata: asMetadata as never,
      clientMetadata: {
        client_name: "SDK E2E Client",
        redirect_uris: ["http://127.0.0.1:5555/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      } as never,
    });
    expect(clientInfo.client_id).toMatch(/^dcr_/);

    // 4. Authorization — the SDK builds the URL (PKCE S256 inside). The
    // redirect uses a different loopback port than registration: native
    // clients bind an ephemeral port they cannot know when they register,
    // and RFC 8252 §7.3 requires the AS to accept any port on a loopback
    // URI. This is the real-client path the conformance run exercised.
    const { authorizationUrl, codeVerifier } = await startAuthorization(baseUrl, {
      metadata: asMetadata as never,
      clientInformation: clientInfo,
      redirectUrl: "http://127.0.0.1:54321/callback",
      scope: "agentdash:read",
      resource: new URL(resourceUri),
    });
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("resource")).toBe(resourceUri);

    // The AS validates and parks the request, then points at the consent UI.
    const authzRes = await fetch(authorizationUrl, { redirect: "manual" });
    expect(authzRes.status).toBe(302);
    const consentUrl = new URL(authzRes.headers.get("location")!, baseUrl);
    const requestId = consentUrl.searchParams.get("request")!;

    // The redirect lands on the SPA route (/oauth/consent?request=<id>); the
    // view data comes from the consent API behind it.
    const viewRes = await fetch(`${baseUrl}/oauth/consent/${requestId}`);
    expect(viewRes.status).toBe(200);
    const view = (await viewRes.json()) as { clientName: string; redirectHost: string };
    expect(view.clientName).toBe("SDK E2E Client");
    expect(view.redirectHost).toBe("127.0.0.1:54321");

    // The human step, driven through the consent API. Origin is required —
    // the decision route carries the same trusted-origin CSRF check as every
    // other browser-session mutation.
    const decision = await fetch(`${baseUrl}/oauth/consent/${requestId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        approved: true,
        companyId: await companyId(),
        scopes: ["agentdash:read"],
      }),
    });
    expect(decision.status).toBe(200);
    const { redirect } = (await decision.json()) as { redirect: string };
    const code = new URL(redirect).searchParams.get("code")!;

    // 5. Token exchange via the SDK helper.
    const tokens = await exchangeAuthorization(baseUrl, {
      metadata: asMetadata as never,
      clientInformation: clientInfo,
      authorizationCode: code,
      codeVerifier,
      redirectUri: "http://127.0.0.1:54321/callback",
      resource: new URL(resourceUri),
    });
    expect(tokens.access_token).toMatch(/^pcpa_/);
    expect(tokens.refresh_token).toMatch(/^pcpr_/);

    // 6. tools/list over the SDK Streamable HTTP transport.
    const client = new Client({ name: "e2e-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(resourceUri), {
      requestInit: {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "explain_blocker",
      "find_work",
      "get_project",
      "get_work_item",
      "list_pending_decisions",
      "list_projects",
      "list_team",
      "whats_new",
      "whoami",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    await client.close();

    // 7. Refresh rotation through the SDK helper.
    const refreshed = await refreshAuthorization(baseUrl, {
      metadata: asMetadata as never,
      clientInformation: clientInfo,
      refreshToken: tokens.refresh_token,
      resource: new URL(resourceUri),
    });
    expect(refreshed.access_token).toMatch(/^pcpa_/);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    // Reuse of the rotated token must fail and kill the family.
    await expect(
      refreshAuthorization(baseUrl, {
        metadata: asMetadata as never,
        clientInformation: clientInfo,
        refreshToken: tokens.refresh_token,
        resource: new URL(resourceUri),
      }),
    ).rejects.toThrow();
  });

  it("accepts Muse's MCP 2025-06-18 handshake: initialize → initialized → tools/list", async () => {
    // Muse sends no session id and speaks protocol 2025-06-18 — the stateless
    // transport must accept the sequence as independent POSTs.
    const cid = await companyId();
    const grant = await db
      .insert(assistantGrants)
      .values({
        companyId: cid,
        userId: USER_ID,
        clientId: "muse",
        clientName: "Muse (Meta)",
        redirectHost: "agent.meta.ai",
        scopes: ["agentdash:read"],
      })
      .returning()
      .then((rows) => rows[0]!);
    const token = `pcpa_${randomBytes(24).toString("base64url")}`;
    await db.insert(assistantAccessTokens).values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      grantId: grant.id,
      familyId: randomUUID(),
      resource: resourceUri,
      scopes: ["agentdash:read"],
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const post = (body: unknown) =>
      fetch(`${baseUrl}/api/mcp/assistant`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "muse", version: "1.0.0" },
      },
    });
    expect(init.status).toBe(200);
    const initBody = await init.json();
    expect(initBody.result.protocolVersion).toBe("2025-06-18");

    const initialized = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(initialized.status).toBe(202);

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    const names = listBody.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("whoami");
    expect(names).toContain("whats_new");

    // tools/call is the GH #688 proof: the tool loops back over HTTP on the
    // in-process pcin_ credential — the caller's pcpa_ is never sent to a raw
    // REST route. A live pending-decisions answer means the loopback actor
    // resolved through the real actorMiddleware AND passed the real route's
    // assertBoard/assertCompanyAccess.
    const call = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_pending_decisions", arguments: {} },
    });
    expect(call.status).toBe(200);
    const callBody = await call.json();
    expect(callBody.result.isError).not.toBe(true);
    expect(callBody.result.content?.[0]?.text).toBeTruthy();
  });
});
