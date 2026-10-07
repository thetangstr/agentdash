// AgentDash (UltraQA QAD-6): standard response security headers.
//   - nosniff / Referrer-Policy / X-Frame-Options SAMEORIGIN on every response;
//   - no X-Powered-By once applySecurityHeaders has run;
//   - Strict-Transport-Security only when the request is HTTPS (X-Forwarded-
//     Proto honoured via `trust proxy`, as app.ts sets on internet-facing
//     deployments) or the configured public base URL is https — a plain-HTTP
//     box must not tell browsers to upgrade a transport it never serves;
//   - a stricter route-local X-Frame-Options (the /oauth/consent DENY) still
//     wins over the middleware's SAMEORIGIN.
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { applySecurityHeaders, securityHeaders } from "../middleware/security-headers.js";
import { registerConfiguredPublicBaseUrl } from "../lib/public-base-url.js";

const PUBLIC_URL_ENV_VARS = [
  "PAPERCLIP_CANONICAL_ORIGIN",
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
  "PAPERCLIP_ORIGINS",
] as const;

const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  registerConfiguredPublicBaseUrl(null);
});

function isolatePublicUrlEnv() {
  for (const key of PUBLIC_URL_ENV_VARS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}

function app(trustProxy = false) {
  const a = express();
  if (trustProxy) a.set("trust proxy", 1); // as app.ts sets on internet-facing boxes
  applySecurityHeaders(a);
  a.get("/probe", (_req, res) => res.json({ ok: true }));
  return a;
}

describe("applySecurityHeaders", () => {
  it("sends nosniff, Referrer-Policy and same-origin framing on every response", async () => {
    const res = await request(app()).get("/probe");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("hides X-Powered-By", async () => {
    const res = await request(app()).get("/probe");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("does not send HSTS on a plain-HTTP request with no https public base URL", async () => {
    isolatePublicUrlEnv();
    registerConfiguredPublicBaseUrl(null);
    const res = await request(app()).get("/probe");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("sends HSTS when the request arrives over HTTPS behind the edge proxy", async () => {
    isolatePublicUrlEnv();
    registerConfiguredPublicBaseUrl(null);
    const res = await request(app(true)).get("/probe").set("X-Forwarded-Proto", "https");
    expect(res.headers["strict-transport-security"]).toBe("max-age=15552000; includeSubDomains");
  });

  it("does not trust X-Forwarded-Proto when the box is not internet-facing", async () => {
    isolatePublicUrlEnv();
    registerConfiguredPublicBaseUrl(null);
    // trust proxy stays unset: a loopback client must not be able to mint
    // itself an HSTS policy on a box that only ever serves plain HTTP.
    const res = await request(app()).get("/probe").set("X-Forwarded-Proto", "https");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("sends HSTS when the configured public base URL is https", async () => {
    isolatePublicUrlEnv();
    registerConfiguredPublicBaseUrl("https://canary1.agentdash.cloud");
    const res = await request(app()).get("/probe");
    expect(res.headers["strict-transport-security"]).toBe("max-age=15552000; includeSubDomains");
  });

  it("does not send HSTS for an http public base URL", async () => {
    isolatePublicUrlEnv();
    registerConfiguredPublicBaseUrl("http://100.71.225.125:3100");
    const res = await request(app()).get("/probe");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });
});

describe("securityHeaders ordering", () => {
  it("keeps a stricter route-local frame policy", async () => {
    const a = express();
    a.use(securityHeaders());
    a.get("/consent", (_req, res) => {
      res.set("Content-Security-Policy", "frame-ancestors 'none'");
      res.set("X-Frame-Options", "DENY");
      res.json({ ok: true });
    });
    const res = await request(a).get("/consent");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  });
});
