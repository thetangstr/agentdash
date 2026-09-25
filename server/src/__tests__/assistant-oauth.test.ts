import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
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
import { assistantRoutes } from "../routes/assistant.js";

import { EventEmitter } from "node:events";

/** CIMD tests drive `dns.lookup` through this hoisted mock — a document host
 * resolving to a private address is the DNS-rebinding SSRF case. */
const dnsLookupMock = vi.hoisted(() =>
  vi.fn(async (hostname: string) => {
    if (hostname === "private.example") return [{ address: "10.0.0.9", family: 4 }];
    return [{ address: "93.184.216.34", family: 4 }];
  }),
);

vi.mock("node:dns/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:dns/promises")>();
  return { ...original, lookup: dnsLookupMock };
});

/** The CIMD transport is a pinned `node:https` request — never global fetch,
 * so the socket can only reach addresses the SSRF guard already classified.
 * Tests stub it at the module seam; the default answers a TCP error. */
const httpsRequestMock = vi.hoisted(() =>
  vi.fn((_options: unknown, callback?: (res: unknown) => void) => {
    void callback;
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
    };
    req.end = () => queueMicrotask(() => req.emit("error", new Error("unstubbed https.request")));
    req.destroy = vi.fn();
    return req;
  }),
);

vi.mock("node:https", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:https")>();
  return { ...original, request: httpsRequestMock };
});

/** Serve a CIMD response through the mocked transport: status + body, or a
 * synthetic socket error when `body` is null. Captures the options the
 * service passed so tests can assert the pinned lookup/SNI wiring. */
function stubCimdHttps(body: string | null, status = 200) {
  httpsRequestMock.mockImplementation((options: unknown, callback?: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
    };
    req.destroy = vi.fn();
    req.end = () => {
      if (body === null) {
        queueMicrotask(() => req.emit("error", new Error("ECONNREFUSED")));
        return;
      }
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        resume: () => void;
      };
      res.statusCode = status;
      res.resume = vi.fn();
      callback?.(res);
      queueMicrotask(() => {
        res.emit("data", Buffer.from(body));
        res.emit("end");
      });
    };
    return req;
  });
}

/**
 * GH #677: the OAuth 2.1 authorization-server surface, exercised end-to-end
 * against embedded Postgres. The consent actor arrives through the same
 * `resolveSession` seam production uses — mocked to a fixed person, exactly
 * what a better-auth cookie resolves to.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const PUBLIC_BASE = "http://127.0.0.1:7777";
const CANONICAL_RESOURCE = `${PUBLIC_BASE}/api/mcp/assistant`;
const USER_ID = randomUUID();

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describeEmbeddedPostgres("assistant OAuth 2.1 authorization server", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assistant-oauth-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE);
    // Reset the pinned-transport seam: default = connection error, so a CIMD
    // test that forgets to stub fails closed instead of dialing the network.
    httpsRequestMock.mockReset();
    httpsRequestMock.mockImplementation((_options: unknown, callback?: (res: unknown) => void) => {
      void callback;
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.end = () => queueMicrotask(() => req.emit("error", new Error("unstubbed https.request")));
      req.destroy = vi.fn();
      return req;
    });
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: USER_ID },
          user: { id: USER_ID, name: "Test Person", email: "person@example.com" },
        }),
      }),
    );
    app.use("/api", assistantRoutes(db));
    app.use(oauthRoutes(db, { deploymentMode: "authenticated" }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await db.delete(assistantAccessTokens);
    await db.delete(assistantRefreshTokens);
    await db.delete(assistantAuthRequests);
    await db.delete(assistantGrants);
    await db.delete(assistantOauthClients);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Acme") {
    const company = await db
      .insert(companies)
      .values({ name: `${name} ${randomUUID()}`, issuePrefix: `AC${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    return company;
  }

  async function registerClient(redirectUris = ["https://assistant.example/callback"]) {
    const res = await request(app)
      .post("/oauth/register")
      .send({ client_name: "Muse", redirect_uris: redirectUris });
    expect(res.status).toBe(201);
    return res.body as { client_id: string };
  }

  async function authorize(params: Record<string, string> = {}) {
    const { challenge } = pkcePair();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: params.client_id ?? "",
      redirect_uri: params.redirect_uri ?? "https://assistant.example/callback",
      state: params.state ?? "state-123",
      scope: params.scope ?? "agentdash:read agentdash:work",
      resource: params.resource ?? CANONICAL_RESOURCE,
      code_challenge: params.code_challenge ?? challenge,
      code_challenge_method: params.code_challenge_method ?? "S256",
    });
    for (const [key, value] of Object.entries(params)) {
      if (value === "__omit__") query.delete(key);
    }
    const res = await request(app).get(`/oauth/authorize?${query.toString()}`);
    return res;
  }

  /** Full happy path up to a live token pair. Returns everything a test might need. */
  async function completeFlow(scopes = "agentdash:read agentdash:work") {
    const company = await seedCompany();
    const { client_id } = await registerClient();
    const { verifier, challenge } = pkcePair();
    const authz = await authorize({ client_id, code_challenge: challenge, scope: scopes });
    expect(authz.status).toBe(302);
    const consentUrl = new URL(authz.headers.location as string, PUBLIC_BASE);
    const requestId = consentUrl.searchParams.get("request")!;
    const view = await request(app).get(`/oauth/consent/${requestId}`);
    expect(view.status).toBe(200);
    const decision = await request(app)
      .post(`/oauth/consent/${requestId}/decision`)
      .set("Origin", PUBLIC_BASE)
      .send({ approved: true, companyId: company.id, scopes: scopes.split(" ") });
    expect(decision.status).toBe(200);
    const redirect = new URL(decision.body.redirect as string);
    const code = redirect.searchParams.get("code")!;
    const token = await request(app)
      .post("/oauth/token")
      .send({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: "https://assistant.example/callback",
        code_verifier: verifier,
        resource: CANONICAL_RESOURCE,
      });
    expect(token.status).toBe(200);
    return { company, client_id, code, tokens: token.body, requestId };
  }

  describe("discovery metadata", () => {
    it("serves protected-resource metadata at both well-known paths", async () => {
      for (const path of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/api/mcp/assistant",
      ]) {
        const res = await request(app).get(path);
        expect(res.status).toBe(200);
        expect(res.body.resource).toBe(CANONICAL_RESOURCE);
        expect(res.body.authorization_servers).toEqual([PUBLIC_BASE]);
        expect(res.body.scopes_supported).toEqual(
          expect.arrayContaining(["agentdash:read", "agentdash:work", "agentdash:decide"]),
        );
      }
    });

    it("serves authorization-server metadata advertising PKCE, DCR, CIMD and resource", async () => {
      const res = await request(app).get("/.well-known/oauth-authorization-server");
      expect(res.status).toBe(200);
      expect(res.body.issuer).toBe(PUBLIC_BASE);
      expect(res.body.authorization_endpoint).toBe(`${PUBLIC_BASE}/oauth/authorize`);
      expect(res.body.token_endpoint).toBe(`${PUBLIC_BASE}/oauth/token`);
      expect(res.body.registration_endpoint).toBe(`${PUBLIC_BASE}/oauth/register`);
      expect(res.body.revocation_endpoint).toBe(`${PUBLIC_BASE}/oauth/revoke`);
      expect(res.body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(res.body.client_id_metadata_document_supported).toBe(true);
      expect(res.body.resource_parameter_supported).toBe(true);
    });
  });

  describe("POST /oauth/register (DCR)", () => {
    it("registers a public client with a dcr_ client_id", async () => {
      const res = await request(app)
        .post("/oauth/register")
        .send({ client_name: "Muse", redirect_uris: ["https://assistant.example/cb"] });
      expect(res.status).toBe(201);
      expect(res.body.client_id).toMatch(/^dcr_/);
      expect(res.body.token_endpoint_auth_method).toBe("none");
      expect(res.body.client_secret).toBeUndefined();
    });

    it("accepts loopback http redirect URIs (native-app pattern)", async () => {
      const res = await request(app)
        .post("/oauth/register")
        .send({ redirect_uris: ["http://127.0.0.1:9999/callback"] });
      expect(res.status).toBe(201);
    });

    it("rejects non-https non-loopback redirects", async () => {
      const res = await request(app)
        .post("/oauth/register")
        .send({ redirect_uris: ["http://assistant.example/cb"] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_redirect_uri");
    });

    it("rejects a redirect URI with a fragment", async () => {
      const res = await request(app)
        .post("/oauth/register")
        .send({ redirect_uris: ["https://assistant.example/cb#frag"] });
      expect(res.status).toBe(400);
    });

    it("rejects a missing redirect_uris array", async () => {
      const res = await request(app).post("/oauth/register").send({ client_name: "Muse" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /oauth/authorize", () => {
    it("rejects a missing PKCE challenge", async () => {
      const { client_id } = await registerClient();
      const res = await authorize({ client_id, code_challenge: "__omit__" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      expect(res.body.error_description).toMatch(/code_challenge/);
    });

    it("rejects code_challenge_method=plain", async () => {
      const { client_id } = await registerClient();
      const res = await authorize({ client_id, code_challenge_method: "plain" });
      expect(res.status).toBe(400);
      expect(res.body.error_description).toMatch(/S256/);
    });

    it("rejects a wrong resource/audience", async () => {
      const { client_id } = await registerClient();
      const res = await authorize({ client_id, resource: "https://other.example/mcp" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_target");
    });

    it("rejects an unregistered redirect_uri", async () => {
      const { client_id } = await registerClient();
      const res = await authorize({ client_id, redirect_uri: "https://evil.example/cb" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_redirect_uri");
    });

    it("accepts any port on a registered loopback redirect (RFC 8252 §7.3)", async () => {
      const { client_id } = await registerClient(["http://127.0.0.1:1234/callback"]);
      const res = await authorize({ client_id, redirect_uri: "http://127.0.0.1:54321/callback" });
      expect(res.status).toBe(302);
    });

    it("accepts an ephemeral port on a port-less localhost registration", async () => {
      const { client_id } = await registerClient(["http://localhost/cb"]);
      const res = await authorize({ client_id, redirect_uri: "http://localhost:48888/cb" });
      expect(res.status).toBe(302);
    });

    it("still rejects a loopback URI whose path differs — only the port is exempt", async () => {
      const { client_id } = await registerClient(["http://127.0.0.1:1234/callback"]);
      const res = await authorize({ client_id, redirect_uri: "http://127.0.0.1:1234/other" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_redirect_uri");
    });

    it("still rejects a different loopback host — 127.0.0.1 and localhost do not cross-match", async () => {
      const { client_id } = await registerClient(["http://127.0.0.1:1234/cb"]);
      const res = await authorize({ client_id, redirect_uri: "http://localhost:1234/cb" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_redirect_uri");
    });

    it("never applies the port exemption to https redirects", async () => {
      const { client_id } = await registerClient(["https://assistant.example:444/cb"]);
      const res = await authorize({ client_id, redirect_uri: "https://assistant.example:555/cb" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_redirect_uri");
    });

    it("binds the issued code to the exact ephemeral-port URI at exchange", async () => {
      const company = await seedCompany();
      const { client_id } = await registerClient(["http://127.0.0.1:1/callback"]);
      const { verifier, challenge } = pkcePair();
      const ephemeral = "http://127.0.0.1:54321/callback";
      const authz = await authorize({ client_id, code_challenge: challenge, redirect_uri: ephemeral });
      expect(authz.status).toBe(302);
      const requestId = new URL(authz.headers.location as string, PUBLIC_BASE).searchParams.get("request")!;
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: company.id, scopes: ["agentdash:read"] });
      expect(decision.status).toBe(200);
      const code = new URL(decision.body.redirect as string).searchParams.get("code")!;
      // A different port at exchange is a different URI — the code must not trade.
      const wrongPort = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: "http://127.0.0.1:1/callback",
        code_verifier: verifier,
        resource: CANONICAL_RESOURCE,
      });
      expect(wrongPort.status).toBe(400);
      expect(wrongPort.body.error).toBe("invalid_grant");
      // The failed exchange burns the code — a correct retry is rejected too.
      const right = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: ephemeral,
        code_verifier: verifier,
        resource: CANONICAL_RESOURCE,
      });
      expect(right.status).toBe(400);
      expect(right.body.error).toBe("invalid_grant");
    });

    it("rejects an unknown client_id", async () => {
      const res = await authorize({ client_id: "dcr_nonexistent" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client");
    });

    it("redirects to the consent screen on a valid request", async () => {
      const { client_id } = await registerClient();
      const res = await authorize({ client_id });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^\/oauth\/consent\?request=/);
    });

    it("defaults an absent resource to this instance's MCP URI (Muse sends none)", async () => {
      const { client_id } = await registerClient();
      const res = await authorize({ client_id, resource: "__omit__" });
      expect(res.status).toBe(302);
    });
  });

  describe("pre-registered public clients (Muse, GH #674)", () => {
    const MUSE_REDIRECT = "https://agent.meta.ai/api/hatch/oauth/callback";

    it("accepts the built-in `muse` client_id with Meta's fixed callback", async () => {
      const res = await authorize({ client_id: "muse", redirect_uri: MUSE_REDIRECT });
      expect(res.status).toBe(302);
      // First use materializes the row so grants/revocation see a real client.
      const view = await request(app).get(
        `/oauth/consent/${new URL(res.headers.location, PUBLIC_BASE).searchParams.get("request")}`,
      );
      expect(view.status).toBe(200);
      expect(view.body.clientName).toBe("Muse (Meta)");
      expect(view.body.redirectHost).toBe("agent.meta.ai");
    });

    it("still pins muse to its registered redirect — no other URI matches", async () => {
      const res = await authorize({ client_id: "muse", redirect_uri: "https://agent.meta.ai/other" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_redirect_uri");
    });

    it("runs the whole Muse flow: authorize with no resource, form token POST with none", async () => {
      const company = await seedCompany();
      const { verifier, challenge } = pkcePair();
      const authz = await authorize({
        client_id: "muse",
        redirect_uri: MUSE_REDIRECT,
        resource: "__omit__",
        code_challenge: challenge,
        scope: "agentdash:read agentdash:work",
      });
      expect(authz.status).toBe(302);
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: company.id, scopes: ["agentdash:read"] });
      expect(decision.status).toBe(200);
      const redirect = new URL(decision.body.redirect);
      expect(redirect.origin + redirect.pathname).toBe(MUSE_REDIRECT);
      const code = redirect.searchParams.get("code")!;
      // Muse's token POST is form-encoded, public client, no resource field.
      const token = await request(app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "authorization_code",
          code,
          client_id: "muse",
          redirect_uri: MUSE_REDIRECT,
          code_verifier: verifier,
        });
      expect(token.status).toBe(200);
      expect(token.body.access_token).toMatch(/^pcpa_/);
      expect(token.body.scope).toBe("agentdash:read");
    });
  });

  describe("consent", () => {
    it("serves the consent view and decision behind clickjacking headers", async () => {
      const company = await seedCompany();
      const { client_id } = await registerClient();
      const authz = await authorize({ client_id });
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      const view = await request(app).get(`/oauth/consent/${requestId}`);
      expect(view.status).toBe(200);
      expect(view.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
      expect(view.headers["x-frame-options"]).toBe("DENY");
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: company.id, scopes: ["agentdash:read"] });
      expect(decision.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
      expect(decision.headers["x-frame-options"]).toBe("DENY");
    });

    it("shows the client name, redirect host, scopes and companies", async () => {
      await seedCompany("Acme");
      const { client_id } = await registerClient();
      const authz = await authorize({ client_id });
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      const view = await request(app).get(`/oauth/consent/${requestId}`);
      expect(view.status).toBe(200);
      expect(view.body.clientName).toBe("Muse");
      expect(view.body.redirectHost).toBe("assistant.example");
      expect(view.body.requestedScopes).toEqual(["agentdash:read", "agentdash:work"]);
      expect(view.body.companies).toHaveLength(1);
    });

    it("approving returns a redirect carrying code, state and iss", async () => {
      const company = await seedCompany();
      const { client_id } = await registerClient();
      const authz = await authorize({ client_id, state: "st-99" });
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: company.id, scopes: ["agentdash:read"] });
      expect(decision.status).toBe(200);
      const redirect = new URL(decision.body.redirect);
      expect(redirect.origin).toBe("https://assistant.example");
      expect(redirect.pathname).toBe("/callback");
      expect(redirect.searchParams.get("code")).toBeTruthy();
      expect(redirect.searchParams.get("state")).toBe("st-99");
      expect(redirect.searchParams.get("iss")).toBe(PUBLIC_BASE);
    });

    it("denying returns error=access_denied on the client redirect", async () => {
      await seedCompany();
      const { client_id } = await registerClient();
      const authz = await authorize({ client_id });
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: false });
      expect(decision.status).toBe(200);
      const redirect = new URL(decision.body.redirect);
      expect(redirect.searchParams.get("error")).toBe("access_denied");
      expect(redirect.searchParams.get("code")).toBeNull();
    });

    it("refuses approval into a company the person does not belong to", async () => {
      await seedCompany();
      const otherCompany = await db
        .insert(companies)
        .values({ name: `Other ${randomUUID()}`, issuePrefix: `OT${randomUUID().slice(0, 4).toUpperCase()}` })
        .returning()
        .then((rows) => rows[0]!);
      const { client_id } = await registerClient();
      const authz = await authorize({ client_id });
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: otherCompany.id, scopes: ["agentdash:read"] });
      expect(decision.status).toBe(403);
    });

    it("refuses a decision POST from an untrusted browser origin", async () => {
      const company = await seedCompany();
      const { client_id } = await registerClient();
      const authz = await authorize({ client_id });
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      // The decision route lives outside /api, so it carries the trusted-origin
      // CSRF check route-locally — a cross-site POST must not mint a code.
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", "https://evil.example")
        .send({ approved: true, companyId: company.id, scopes: ["agentdash:read"] });
      expect(decision.status).toBe(403);
      // And the request is still pending — nothing was consumed or granted.
      const row = await db.select().from(assistantAuthRequests).then((rows) => rows[0]!);
      expect(row.status).toBe("pending");
      expect(row.codeHash).toBeNull();
    });

    it("refuses an approval that grants no scope the client asked for", async () => {
      const company = await seedCompany();
      const { client_id } = await registerClient();
      const authz = await authorize({ client_id, scope: "agentdash:read" });
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      // Approving with every scope unchecked must not mint a grant the screen
      // never showed — the person denies instead.
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: company.id, scopes: [] });
      expect(decision.status).toBe(400);
      // Nor may the caller widen beyond the client's requested scopes.
      const widen = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: company.id, scopes: ["agentdash:read", "agentdash:decide"] });
      expect(widen.status).toBe(200);
      const grant = await db.select().from(assistantGrants).then((rows) => rows[0]!);
      expect(grant.scopes).toEqual(["agentdash:read"]);
    });
  });

  describe("POST /oauth/token", () => {
    it("issues a pcpa_ access token and pcpr_ refresh token with correct lifetimes", async () => {
      const { tokens } = await completeFlow();
      expect(tokens.access_token).toMatch(/^pcpa_/);
      expect(tokens.refresh_token).toMatch(/^pcpr_/);
      expect(tokens.token_type).toBe("Bearer");
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.scope).toBe("agentdash:read agentdash:work");
    });

    it("stores only token hashes at rest", async () => {
      const { tokens } = await completeFlow();
      const accessRows = await db.select().from(assistantAccessTokens);
      const refreshRows = await db.select().from(assistantRefreshTokens);
      expect(accessRows).toHaveLength(1);
      expect(refreshRows).toHaveLength(1);
      expect(accessRows[0]!.tokenHash).not.toContain(tokens.access_token);
      expect(accessRows[0]!.tokenHash).toBe(createHash("sha256").update(tokens.access_token).digest("hex"));
      expect(accessRows[0]!.resource).toBe(CANONICAL_RESOURCE);
      // ~1h and ~30d respectively
      expect(accessRows[0]!.expiresAt.getTime() - Date.now()).toBeGreaterThan(3_500_000);
      expect(refreshRows[0]!.expiresAt.getTime() - Date.now()).toBeGreaterThan(30 * 24 * 3_500_000);
    });

    it("rejects a wrong code_verifier", async () => {
      const company = await seedCompany();
      const { client_id } = await registerClient();
      const { challenge } = pkcePair();
      const authz = await authorize({ client_id, code_challenge: challenge });
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: company.id, scopes: ["agentdash:read"] });
      const code = new URL(decision.body.redirect).searchParams.get("code")!;
      const res = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: "https://assistant.example/callback",
        code_verifier: randomBytes(32).toString("base64url"),
        resource: CANONICAL_RESOURCE,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_grant");
    });

    it("rejects a code exchange whose resource differs from the bound one", async () => {
      const company = await seedCompany();
      const { client_id } = await registerClient();
      const { verifier, challenge } = pkcePair();
      const authz = await authorize({ client_id, code_challenge: challenge });
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: company.id, scopes: ["agentdash:read"] });
      const code = new URL(decision.body.redirect).searchParams.get("code")!;
      const res = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: "https://assistant.example/callback",
        code_verifier: verifier,
        resource: "https://other.example/mcp",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_target");
    });

    it("rejects replay of a consumed code", async () => {
      const { code, client_id } = await completeFlow();
      const replay = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: "https://assistant.example/callback",
        code_verifier: "anything",
        resource: CANONICAL_RESOURCE,
      });
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");
    });

    // GH #688: once a real code has been looked up, EVERY failed exchange
    // burns it — a code that survives a mismatch can be probed until a guess
    // lands. Each case below: fail once, then retry with EVERYTHING correct —
    // the retry must fail because the code is already consumed.
    describe("burn-on-exchange-failure", () => {
      /** Full approve → code, in one helper (decision is one-shot). */
      async function mintCode(scopes = ["agentdash:read"]) {
        const company = await seedCompany();
        const { client_id } = await registerClient();
        const { verifier, challenge } = pkcePair();
        const authz = await authorize({ client_id, code_challenge: challenge });
        const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
        const decision = await request(app)
          .post(`/oauth/consent/${requestId}/decision`)
          .set("Origin", PUBLIC_BASE)
          .send({ approved: true, companyId: company.id, scopes });
        const code = new URL(decision.body.redirect as string).searchParams.get("code")!;
        return { company, client_id, verifier, code };
      }

      function correctExchange(code: string, client_id: string, verifier: string) {
        return request(app).post("/oauth/token").send({
          grant_type: "authorization_code",
          code,
          client_id,
          redirect_uri: "https://assistant.example/callback",
          code_verifier: verifier,
          resource: CANONICAL_RESOURCE,
        });
      }

      it("burns the code on a wrong client_id, then refuses the correct retry", async () => {
        const { client_id, verifier, code } = await mintCode();
        const wrong = await request(app).post("/oauth/token").send({
          grant_type: "authorization_code",
          code,
          client_id: "dcr_somebody_else",
          redirect_uri: "https://assistant.example/callback",
          code_verifier: verifier,
          resource: CANONICAL_RESOURCE,
        });
        expect(wrong.status).toBe(400);
        const retry = await correctExchange(code, client_id, verifier);
        expect(retry.status).toBe(400);
        expect(retry.body.error).toBe("invalid_grant");
      });

      it("burns the code on a redirect_uri mismatch", async () => {
        const { client_id, verifier, code } = await mintCode();
        const wrong = await request(app).post("/oauth/token").send({
          grant_type: "authorization_code",
          code,
          client_id,
          redirect_uri: "https://assistant.example/other",
          code_verifier: verifier,
          resource: CANONICAL_RESOURCE,
        });
        expect(wrong.status).toBe(400);
        const retry = await correctExchange(code, client_id, verifier);
        expect(retry.status).toBe(400);
      });

      it("burns the code on a wrong code_verifier", async () => {
        const { client_id, verifier, code } = await mintCode();
        const wrong = await request(app).post("/oauth/token").send({
          grant_type: "authorization_code",
          code,
          client_id,
          redirect_uri: "https://assistant.example/callback",
          code_verifier: randomBytes(32).toString("base64url"),
          resource: CANONICAL_RESOURCE,
        });
        expect(wrong.status).toBe(400);
        const retry = await correctExchange(code, client_id, verifier);
        expect(retry.status).toBe(400);
      });

      it("burns the code on a resource mismatch", async () => {
        const { client_id, verifier, code } = await mintCode();
        const wrong = await request(app).post("/oauth/token").send({
          grant_type: "authorization_code",
          code,
          client_id,
          redirect_uri: "https://assistant.example/callback",
          code_verifier: verifier,
          resource: "https://other.example/mcp",
        });
        expect(wrong.status).toBe(400);
        expect(wrong.body.error).toBe("invalid_target");
        const retry = await correctExchange(code, client_id, verifier);
        expect(retry.status).toBe(400);
        expect(retry.body.error).toBe("invalid_grant");
      });

      it("burns an expired code rather than leaving it live", async () => {
        const { client_id, verifier, code } = await mintCode();
        await db
          .update(assistantAuthRequests)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(assistantAuthRequests.codeHash, createHash("sha256").update(code).digest("hex")));
        const res = await correctExchange(code, client_id, verifier);
        expect(res.status).toBe(400);
        expect(res.body.error_description).toMatch(/expired/);
        const row = await db
          .select()
          .from(assistantAuthRequests)
          .where(eq(assistantAuthRequests.codeHash, createHash("sha256").update(code).digest("hex")))
          .then((rows) => rows[0]!);
        expect(row.status).toBe("consumed");
      });
    });

    it("a replayed code revokes the token family its first exchange minted (RFC 6819)", async () => {
      const { code, client_id } = await completeFlow();
      // The first exchange succeeded and minted a live family.
      let accessRows = await db.select().from(assistantAccessTokens);
      expect(accessRows[0]!.revokedAt).toBeNull();
      await request(app).post("/oauth/token").send({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: "https://assistant.example/callback",
        code_verifier: "anything",
        resource: CANONICAL_RESOURCE,
      });
      // Replay detected → exactly that family is dead, not just the code.
      accessRows = await db.select().from(assistantAccessTokens);
      const refreshRows = await db.select().from(assistantRefreshTokens);
      for (const row of [...accessRows, ...refreshRows]) {
        expect(row.revokedAt).not.toBeNull();
      }
    });

    it("honors resource on the refresh grant — a wrong one is invalid_target", async () => {
      const { tokens, client_id } = await completeFlow();
      const res = await request(app).post("/oauth/token").send({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id,
        resource: "https://other.example/mcp",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_target");
    });

    it("re-consent with a changed scope set retires the old token families", async () => {
      const { client_id, tokens } = await completeFlow("agentdash:read");
      // Re-run the flow for the same user+client+company, now adding work —
      // the grant's scope set changes, so tokens minted under the old consent
      // must not survive to mint under the new one.
      const company = await db.select().from(assistantGrants).then((r) => r[0]!.companyId);
      const { verifier, challenge } = pkcePair();
      const authz = await authorize({
        client_id,
        code_challenge: challenge,
        scope: "agentdash:read agentdash:work",
      });
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: company, scopes: ["agentdash:read", "agentdash:work"] });
      expect(decision.status).toBe(200);
      const refreshRows = await db.select().from(assistantRefreshTokens);
      const oldFamily = refreshRows.filter((r) => r.tokenHash === createHash("sha256").update(tokens.refresh_token).digest("hex"));
      expect(oldFamily[0]!.revokedAt).not.toBeNull();
      void verifier;
    });
  });

  describe("issuer fail-closed (GH #688)", () => {
    it("authenticated mode without a public URL refuses to advertise or mint", async () => {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", undefined as unknown as string);
      const res = await request(app).get("/.well-known/oauth-authorization-server");
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("server_error");
    });
  });

  describe("refresh rotation and reuse", () => {
    it("rotates the refresh token and issues a new access token", async () => {
      const { tokens, client_id } = await completeFlow();
      const res = await request(app).post("/oauth/token").send({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id,
        resource: CANONICAL_RESOURCE,
      });
      expect(res.status).toBe(200);
      expect(res.body.access_token).toMatch(/^pcpa_/);
      expect(res.body.refresh_token).not.toBe(tokens.refresh_token);
    });

    it("reusing a rotated refresh token revokes the entire family", async () => {
      const { tokens, client_id } = await completeFlow();
      const first = await request(app).post("/oauth/token").send({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id,
        resource: CANONICAL_RESOURCE,
      });
      expect(first.status).toBe(200);

      // Replay the ORIGINAL refresh token — the classic stolen-token signal.
      const reuse = await request(app).post("/oauth/token").send({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id,
        resource: CANONICAL_RESOURCE,
      });
      expect(reuse.status).toBe(400);
      expect(reuse.body.error).toBe("invalid_grant");

      // The whole family is dead: the rotated refresh AND the access tokens
      // minted in it.
      const refreshRows = await db.select().from(assistantRefreshTokens);
      expect(refreshRows.length).toBeGreaterThanOrEqual(2);
      for (const row of refreshRows) expect(row.revokedAt).not.toBeNull();
      const accessRows = await db.select().from(assistantAccessTokens);
      for (const row of accessRows) expect(row.revokedAt).not.toBeNull();

      // Even the NEW refresh token is dead.
      const after = await request(app).post("/oauth/token").send({
        grant_type: "refresh_token",
        refresh_token: first.body.refresh_token,
        client_id,
        resource: CANONICAL_RESOURCE,
      });
      expect(after.status).toBe(400);
    });
  });

  describe("POST /oauth/revoke", () => {
    it("revokes an access token immediately", async () => {
      const { tokens } = await completeFlow();
      await request(app).post("/oauth/revoke").send({ token: tokens.access_token });
      const rows = await db.select().from(assistantAccessTokens);
      expect(rows[0]!.revokedAt).not.toBeNull();
    });

    it("revoking a refresh token takes the whole family with it", async () => {
      const { tokens } = await completeFlow();
      await request(app).post("/oauth/revoke").send({ token: tokens.refresh_token });
      const accessRows = await db.select().from(assistantAccessTokens);
      expect(accessRows[0]!.revokedAt).not.toBeNull();
      const refreshRows = await db.select().from(assistantRefreshTokens);
      expect(refreshRows[0]!.revokedAt).not.toBeNull();
    });

    it("answers 200 for an unknown token", async () => {
      const res = await request(app).post("/oauth/revoke").send({ token: "pcpa_nonexistent" });
      expect(res.status).toBe(200);
    });
  });

  describe("CIMD (client_id as https URL)", () => {
    const CIMD_URL = "https://client.example/mcp-client.json";

    it("fetches the metadata document and completes the flow", async () => {
      stubCimdHttps(JSON.stringify({
        client_name: "CIMD Client",
        redirect_uris: ["https://client.example/callback"],
      }));
      const company = await seedCompany();
      const { challenge, verifier } = pkcePair();
      const authz = await authorize({
        client_id: CIMD_URL,
        redirect_uri: "https://client.example/callback",
        code_challenge: challenge,
      });
      expect(authz.status).toBe(302);
      const requestId = new URL(authz.headers.location, PUBLIC_BASE).searchParams.get("request")!;
      const decision = await request(app)
        .post(`/oauth/consent/${requestId}/decision`)
        .set("Origin", PUBLIC_BASE)
        .send({ approved: true, companyId: company.id, scopes: ["agentdash:read"] });
      const code = new URL(decision.body.redirect).searchParams.get("code")!;
      const token = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code",
        code,
        client_id: CIMD_URL,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: CANONICAL_RESOURCE,
      });
      expect(token.status).toBe(200);
      const grant = await db.select().from(assistantGrants).then((rows) => rows[0]!);
      expect(grant.clientId).toBe(CIMD_URL);
      expect(grant.clientName).toBe("CIMD Client");
    });

    it("pins the connection to the validated addresses and keeps the URL hostname for TLS", async () => {
      stubCimdHttps(JSON.stringify({ client_name: "Pinned", redirect_uris: ["https://client.example/cb"] }));
      const res = await authorize({
        client_id: CIMD_URL,
        redirect_uri: "https://client.example/cb",
      });
      expect(res.status).toBe(302);
      expect(httpsRequestMock).toHaveBeenCalledTimes(1);
      const options = httpsRequestMock.mock.calls[0]![0] as {
        hostname: string;
        lookup: (h: string, o: unknown, cb: (e: unknown, a?: string, f?: number) => void) => void;
      };
      // SNI/certificate identity stays the URL's hostname...
      expect(options.hostname).toBe("client.example");
      // ...while the connect() path is force-fed ONLY the addresses the guard
      // already classified — a second DNS answer cannot rebind.
      const pinned = await new Promise((resolve) => {
        options.lookup("client.example", {}, (_e, address, family) => resolve({ address, family }));
      });
      expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
    });

    it("rejects a CIMD document whose redirect_uris are off-origin", async () => {
      stubCimdHttps(JSON.stringify({
        client_name: "Evil",
        redirect_uris: ["https://victim.example/callback"],
      }));
      const res = await authorize({ client_id: CIMD_URL, redirect_uri: "https://victim.example/callback" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client_metadata");
    });

    it("rejects a document whose client_id field does not match the document URL", async () => {
      stubCimdHttps(JSON.stringify({
        client_id: "https://other.example/not-this-doc.json",
        client_name: "Mismatched",
        redirect_uris: ["https://client.example/callback"],
      }));
      const res = await authorize({
        client_id: CIMD_URL,
        redirect_uri: "https://client.example/callback",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client_metadata");
    });

    it("accepts a document whose client_id matches the document URL", async () => {
      stubCimdHttps(JSON.stringify({
        client_id: CIMD_URL,
        client_name: "Matched",
        redirect_uris: ["https://client.example/callback"],
      }));
      const res = await authorize({
        client_id: CIMD_URL,
        redirect_uri: "https://client.example/callback",
      });
      expect(res.status).toBe(302);
    });

    it("rejects a redirect response — redirect hops are never followed", async () => {
      stubCimdHttps("redirect", 302);
      const res = await authorize({ client_id: CIMD_URL });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client_metadata");
      expect(res.body.error_description).toMatch(/redirect/i);
    });

    it("returns a generic error on transport failure — no internals leak", async () => {
      stubCimdHttps(null);
      const res = await authorize({ client_id: CIMD_URL });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client_metadata");
      expect(res.body.error_description).not.toMatch(/ECONNREFUSED/);
    });

    it("caches a fetched document instead of re-fetching per authorize", async () => {
      stubCimdHttps(JSON.stringify({
        client_name: "Cached",
        redirect_uris: ["https://client.example/callback"],
      }));
      for (let i = 0; i < 2; i++) {
        const res = await authorize({
          client_id: CIMD_URL,
          redirect_uri: "https://client.example/callback",
        });
        expect(res.status).toBe(302);
      }
      expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a client_id that is not https", async () => {
      const res = await authorize({ client_id: "http://client.example/doc.json" });
      expect(res.status).toBe(400);
    });

    it("rejects a client_id over the length cap", async () => {
      const res = await authorize({ client_id: `https://client.example/${"a".repeat(2100)}` });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client");
    });
  });

  describe("SSRF guard", () => {
    it("rejects private literal IPs as CIMD hosts", async () => {
      for (const host of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "100.64.0.1"]) {
        const res = await authorize({ client_id: `https://${host}/doc.json` });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_client_metadata");
      }
    });

    it("rejects IPv4-mapped IPv6 literals in both dotted and hex-normalized form", async () => {
      // WHATWG normalizes [::ffff:127.0.0.1] to ::ffff:7f00:1 BEFORE we see
      // it — the dotted form never reaches our classifier, so the hex form
      // is the one that must fail.
      for (const host of [
        "[::ffff:7f00:1]",
        "[::ffff:127.0.0.1]",
        "[::ffff:0a00:0009]",
        "[::ffff:a9fe:a9fe]",
        "[::ffff:169.254.169.254]",
      ]) {
        const res = await authorize({ client_id: `https://${host}/doc.json` });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_client_metadata");
      }
    });

    it("rejects IPv4-compatible, NAT64, link-local and other IPv6 traps", async () => {
      for (const host of [
        "[::1]",
        "[::]",
        "[::7f00:1]",
        "[::127.0.0.1]",
        "[64:ff9b::a00:9]",
        "[64:ff9b::7f00:1]",
        "[fe80::1]",
        "[fec0::1]",
        "[fc00::1]",
        "[fd00::1]",
        "[ff02::1]",
        "[2001:db8::1]",
        "[2002::1]",
        "[100::1]",
      ]) {
        const res = await authorize({ client_id: `https://${host}/doc.json` });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_client_metadata");
      }
    });

    it("rejects localhost as a CIMD host", async () => {
      const res = await authorize({ client_id: "https://localhost/doc.json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client_metadata");
    });

    it("rejects a hostname that resolves to a private address (DNS rebinding)", async () => {
      const res = await authorize({ client_id: "https://private.example/doc.json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client_metadata");
    });

    it("rejects a metadata document over 64 KB", async () => {
      stubCimdHttps("x".repeat(70 * 1024));
      const res = await authorize({ client_id: "https://client.example/doc.json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client_metadata");
      expect(res.body.error_description).toMatch(/64 KB/);
    });
  });

  describe("grants API (Connections card)", () => {
    it("lists and revokes a grant, killing its tokens", async () => {
      const { company, tokens } = await completeFlow();
      const list = await request(app).get(`/api/companies/${company.id}/me/assistant-grants`);
      expect(list.status).toBe(200);
      expect(list.body.grants).toHaveLength(1);
      expect(list.body.grants[0].clientName).toBe("Muse");

      const revoke = await request(app)
        .post(`/api/companies/${company.id}/me/assistant-grants/${list.body.grants[0].id}/revoke`)
        .send({});
      expect(revoke.status).toBe(200);
      expect(revoke.body.revoked).toBe(true);

      const accessRows = await db.select().from(assistantAccessTokens);
      expect(accessRows[0]!.revokedAt).not.toBeNull();
      const refreshRows = await db.select().from(assistantRefreshTokens);
      expect(refreshRows[0]!.revokedAt).not.toBeNull();
      void tokens;

      const relist = await request(app).get(`/api/companies/${company.id}/me/assistant-grants`);
      expect(relist.body.grants).toHaveLength(0);
    });

    it("does not let one person revoke another's grant", async () => {
      const { company } = await completeFlow();
      // Re-point the grant at a different user — the revoke must 404 rather
      // than touch someone else's connection.
      await db
        .update(assistantGrants)
        .set({ userId: randomUUID() })
        .where(eq(assistantGrants.userId, USER_ID));
      const grant = await db.select().from(assistantGrants).then((rows) => rows[0]!);
      const res = await request(app)
        .post(`/api/companies/${company.id}/me/assistant-grants/${grant.id}/revoke`)
        .send({});
      expect(res.status).toBe(404);
      const after = await db.select().from(assistantGrants).then((rows) => rows[0]!);
      expect(after.revokedAt).toBeNull();
    });
  });
});
