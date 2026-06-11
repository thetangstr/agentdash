import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deploymentKind,
  inferenceMarkupEnabled,
  licenseStatusFromEnv,
  verifyLicense,
} from "../services/license.js";

// Generate an ed25519 keypair for signing test licenses.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeLicense(claims: Record<string, unknown>): string {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = crypto.sign(null, Buffer.from(payloadB64), privateKey);
  return `${payloadB64}.${b64url(sig)}`;
}

const NOW = 1_700_000_000_000; // fixed clock (ms)

describe("verifyLicense", () => {
  it("accepts a valid, unexpired, correctly-signed license", () => {
    const token = makeLicense({ customer: "Acme", plan: "on_prem", seats: 50 });
    const status = verifyLicense(token, PUBLIC_PEM, NOW);
    expect(status.valid).toBe(true);
    expect(status.claims).toMatchObject({ customer: "Acme", seats: 50 });
  });

  it("rejects when no license is provided", () => {
    expect(verifyLicense(undefined, PUBLIC_PEM, NOW)).toEqual({ valid: false, reason: "no_license" });
  });

  it("rejects when no public key is configured", () => {
    const token = makeLicense({ customer: "Acme" });
    expect(verifyLicense(token, undefined, NOW)).toEqual({ valid: false, reason: "no_public_key" });
  });

  it("rejects a malformed token", () => {
    expect(verifyLicense("not-a-token", PUBLIC_PEM, NOW).reason).toBe("malformed");
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const token = makeLicense({ customer: "Acme", seats: 1 });
    const [, sig] = token.split(".");
    const forgedPayload = b64url(Buffer.from(JSON.stringify({ customer: "Acme", seats: 9999 })));
    const forged = `${forgedPayload}.${sig}`;
    expect(verifyLicense(forged, PUBLIC_PEM, NOW).reason).toBe("bad_signature");
  });

  it("rejects an expired license but still surfaces its claims", () => {
    const expSeconds = Math.floor(NOW / 1000) - 60; // 60s in the past
    const token = makeLicense({ customer: "Acme", exp: expSeconds });
    const status = verifyLicense(token, PUBLIC_PEM, NOW);
    expect(status.valid).toBe(false);
    expect(status.reason).toBe("expired");
    expect(status.claims).toMatchObject({ customer: "Acme" });
  });

  it("accepts a license whose expiry is in the future", () => {
    const expSeconds = Math.floor(NOW / 1000) + 3600;
    const token = makeLicense({ customer: "Acme", exp: expSeconds });
    expect(verifyLicense(token, PUBLIC_PEM, NOW).valid).toBe(true);
  });

  it("rejects a license signed by a different key", () => {
    const other = crypto.generateKeyPairSync("ed25519");
    const payloadB64 = b64url(Buffer.from(JSON.stringify({ customer: "Acme" })));
    const sig = crypto.sign(null, Buffer.from(payloadB64), other.privateKey);
    const token = `${payloadB64}.${b64url(sig)}`;
    expect(verifyLicense(token, PUBLIC_PEM, NOW).valid).toBe(false);
  });
});

describe("deploymentKind + inferenceMarkupEnabled", () => {
  const ORIG = process.env.AGENTDASH_DEPLOYMENT_KIND;
  beforeEach(() => delete process.env.AGENTDASH_DEPLOYMENT_KIND);
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    else process.env.AGENTDASH_DEPLOYMENT_KIND = ORIG;
  });

  it("defaults to cloud (markup enabled)", () => {
    expect(deploymentKind()).toBe("cloud");
    expect(inferenceMarkupEnabled()).toBe(true);
  });

  it("on_prem disables inference markup", () => {
    process.env.AGENTDASH_DEPLOYMENT_KIND = "on_prem";
    expect(deploymentKind()).toBe("on_prem");
    expect(inferenceMarkupEnabled()).toBe(false);
  });
});

describe("licenseStatusFromEnv", () => {
  const KEYS = ["AGENTDASH_LICENSE_KEY", "AGENTDASH_LICENSE_PUBLIC_KEY"] as const;
  const ORIG = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  beforeEach(() => KEYS.forEach((k) => delete process.env[k]));
  afterEach(() => {
    for (const k of KEYS) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k]!;
    }
  });

  it("reads token + public key from env", () => {
    process.env.AGENTDASH_LICENSE_KEY = makeLicense({ customer: "Acme" });
    process.env.AGENTDASH_LICENSE_PUBLIC_KEY = PUBLIC_PEM;
    expect(licenseStatusFromEnv(NOW).valid).toBe(true);
  });

  it("is invalid with no env configured", () => {
    expect(licenseStatusFromEnv(NOW).valid).toBe(false);
  });
});
