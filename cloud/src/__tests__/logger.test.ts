import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createLogger, redact, redactString } from "../logger.js";
import { Secret } from "../secret.js";

// Synthetic values in every shape the spec names (§3.3). None is a real credential.
const VALUES = {
  claim: "AGD-0123456789abcdef0123456789",
  stripeSecret: "sk_live_51FakeFakeFakeFakeFake",
  stripeRestricted: "rk_live_51FakeRestrictedKey",
  resend: "re_FakeResendKey_123456",
  webhook: "whsec_FakeWebhookSecret987",
  railway: "3f0c9a7e-railway-token-fake-0000",
  password: "correct-horse-battery-staple",
  admin: "admin-bearer-value-that-is-long-enough-000",
};

function capture() {
  const lines: string[] = [];
  const log = createLogger({ write: (l) => lines.push(l), level: "debug" });
  return { log, text: () => lines.join("\n") };
}

describe("redacting logger", () => {
  it("redacts by key: *SECRET*, *KEY*, *TOKEN*, *CODE*, password", () => {
    const { log, text } = capture();
    log.info("config", {
      STRIPE_WEBHOOK_SECRET: "plain-secret-value-1",
      CLOUD_DATA_KEY: "plain-key-value-2",
      railwayToken: VALUES.railway,
      invite_code: "plain-code-value-3",
      password: VALUES.password,
      nested: { apiKey: "plain-key-value-4", list: [{ claimCode: "plain-code-value-5" }] },
    });
    const out = text();
    for (const v of ["plain-secret-value-1", "plain-key-value-2", VALUES.railway, "plain-code-value-3", VALUES.password, "plain-key-value-4", "plain-code-value-5"]) {
      expect(out).not.toContain(v);
    }
    expect(out).toContain("[REDACTED]");
  });

  it("redacts by value pattern inside free-text strings and messages", () => {
    const { log, text } = capture();
    log.error(`claim ${VALUES.claim} failed`, {
      note: `keys ${VALUES.stripeSecret} and ${VALUES.stripeRestricted}; resend=${VALUES.resend}; hook:${VALUES.webhook}`,
      items: [VALUES.claim, `Authorization: Bearer ${VALUES.admin}`],
      url: `postgresql://postgres:${VALUES.password}@postgres.railway.internal:5432/railway`,
    });
    const out = text();
    for (const v of Object.values(VALUES)) expect(out).not.toContain(v);
    expect(out).toContain("AGD-[REDACTED]");
    expect(out).toContain("postgres.railway.internal");
  });

  it("scrubs Error messages and stacks", () => {
    const { log, text } = capture();
    log.error("boom", { err: new Error(`variableUpsert failed for ${VALUES.webhook}`) });
    expect(text()).not.toContain(VALUES.webhook);
    expect(text()).toContain("variableUpsert failed");
  });

  it("never prints a Secret, however it is serialised", () => {
    const s = new Secret(VALUES.railway);
    const { log, text } = capture();
    log.info("wrapped", { holder: { value: s }, s });
    expect(text()).not.toContain(VALUES.railway);
    expect(String(s)).toBe("[REDACTED]");
    expect(JSON.stringify({ s })).not.toContain(VALUES.railway);
    expect(inspect({ s })).not.toContain(VALUES.railway);
    expect(s.reveal()).toBe(VALUES.railway);
  });

  it("leaves ordinary text alone and handles cycles", () => {
    expect(redactString("provisioning box acme: step 3 of 9")).toBe("provisioning box acme: step 3 of 9");
    const a: Record<string, unknown> = { slug: "acme" };
    a.self = a;
    expect(redact(a)).toEqual({ slug: "acme", self: "[Circular]" });
  });

  it("respects the level threshold", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), level: "warn" });
    log.info("quiet");
    log.warn("loud");
    expect(lines).toHaveLength(1);
  });
});
