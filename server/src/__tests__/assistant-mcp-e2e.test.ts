import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

    // 4. Authorization — the SDK builds the URL (PKCE S256 inside).
    const { authorizationUrl, codeVerifier } = await startAuthorization(baseUrl, {
      metadata: asMetadata as never,
      clientInformation: clientInfo,
      redirectUrl: "http://127.0.0.1:5555/callback",
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
    expect(view.redirectHost).toBe("127.0.0.1:5555");

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
      redirectUri: "http://127.0.0.1:5555/callback",
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
});
