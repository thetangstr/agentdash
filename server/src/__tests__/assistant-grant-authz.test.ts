import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assistantAccessTokens,
  assistantGrants,
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
import { assistantRoutes } from "../routes/assistant.js";
import { mcpRoutes } from "../routes/mcp.js";

/**
 * GH #677: the `assistant_grant` actor and its route/scope allowlist. These
 * tests stand up the REAL actorMiddleware over embedded Postgres, seed grant
 * rows directly, and probe the boundary conditions: wrong audience, expired,
 * revoked, non-allowlisted route, cross-company, insufficient scope.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const PUBLIC_BASE = "http://127.0.0.1:7777";
const CANONICAL_RESOURCE = `${PUBLIC_BASE}/api/mcp/assistant`;
const USER_ID = randomUUID();

function hash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

describeEmbeddedPostgres("assistant_grant actor authorization", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assistant-authz-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE);
    app = express();
    app.use(express.json());
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.use("/api", assistantRoutes(db));
    app.use("/api", mcpRoutes());
    // Probe endpoint standing in for a route the allowlist does NOT cover —
    // if the middleware lets a request through, this records the actor it saw.
    app.get("/api/companies/:companyId/labels", (req, res) => {
      res.json({ reached: true, actor: req.actor });
    });
    // Probe for the roster read — the allowlist must let a read grant reach
    // it; the real handler lives in access.ts and needs only company access.
    app.get("/api/companies/:companyId/people", (req, res) => {
      res.json({ reached: true });
    });
    app.use(errorHandler);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(assistantAccessTokens);
    await db.delete(assistantRefreshTokens);
    await db.delete(assistantGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(companyCount = 1) {
    const company = await db
      .insert(companies)
      .values({ name: `Acme ${randomUUID()}`, issuePrefix: `AC${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    let other: typeof company | null = null;
    if (companyCount > 1) {
      other = await db
        .insert(companies)
        .values({ name: `Other ${randomUUID()}`, issuePrefix: `OT${randomUUID().slice(0, 4).toUpperCase()}` })
        .returning()
        .then((rows) => rows[0]!);
      await db.insert(companyMemberships).values({
        companyId: other.id,
        principalType: "user",
        principalId: USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
    return { company, other };
  }

  /** Mint a grant + access token directly — the OAuth flow is covered in assistant-oauth.test.ts. */
  async function mintToken(overrides: {
    scopes?: string[];
    companyId: string;
    userId?: string;
    resource?: string;
    accessExpiresInMs?: number;
    grantRevoked?: boolean;
    accessRevoked?: boolean;
  }) {
    const grant = await db
      .insert(assistantGrants)
      .values({
        companyId: overrides.companyId,
        userId: overrides.userId ?? USER_ID,
        clientId: "dcr_test",
        clientName: "Test Client",
        redirectHost: "assistant.example",
        scopes: overrides.scopes ?? ["agentdash:read"],
        revokedAt: overrides.grantRevoked ? new Date() : null,
      })
      .returning()
      .then((rows) => rows[0]!);
    const token = `pcpa_${randomBytes(24).toString("base64url")}`;
    await db.insert(assistantAccessTokens).values({
      tokenHash: hash(token),
      grantId: grant.id,
      familyId: randomUUID(),
      resource: overrides.resource ?? CANONICAL_RESOURCE,
      scopes: overrides.scopes ?? ["agentdash:read"],
      expiresAt: new Date(Date.now() + (overrides.accessExpiresInMs ?? 3_600_000)),
      revokedAt: overrides.accessRevoked ? new Date() : null,
    });
    return { grant, token };
  }

  it("mints a board-shaped actor pinned to the grant's company", async () => {
    const { company } = await seed();
    const { grant, token } = await mintToken({ companyId: company.id });
    const res = await request(app)
      .get(`/api/companies/${company.id}/assistant/digest`)
      .set("authorization", `Bearer ${token}`);
    // The digest service runs against a real company — an empty digest is fine;
    // what matters is that authz accepted the actor (not 401/403).
    expect(res.status).toBe(200);
    void grant;
  });

  it("reaches the member-roster read the toolset uses for human assignee names", async () => {
    const { company } = await seed();
    const { token } = await mintToken({ companyId: company.id });
    const res = await request(app)
      .get(`/api/companies/${company.id}/people`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });

  it("returns 401 with WWW-Authenticate for a missing token on the MCP endpoint", async () => {
    const res = await request(app).post("/api/mcp/assistant").send({ jsonrpc: "2.0", id: 1 });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
    expect(res.headers["www-authenticate"]).toContain("resource_metadata");
    expect(res.headers["www-authenticate"]).toContain(
      "/.well-known/oauth-protected-resource/api/mcp/assistant",
    );
  });

  it("returns 401 for a garbage token", async () => {
    const res = await request(app)
      .post("/api/mcp/assistant")
      .set("authorization", "Bearer pcpa_garbage")
      .send({ jsonrpc: "2.0", id: 1 });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired access token", async () => {
    const { company } = await seed();
    const { token } = await mintToken({ companyId: company.id, accessExpiresInMs: -60_000 });
    const res = await request(app)
      .post("/api/mcp/assistant")
      .set("authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1 });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a revoked access token", async () => {
    const { company } = await seed();
    const { token } = await mintToken({ companyId: company.id, accessRevoked: true });
    const res = await request(app)
      .post("/api/mcp/assistant")
      .set("authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1 });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a token minted against a different audience", async () => {
    const { company } = await seed();
    const { token } = await mintToken({
      companyId: company.id,
      resource: "https://other.example/api/mcp/assistant",
    });
    const res = await request(app)
      .post("/api/mcp/assistant")
      .set("authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1 });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the grant behind the token is revoked", async () => {
    const { company } = await seed();
    const { token } = await mintToken({ companyId: company.id, grantRevoked: true });
    const res = await request(app)
      .post("/api/mcp/assistant")
      .set("authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1 });
    expect(res.status).toBe(401);
  });

  it("returns 403 on a route outside the assistant allowlist", async () => {
    const { company } = await seed();
    const { token } = await mintToken({ companyId: company.id });
    const res = await request(app)
      .get(`/api/companies/${company.id}/labels`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Assistant credentials/);
  });

  it("returns 403 crossing into another company", async () => {
    const { company, other } = await seed(2);
    const { token } = await mintToken({ companyId: company.id });
    const res = await request(app)
      .get(`/api/companies/${other!.id}/assistant/digest`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 insufficient_scope on a work route with a read-only grant", async () => {
    const { company } = await seed();
    const { token } = await mintToken({ companyId: company.id, scopes: ["agentdash:read"] });
    const res = await request(app)
      .post(`/api/companies/${company.id}/issues`)
      .set("authorization", `Bearer ${token}`)
      .send({ title: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("insufficient_scope");
    expect(res.body.required_scope).toBe("agentdash:work");
  });

  it("returns 403 insufficient_scope on a decide route without the decide scope", async () => {
    const { company } = await seed();
    const { token } = await mintToken({
      companyId: company.id,
      scopes: ["agentdash:read", "agentdash:work"],
    });
    const res = await request(app)
      .post(`/api/approvals/${randomUUID()}/approve`)
      .set("authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("insufficient_scope");
    expect(res.body.required_scope).toBe("agentdash:decide");
  });

  it("returns 405 for GET on the MCP assistant endpoint", async () => {
    const { company } = await seed();
    const { token } = await mintToken({ companyId: company.id });
    const res = await request(app)
      .get("/api/mcp/assistant")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(405);
  });

  it("returns 403 for an untrusted Origin on the MCP endpoint", async () => {
    const { company } = await seed();
    const { token } = await mintToken({ companyId: company.id });
    const res = await request(app)
      .post("/api/mcp/assistant")
      .set("authorization", `Bearer ${token}`)
      .set("origin", "https://evil.example")
      .send({ jsonrpc: "2.0", id: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Origin/);
  });
});
