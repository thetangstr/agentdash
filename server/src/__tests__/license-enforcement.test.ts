/**
 * AgentDash on-prem SKU: the license gate.
 *
 * `requireLicense` shipped exported and wired to nothing — grep found no caller,
 * not a route and not a test — so `AGENTDASH_ENFORCE_LICENSE=true` and both
 * license values had no runtime effect at all. This suite covers the behaviour
 * now that app.ts mounts it, and pins the two exemptions that make an
 * unlicensed box recoverable rather than bricked.
 */
import crypto from "node:crypto";
import express from "express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requireLicense } from "../middleware/require-license.js";

const ENFORCE = "AGENTDASH_ENFORCE_LICENSE";
const KIND = "AGENTDASH_DEPLOYMENT_KIND";
const TOKEN = "AGENTDASH_LICENSE_KEY";
const PUBKEY = "AGENTDASH_LICENSE_PUBLIC_KEY";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Mint a license the way scripts/mint-license.mjs does: payloadB64.sigB64, ed25519. */
function mintLicense(claims: Record<string, unknown>) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const b64url = (b: Buffer) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = crypto.sign(null, Buffer.from(payload), privateKey);
  return {
    token: `${payload}.${b64url(sig)}`,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** A tiny app shaped like app.ts: an ungated probe, the gate, then a product route. */
function appWithGate() {
  const app = express();
  const api = express.Router();
  api.get("/health", (_req, res) => res.json({ status: "ok" })); // before the gate
  api.use(requireLicense);
  api.get("/companies", (_req, res) => res.json({ companies: [] })); // after the gate
  app.use("/api", api);
  return app;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [ENFORCE, KIND, TOKEN, PUBKEY]) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of [ENFORCE, KIND, TOKEN, PUBKEY]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("license gate — when it stays out of the way", () => {
  it("does nothing when enforcement is not switched on (every existing self-hoster)", async () => {
    delete process.env[ENFORCE];
    process.env[KIND] = "on_prem";
    delete process.env[TOKEN];
    const res = await request(appWithGate()).get("/api/companies");
    expect(res.status).toBe(200);
  });

  it("does nothing on a cloud deployment even with enforcement on", async () => {
    process.env[ENFORCE] = "true";
    process.env[KIND] = "cloud";
    delete process.env[TOKEN];
    const res = await request(appWithGate()).get("/api/companies");
    expect(res.status).toBe(200);
  });

  it("only 'true' arms it — a truthy-looking value does not", async () => {
    process.env[ENFORCE] = "1";
    process.env[KIND] = "on_prem";
    delete process.env[TOKEN];
    const res = await request(appWithGate()).get("/api/companies");
    expect(res.status).toBe(200);
  });
});

describe("license gate — when it refuses", () => {
  beforeEach(() => {
    process.env[ENFORCE] = "true";
    process.env[KIND] = "on_prem";
  });

  it("402s with no license configured, naming the reason", async () => {
    delete process.env[TOKEN];
    delete process.env[PUBKEY];
    const res = await request(appWithGate()).get("/api/companies");
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: "license_required", reason: "no_license" });
  });

  it("402s on a truncated token — the shape the install docs used to ship", async () => {
    // A real license is payload.signature; this is the elided placeholder that
    // was committed in the MKThink install prompt, with no dot at all.
    process.env[TOKEN] = "eyJjdXQifFAQ";
    process.env[PUBKEY] = mintLicense({ customer: "x" }).publicKeyPem;
    const res = await request(appWithGate()).get("/api/companies");
    expect(res.status).toBe(402);
    expect(res.body.reason).toBe("malformed");
  });

  it("402s when the signature does not match the configured public key", async () => {
    process.env[TOKEN] = mintLicense({ customer: "MKThink" }).token;
    process.env[PUBKEY] = mintLicense({ customer: "someone else" }).publicKeyPem; // different keypair
    const res = await request(appWithGate()).get("/api/companies");
    expect(res.status).toBe(402);
    expect(res.body.reason).toBe("bad_signature");
  });

  it("402s once the license has expired", async () => {
    const { token, publicKeyPem } = mintLicense({
      customer: "MKThink",
      plan: "on_prem",
      exp: Math.floor((Date.now() - DAY_MS) / 1000), // yesterday
    });
    process.env[TOKEN] = token;
    process.env[PUBKEY] = publicKeyPem;
    const res = await request(appWithGate()).get("/api/companies");
    expect(res.status).toBe(402);
    expect(res.body.reason).toBe("expired");
  });
});

describe("license gate — the exemptions that keep an unlicensed box recoverable", () => {
  beforeEach(() => {
    process.env[ENFORCE] = "true";
    process.env[KIND] = "on_prem";
    delete process.env[TOKEN];
    delete process.env[PUBKEY];
  });

  it("never gates /api/health, so an unlicensed box does not look like a boot failure", async () => {
    const res = await request(appWithGate()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });

  it("leaves /api/auth out of reach by construction (mounted on app, not this router)", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const authMount = source.indexOf('app.use("/api/auth"');
    const routerCreated = source.indexOf("const api = Router()");
    expect(authMount).toBeGreaterThan(-1);
    // Auth is registered on `app` before the gated router is even constructed.
    expect(authMount).toBeLessThan(routerCreated);
  });
});

describe("MKThink: six months free", () => {
  beforeEach(() => {
    process.env[ENFORCE] = "true";
    process.env[KIND] = "on_prem";
  });

  // `mint-license.mjs --days 180` is how the free period is granted, so the
  // 180-day window is the thing to hold onto, not an arbitrary expiry.
  const sixMonths = { customer: "MKThink", plan: "on_prem", days: 180 };

  it("a 180-day license is accepted on day one", async () => {
    const { token, publicKeyPem } = mintLicense({
      ...sixMonths,
      exp: Math.floor((Date.now() + 180 * DAY_MS) / 1000),
    });
    process.env[TOKEN] = token;
    process.env[PUBKEY] = publicKeyPem;
    const res = await request(appWithGate()).get("/api/companies");
    expect(res.status).toBe(200);
  });

  it("is still accepted at five months and twenty-nine days", async () => {
    // Mint as if issued 179 days ago with a 180-day term: still inside the window.
    const { token, publicKeyPem } = mintLicense({
      ...sixMonths,
      exp: Math.floor((Date.now() + 1 * DAY_MS) / 1000),
    });
    process.env[TOKEN] = token;
    process.env[PUBKEY] = publicKeyPem;
    const res = await request(appWithGate()).get("/api/companies");
    expect(res.status).toBe(200);
  });

  it("a perpetual license (no exp) never expires", async () => {
    const { token, publicKeyPem } = mintLicense({ customer: "MKThink", plan: "on_prem" });
    process.env[TOKEN] = token;
    process.env[PUBKEY] = publicKeyPem;
    const res = await request(appWithGate()).get("/api/companies");
    expect(res.status).toBe(200);
  });
});

describe("wiring guard — the mount order is the whole contract", () => {
  const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");

  it("app.ts actually applies the gate to the api router", () => {
    expect(source).toContain("api.use(requireLicense)");
    expect(source).toContain('from "./middleware/require-license.js"');
  });

  it("the gate sits AFTER /health and BEFORE the first product route", () => {
    const health = source.indexOf('"/health"');
    const gate = source.indexOf("api.use(requireLicense)");
    const firstProductRoute = source.indexOf('api.use("/companies"');
    expect(health).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(health); // health stays reachable unlicensed
    expect(gate).toBeLessThan(firstProductRoute); // product surface is gated
  });
});
