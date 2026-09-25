import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
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
import {
  mintAssistantLoopbackToken,
  resetAssistantLoopbackTokens,
  revokeAssistantLoopbackToken,
} from "../services/assistant-loopback.js";

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
    // Probe endpoints standing in for raw REST routes the allowlist does NOT
    // cover — if the middleware lets a request through, this records the actor
    // it saw. The security review (GH #688) named these three specifically:
    // agents leaks adapterConfig, runs leaks contextSnapshot, people leaks
    // member emails. `pcpa_` must 403 on all of them now.
    const probe = (req: Request, res: Response) => {
      res.json({ reached: true, actor: req.actor });
    };
    app.get("/api/companies/:companyId/labels", probe);
    app.get("/api/companies/:companyId/people", probe);
    app.get("/api/companies/:companyId/agents", probe);
    app.get("/api/issues/:id/runs", probe);
    app.post("/api/companies/:companyId/agents", probe);
    app.post("/api/companies/:companyId/issues", probe);
    app.patch("/api/issues/:id", probe);
    app.post("/api/approvals/:id/approve", probe);
    app.use(errorHandler);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetAssistantLoopbackTokens();
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

  it("returns 403 for a pcpa_ token on the assistant read routes — no raw REST", async () => {
    const { company } = await seed();
    const { grant, token } = await mintToken({ companyId: company.id });
    const res = await request(app)
      .get(`/api/companies/${company.id}/assistant/digest`)
      .set("authorization", `Bearer ${token}`);
    // GH #688: even the toolset's own read surface is closed to the raw
    // bearer — tool calls loop back on an internal pcin_ credential instead.
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Assistant credentials/);
    void grant;
  });

  it("returns 401 with WWW-Authenticate for a missing token on the MCP endpoint", async () => {
    const res = await request(app).post("/api/mcp/assistant").send({ jsonrpc: "2.0", id: 1 });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
    expect(res.headers["www-authenticate"]).toContain("resource_metadata");
    expect(res.headers["www-authenticate"]).toContain(
      "/.well-known/oauth-protected-resource/api/mcp/assistant",
    );
    // RFC 6750 §3: the challenge advertises the scope the endpoint needs.
    expect(res.headers["www-authenticate"]).toContain('scope="agentdash:read"');
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

  // GH #688 HIGH/M5: the raw-REST side door is closed entirely. A pcpa_
  // bearer — at ANY scope, including work and decide — reaches nothing but
  // POST /api/mcp/assistant. These probes would have answered with
  // unredacted adapterConfig / contextSnapshot / member emails before the
  // security round.
  describe("REST side door closed (GH #688)", () => {
    const rawReads: Array<[string, string]> = [
      ["agents roster (adapterConfig)", "/api/companies/{id}/agents"],
      ["member roster (emails)", "/api/companies/{id}/people"],
      ["issue runs (contextSnapshot)", "/api/issues/{id}/runs"],
      ["assistant digest", "/api/companies/{id}/assistant/digest"],
      ["pending decisions", "/api/companies/{id}/assistant/pending-decisions"],
    ];
    const rawWrites: Array<[string, string, string]> = [
      ["agent create incl. process adapter (decide)", "POST", "/api/companies/{id}/agents"],
      ["issue create (work)", "POST", "/api/companies/{id}/issues"],
      ["arbitrary issue PATCH (work)", "PATCH", "/api/issues/{id}"],
      ["approval decision (decide)", "POST", "/api/approvals/{id}/approve"],
    ];

    it.each(rawReads)("403s on %s even with all scopes", async (_label, pathTemplate) => {
      const { company } = await seed();
      const { token } = await mintToken({
        companyId: company.id,
        scopes: ["agentdash:read", "agentdash:work", "agentdash:decide"],
      });
      const res = await request(app)
        .get(pathTemplate.replace("{id}", company.id))
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Assistant credentials/);
      expect(res.body.reached).toBeUndefined();
    });

    it.each(rawWrites)("403s on %s even with all scopes", async (_label, method, pathTemplate) => {
      const { company } = await seed();
      const { token } = await mintToken({
        companyId: company.id,
        scopes: ["agentdash:read", "agentdash:work", "agentdash:decide"],
      });
      const res = await request(app)
        [method.toLowerCase() as "post" | "patch"](pathTemplate.replace("{id}", company.id))
        .set("authorization", `Bearer ${token}`)
        .send({ adapterType: "process", name: "x" });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Assistant credentials/);
      expect(res.body.reached).toBeUndefined();
    });

    it("the allowlist contains zero raw REST routes", async () => {
      const { ASSISTANT_ROUTE_SCOPES } = await import("@paperclipai/shared");
      for (const route of ASSISTANT_ROUTE_SCOPES) {
        expect(route.pattern.source).toContain("mcp");
      }
      expect(ASSISTANT_ROUTE_SCOPES).toHaveLength(3);
    });
  });

  // GH #688: the internal loopback credential the MCP endpoint mints for its
  // tool calls. In-memory only, dies on revoke — and an unknown pcin_
  // resolves to nothing rather than falling through to other lookups.
  // GH #678: writes pass only through the five-route allowlist, and only
  // when the grant carries `agentdash:work`.
  describe("assistant loopback credential (pcin_)", () => {
    function mintLoopback(companyId: string, grantId = randomUUID(), scopes = ["agentdash:read"]) {
      return mintAssistantLoopbackToken({
        userId: USER_ID,
        companyId,
        membershipRole: "owner",
        grantId,
        scopes,
      });
    }

    it("resolves to the grant's board-shaped actor and reaches GET routes", async () => {
      const { company } = await seed();
      const token = mintLoopback(company.id);
      const res = await request(app)
        .get(`/api/companies/${company.id}/agents`)
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.reached).toBe(true);
      expect(res.body.actor.type).toBe("board");
      expect(res.body.actor.companyId).toBe(company.id);
      expect(res.body.actor.assistantLoopback).toBe(true);
      expect(res.body.actor.source).toBe("assistant_grant");
    });

    it("refuses writes on a read-only grant, and non-allowlisted writes even with agentdash:work", async () => {
      const { company } = await seed();
      const readToken = mintLoopback(company.id);
      // GH #678: allowlisted write routes on a grant without agentdash:work —
      // insufficient_scope, before the rate limiter or the route.
      for (const [method, path] of [
        ["post", `/api/companies/${company.id}/issues`],
        ["patch", `/api/issues/${randomUUID()}`],
      ] as const) {
        const res = await request(app)
          [method](path)
          .set("authorization", `Bearer ${readToken}`)
          .send({ title: "x" });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("insufficient_scope");
        expect(res.body.required_scope).toBe("agentdash:work");
        expect(res.body.reached).toBeUndefined();
      }
      // A route outside the M3 allowlist is refused even when the grant has
      // the work scope — the allowlist is the hard wall.
      const workToken = mintLoopback(company.id, randomUUID(), ["agentdash:read", "agentdash:work"]);
      const res = await request(app)
        .post(`/api/companies/${company.id}/agents`)
        .set("authorization", `Bearer ${workToken}`)
        .send({ adapterType: "process", name: "x" });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/cannot write/);
      expect(res.body.reached).toBeUndefined();
    });

    it("an unknown pcin_ token resolves to no actor — no fall-through", async () => {
      const { company } = await seed();
      const res = await request(app)
        .get(`/api/companies/${company.id}/agents`)
        .set("authorization", "Bearer pcin_never-minted");
      expect(res.status).toBe(200);
      expect(res.body.actor.type).toBe("none");
    });

    it("a revoked pcin_ token is dead immediately", async () => {
      const { company } = await seed();
      const token = mintLoopback(company.id);
      revokeAssistantLoopbackToken(token);
      const res = await request(app)
        .get(`/api/companies/${company.id}/agents`)
        .set("authorization", `Bearer ${token}`);
      expect(res.body.actor.type).toBe("none");
    });
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
