import { describe, expect, it } from "vitest";
// The preflight is a standalone ops script (runs pre-build, no dist), tested here.
import { cloudPreflight } from "../../../scripts/cloud-preflight.mjs";

const PASSING = {
  PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
  PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef", // 32 chars
  DATABASE_URL: "postgres://u:p@host:5432/agentdash",
  PAPERCLIP_AUTH_PUBLIC_BASE_URL: "https://app.agentdash.com",
  AGENTDASH_DEFAULT_ADAPTER: "openai_compat",
  OPENAI_COMPAT_API_KEY: "sk-or-xxx",
  STRIPE_SECRET_KEY: "sk_live_xxx",
};

describe("cloudPreflight", () => {
  it("passes a fully-configured public cloud env with no errors", () => {
    const r = cloudPreflight(PASSING);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("fails when deployment mode is not authenticated", () => {
    const r = cloudPreflight({ ...PASSING, PAPERCLIP_DEPLOYMENT_MODE: "local_trusted" });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/authenticated/);
  });

  it("fails on a weak/dev BETTER_AUTH_SECRET", () => {
    const r = cloudPreflight({ ...PASSING, BETTER_AUTH_SECRET: "paperclip-dev-secret" });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/BETTER_AUTH_SECRET/);
  });

  it("fails when DATABASE_URL is missing", () => {
    const env = { ...PASSING };
    delete env.DATABASE_URL;
    expect(cloudPreflight(env).ok).toBe(false);
  });

  it("fails when the public base URL is not https", () => {
    const r = cloudPreflight({ ...PASSING, PAPERCLIP_AUTH_PUBLIC_BASE_URL: "http://app.agentdash.com" });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/https/);
  });

  it("fails when the selected LLM adapter has no key (would stub)", () => {
    const env = { ...PASSING };
    delete env.OPENAI_COMPAT_API_KEY;
    const r = cloudPreflight(env);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/stub replies/);
  });

  it("fails when a dangerous dev bypass is enabled", () => {
    const r = cloudPreflight({ ...PASSING, AGENTDASH_RATE_LIMIT_DISABLED: "true" });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/AGENTDASH_RATE_LIMIT_DISABLED/);
  });

  it("warns (not errors) when Stripe is unset", () => {
    const env = { ...PASSING };
    delete env.STRIPE_SECRET_KEY;
    const r = cloudPreflight(env);
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/STRIPE_SECRET_KEY/);
  });

  it("warns when exposure is not public but does not hard-fail", () => {
    const r = cloudPreflight({ ...PASSING, PAPERCLIP_DEPLOYMENT_EXPOSURE: "private" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/public/);
  });
});
