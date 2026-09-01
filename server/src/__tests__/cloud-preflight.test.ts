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
  // These three became REQUIRED alongside STRIPE_SECRET_KEY on 2026-07-31.
  // This fixture was named "PASSING" while omitting all of them — a deploy
  // shaped exactly like it would have passed preflight and then failed at the
  // customer's first click, because an unset BILLING_PUBLIC_BASE_URL makes
  // Stripe's success_url relative and Stripe rejects it.
  STRIPE_PRO_PRICE_ID: "price_xxx",
  STRIPE_WEBHOOK_SECRET: "whsec_xxx",
  BILLING_PUBLIC_BASE_URL: "https://app.agentdash.example",
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

  // -- billing configuration -------------------------------------------------
  //
  // Added 2026-07-31. Preflight only warned about a missing STRIPE_SECRET_KEY
  // and never checked its companions, so a deploy could pass here and break at
  // the customer's first click. The sharpest case is BILLING_PUBLIC_BASE_URL:
  // unset, `success_url` becomes the relative string "/billing?session=success",
  // which Stripe rejects outright.

  it("fails when the Stripe price id is missing", () => {
    const env = { ...PASSING };
    delete env.STRIPE_PRO_PRICE_ID;
    const r = cloudPreflight(env);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/STRIPE_PRO_PRICE_ID/);
  });

  it("fails when the Stripe webhook secret is missing", () => {
    const env = { ...PASSING };
    delete env.STRIPE_WEBHOOK_SECRET;
    const r = cloudPreflight(env);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/STRIPE_WEBHOOK_SECRET/);
  });

  it("fails when the billing base URL is missing", () => {
    const env = { ...PASSING };
    delete env.BILLING_PUBLIC_BASE_URL;
    const r = cloudPreflight(env);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/BILLING_PUBLIC_BASE_URL/);
  });

  it("fails a relative billing base URL, not just a missing one", () => {
    // The exact shape of the original bug: present, non-empty, and useless.
    const r = cloudPreflight({ ...PASSING, BILLING_PUBLIC_BASE_URL: "/billing" });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/BILLING_PUBLIC_BASE_URL/);
  });

  it("fails a plain-http billing base URL", () => {
    const r = cloudPreflight({ ...PASSING, BILLING_PUBLIC_BASE_URL: "http://app.example" });
    expect(r.ok).toBe(false);
  });

  it("does not require the Stripe companions when billing is switched off", () => {
    // A self-hoster with no Stripe at all is a legitimate configuration.
    const env = { ...PASSING };
    delete env.STRIPE_SECRET_KEY;
    delete env.STRIPE_PRO_PRICE_ID;
    delete env.STRIPE_WEBHOOK_SECRET;
    delete env.BILLING_PUBLIC_BASE_URL;
    const r = cloudPreflight(env);
    expect(r.ok, r.errors.join("\n")).toBe(true);
  });
});
