// AgentDash (#766, SC-5): a hosted box behind the edge router.
//   - with AGENTDASH_EDGE_SECRET set, a request without or with a wrong edge
//     header is refused (health still answers); a matching one passes;
//   - a spoofed X-AgentDash-Client-IP is ignored without a valid edge header;
//     with one, req.ip and so the rate limiter key on it;
//   - a WebSocket upgrade without the header is refused;
//   - the secret never reaches a handler (so never a log line);
//   - with the variable unset, nothing changes.
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { rateLimit } from "express-rate-limit";
import request from "supertest";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  EDGE_CLIENT_IP_HEADER,
  EDGE_SECRET_HEADER,
  edgeClientIp,
  edgeGate,
  edgeHeaderMatches,
  isEdgeExempt,
} from "../middleware/edge-gate.js";
import { hostedBoxConfigErrors } from "../hosted-box-guard.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { LOG_REDACT_PATHS } from "../middleware/logger.js";
import { oauthRoutes } from "../routes/oauth.js";
import { buildBetterAuthAdvancedOptions } from "../auth/better-auth.js";
import { configuredEdgeSecrets } from "../middleware/edge-gate.js";

const SECRET = "e".repeat(8) + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function app(secret: string | null, limit?: number) {
  const a = express();
  a.set("trust proxy", 1); // as app.ts sets on internet-facing boxes
  a.use(edgeGate({ secret }));
  if (limit) {
    a.use(
      rateLimit({ windowMs: 60_000, max: limit, standardHeaders: "draft-7", legacyHeaders: false, validate: false }),
    );
  }
  a.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  a.all("/{*rest}", (req, res) =>
    res.json({ ip: req.ip, sawEdgeHeader: EDGE_SECRET_HEADER in req.headers, sawClientIpHeader: EDGE_CLIENT_IP_HEADER in req.headers }),
  );
  return a;
}

describe("edge helpers", () => {
  it("compares the secret in constant time and exactly", () => {
    expect(edgeHeaderMatches(SECRET, SECRET)).toBe(true);
    expect(edgeHeaderMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(edgeHeaderMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(edgeHeaderMatches(undefined, SECRET)).toBe(false);
    expect(edgeHeaderMatches([SECRET], SECRET)).toBe(true);
  });

  it("exempts only GET and HEAD /api/health", () => {
    expect(isEdgeExempt("GET", "/api/health")).toBe(true);
    expect(isEdgeExempt("HEAD", "/api/health/")).toBe(true);
    expect(isEdgeExempt("GET", "/api/health?x=1")).toBe(true);
    expect(isEdgeExempt("POST", "/api/health")).toBe(false);
    expect(isEdgeExempt("GET", "/api/healthz")).toBe(false);
    expect(isEdgeExempt("GET", "/api/health/../companies")).toBe(false);
  });

  it("accepts only a valid IP as the client address", () => {
    expect(edgeClientIp("203.0.113.9")).toBe("203.0.113.9");
    expect(edgeClientIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(edgeClientIp("2001:db8::1")).toBe("2001:db8::1");
    expect(edgeClientIp("203.0.113.9, 10.0.0.1")).toBeNull();
    expect(edgeClientIp("not-an-ip")).toBeNull();
  });
});

describe("with AGENTDASH_EDGE_SECRET set", () => {
  it("refuses requests without or with a wrong edge header, and lets health through", async () => {
    const a = app(SECRET);
    const none = await request(a).get("/api/companies");
    expect(none.status).toBe(403);
    expect(none.body.code).toBe("edge_required");
    expect((await request(a).get("/api/companies").set(EDGE_SECRET_HEADER, "wrong")).status).toBe(403);
    expect((await request(a).post("/api/auth/sign-up/email").send({})).status).toBe(403);
    expect((await request(a).get("/api/health")).status).toBe(200);
    expect((await request(a).post("/api/health")).status).toBe(403);
    const ok = await request(a).get("/api/companies").set(EDGE_SECRET_HEADER, SECRET);
    expect(ok.status).toBe(200);
  });

  it("never passes the secret on to a handler", async () => {
    const res = await request(app(SECRET)).get("/api/companies").set(EDGE_SECRET_HEADER, SECRET);
    expect(res.body.sawEdgeHeader).toBe(false);
    expect(LOG_REDACT_PATHS).toContain('req.headers["x-agentdash-edge"]');
  });

  it("ignores a spoofed client IP without a valid edge header, and uses it with one", async () => {
    const a = app(SECRET);
    // Health is reachable without the header, so it is where a spoof would land.
    const spoofApp = express();
    spoofApp.set("trust proxy", 1);
    spoofApp.use(edgeGate({ secret: SECRET }));
    spoofApp.get("/api/health", (req, res) => res.json({ ip: req.ip, sawClientIpHeader: EDGE_CLIENT_IP_HEADER in req.headers }));
    const spoofed = await request(spoofApp).get("/api/health").set(EDGE_CLIENT_IP_HEADER, "198.51.100.66");
    expect(spoofed.body.ip).not.toBe("198.51.100.66");
    expect(spoofed.body.sawClientIpHeader).toBe(false);

    const routed = await request(a).get("/x").set(EDGE_SECRET_HEADER, SECRET).set(EDGE_CLIENT_IP_HEADER, "203.0.113.9");
    expect(routed.body.ip).toBe("203.0.113.9");
    // X-Forwarded-For (the router's address, overwritten by Railway's edge) no longer decides.
    const withXff = await request(a)
      .get("/x")
      .set(EDGE_SECRET_HEADER, SECRET)
      .set(EDGE_CLIENT_IP_HEADER, "203.0.113.10")
      .set("X-Forwarded-For", "100.64.0.3");
    expect(withXff.body.ip).toBe("203.0.113.10");
  });

  it("rate limits per visitor behind the router, not per router", async () => {
    const a = app(SECRET, 1);
    const as = (ip: string) => request(a).get("/x").set(EDGE_SECRET_HEADER, SECRET).set(EDGE_CLIENT_IP_HEADER, ip);
    expect((await as("203.0.113.1")).status).toBe(200);
    expect((await as("203.0.113.2")).status).toBe(200);
    expect((await as("203.0.113.1")).status).toBe(429);
  });

  describe("WebSocket upgrades", () => {
    let server: http.Server | null = null;
    const saved = process.env.AGENTDASH_EDGE_SECRET;
    afterEach(async () => {
      if (saved === undefined) delete process.env.AGENTDASH_EDGE_SECRET;
      else process.env.AGENTDASH_EDGE_SECRET = saved;
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      server = null;
    });

    async function upgrade(headers: Record<string, string>): Promise<"open" | number> {
      server = http.createServer();
      setupLiveEventsWebSocketServer(server, {} as never, { deploymentMode: "local_trusted" });
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as AddressInfo).port;
      return await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/companies/c1/events/ws`, { headers });
        ws.on("open", () => {
          ws.close();
          resolve("open");
        });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", () => resolve(0));
      });
    }

    it("refuses an upgrade without the edge header and accepts one with it", async () => {
      process.env.AGENTDASH_EDGE_SECRET = SECRET;
      expect(await upgrade({})).toBe(403);
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
      expect(await upgrade({ [EDGE_SECRET_HEADER]: "wrong" })).toBe(403);
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
      expect(await upgrade({ [EDGE_SECRET_HEADER]: SECRET })).toBe("open");
    });

    it("is unchanged when the secret is unset", async () => {
      delete process.env.AGENTDASH_EDGE_SECRET;
      expect(await upgrade({})).toBe("open");
    });
  });
});

describe("with AGENTDASH_EDGE_SECRET unset", () => {
  it("passes everything and ignores the client IP header", async () => {
    const a = app(null);
    const res = await request(a).get("/x").set(EDGE_CLIENT_IP_HEADER, "198.51.100.7");
    expect(res.status).toBe(200);
    expect(res.body.ip).not.toBe("198.51.100.7");
  });
});

const guardBase = {
  AGENTDASH_DEPLOYMENT_KIND: "hosted",
  PAPERCLIP_PUBLIC_URL: "https://acme.agentdash.cloud",
  PAPERCLIP_AUTH_PUBLIC_BASE_URL: "https://acme.agentdash.cloud",
  AGENTDASH_HERMES_MANAGED_PROFILES: "true",
  AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: "true",
  AGENTDASH_INVITE_CODES: "AGD-0123456789ABCDEF0123456789",
} as NodeJS.ProcessEnv;
const guardConfig = { deploymentMode: "authenticated", authBaseUrlMode: "explicit", authPublicBaseUrl: "https://acme.agentdash.cloud", authDisableSignUp: false } as Parameters<typeof hostedBoxConfigErrors>[0];
function edgeErrors(env: NodeJS.ProcessEnv) {
  return hostedBoxConfigErrors(guardConfig, { ...guardBase, ...env }).filter((e) => /EDGE/.test(e));
}

describe("hosted boot guard", () => {
  const base = {
    AGENTDASH_DEPLOYMENT_KIND: "hosted",
    PAPERCLIP_PUBLIC_URL: "https://acme.agentdash.cloud",
    PAPERCLIP_AUTH_PUBLIC_BASE_URL: "https://acme.agentdash.cloud",
    AGENTDASH_HERMES_MANAGED_PROFILES: "true",
    AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: "true",
    AGENTDASH_INVITE_CODES: "AGD-0123456789ABCDEF0123456789",
  } as NodeJS.ProcessEnv;
  const config = { deploymentMode: "authenticated", authBaseUrlMode: "explicit", authPublicBaseUrl: "https://acme.agentdash.cloud", authDisableSignUp: false } as Parameters<typeof hostedBoxConfigErrors>[0];

  it("accepts a long secret with an https public URL under the edge domain", () => {
    expect(edgeErrors({ AGENTDASH_EDGE_SECRET: SECRET, AGENTDASH_EDGE_DOMAIN: "agentdash.cloud" })).toEqual([]);
    expect(edgeErrors({})).toEqual([]);
  });

  it("refuses a short secret, a non-https public URL and a public URL outside the edge domain", () => {
    expect(edgeErrors({ AGENTDASH_EDGE_SECRET: "short" }).join("\n")).toMatch(/shorter than 32/);
    expect(edgeErrors({ AGENTDASH_EDGE_SECRET: SECRET, PAPERCLIP_PUBLIC_URL: "http://acme.agentdash.cloud" }).join("\n")).toMatch(/not https/);
    expect(edgeErrors({ AGENTDASH_EDGE_SECRET: SECRET, PAPERCLIP_PUBLIC_URL: "https://web-x.up.railway.app", AGENTDASH_EDGE_DOMAIN: "agentdash.cloud" }).join("\n")).toMatch(/not under the edge domain/);
  });
});

describe("OAuth issuer behind the edge", () => {
  const saved = { url: process.env.PAPERCLIP_PUBLIC_URL, auth: process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL };
  afterEach(() => {
    if (saved.url === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
    else process.env.PAPERCLIP_PUBLIC_URL = saved.url;
    if (saved.auth === undefined) delete process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL;
    else process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = saved.auth;
  });

  it("advertises the slug host as issuer and resource, whatever Host the router's request carries", async () => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://acme.agentdash.cloud";
    const a = express();
    a.set("trust proxy", 1);
    a.use(edgeGate({ secret: SECRET }));
    a.use(oauthRoutes({} as never, { deploymentMode: "authenticated" }));
    const viaRouter = (path: string) =>
      request(a).get(path).set("Host", "web-production-a78ce.up.railway.app").set(EDGE_SECRET_HEADER, SECRET).set(EDGE_CLIENT_IP_HEADER, "203.0.113.9");
    const as = await viaRouter("/.well-known/oauth-authorization-server");
    expect(as.status, JSON.stringify(as.body)).toBe(200);
    expect(as.body.issuer).toBe("https://acme.agentdash.cloud");
    expect(as.body.token_endpoint).toBe("https://acme.agentdash.cloud/oauth/token");
    const prm = await viaRouter("/.well-known/oauth-protected-resource/api/mcp/assistant");
    expect(prm.status).toBe(200);
    expect(JSON.stringify(prm.body)).not.toContain("railway.app");
    expect(prm.body.resource).toMatch(/^https:\/\/acme\.agentdash\.cloud\//);
    // The Railway host itself, without the router, cannot reach the metadata at all.
    expect((await request(a).get("/.well-known/oauth-authorization-server").set("Host", "web-production-a78ce.up.railway.app")).status).toBe(403);
  });
});

describe("#807 review", () => {
  const PREVIOUS = "p".repeat(8) + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

  it("accepts the previous secret during a rotation, and nothing else", async () => {
    const a = express();
    a.use(edgeGate({ secret: SECRET, previous: PREVIOUS }));
    a.get("/x", (_req, res) => res.json({ ok: true }));
    expect((await request(a).get("/x").set(EDGE_SECRET_HEADER, SECRET)).status).toBe(200);
    expect((await request(a).get("/x").set(EDGE_SECRET_HEADER, PREVIOUS)).status).toBe(200);
    expect((await request(a).get("/x").set(EDGE_SECRET_HEADER, "neither")).status).toBe(403);
    expect(configuredEdgeSecrets({ AGENTDASH_EDGE_SECRET: SECRET, AGENTDASH_EDGE_SECRET_PREVIOUS: PREVIOUS } as NodeJS.ProcessEnv)).toEqual([SECRET, PREVIOUS]);
    expect(configuredEdgeSecrets({ AGENTDASH_EDGE_SECRET_PREVIOUS: PREVIOUS } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("points Better Auth's rate limiter at the router's client address only when the edge secret is set", () => {
    expect(buildBetterAuthAdvancedOptions({ disableSecureCookies: false, edgeSecretSet: true })).toMatchObject({ ipAddress: { ipAddressHeaders: ["x-agentdash-client-ip"] } });
    expect(buildBetterAuthAdvancedOptions({ disableSecureCookies: false, edgeSecretSet: false })).not.toHaveProperty("ipAddress");
  });

  it("drops an invalid client address even with a matching secret", async () => {
    const res = await request(app(SECRET)).get("/x").set(EDGE_SECRET_HEADER, SECRET).set(EDGE_CLIENT_IP_HEADER, "not-an-ip");
    expect(res.body.sawClientIpHeader).toBe(false);
  });

  it("the boot guard refuses an edge secret without AGENTDASH_EDGE_DOMAIN, and a short previous secret", () => {
    expect(edgeErrors({ AGENTDASH_EDGE_SECRET: SECRET }).join("\n")).toMatch(/AGENTDASH_EDGE_DOMAIN is not/);
    expect(edgeErrors({ AGENTDASH_EDGE_SECRET: SECRET, AGENTDASH_EDGE_DOMAIN: "agentdash.cloud", AGENTDASH_EDGE_SECRET_PREVIOUS: "short" }).join("\n")).toMatch(/PREVIOUS is shorter/);
  });
});
