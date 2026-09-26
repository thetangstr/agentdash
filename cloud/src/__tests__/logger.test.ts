import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createLogger, hashEmail, redact, redactString } from "../logger.js";
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

  // GH #778
  describe("hardening", () => {
    const RAILWAY_UUID = "7d3e5c1a-9b2f-4e8d-a6c4-0f1e2d3c4b5a";
    const BOX_ID = "11111111-2222-4333-8444-555555555555";

    it("redacts a bare UUID token in token context, in messages, fields and Error text", () => {
      const { log, text } = capture();
      const err = new Error(`Railway API refused token ${RAILWAY_UUID}: Not Authorized`);
      log.error(`railway call failed with RAILWAY_API_TOKEN=${RAILWAY_UUID}`, {
        err,
        note: `{"token":"${RAILWAY_UUID}"}`,
        also: `project token: ${RAILWAY_UUID}`,
        header: `Authorization: ${RAILWAY_UUID}`,
      });
      const out = text();
      expect(out).not.toContain(RAILWAY_UUID);
      expect(out).toContain("Not Authorized");
      expect(out).toContain("[REDACTED]");
    });

    it("keeps a UUID that is not next to a token word (box and job ids)", () => {
      expect(redactString(`box ${BOX_ID} moved to provisioning`)).toBe(`box ${BOX_ID} moved to provisioning`);
      expect(redactString(`job ${BOX_ID} step 3`)).toContain(BOX_ID);
    });

    it("redacts Basic credentials and full Bearer values up to whitespace", () => {
      const basic = Buffer.from("admin:hunter2-fake").toString("base64");
      const odd = "abc$def!ghi@jkl#mno%pqr^stu&vwx*yz(0)1";
      const out = redactString(`Authorization: Basic ${basic} then Bearer ${odd} end; bearer ${RAILWAY_UUID}`);
      expect(out).not.toContain(basic);
      expect(out).not.toContain("hunter2");
      for (const piece of ["abc", "def", "jkl", "yz(0)1"]) expect(out).not.toContain(piece);
      expect(out).not.toContain(RAILWAY_UUID);
      expect(out).toBe("Authorization: Basic [REDACTED] then Bearer [REDACTED] end; bearer [REDACTED]");
    });

    it("hashes email addresses so lines still correlate without printing them", () => {
      const { log, text } = capture();
      log.info("signup from Founder@Example.com", { email: "founder@example.com", note: "cc ops+alerts@agentdash.cloud" });
      const out = text();
      expect(out).not.toMatch(/founder@example\.com/i);
      expect(out).not.toContain("ops+alerts@agentdash.cloud");
      expect(out).toContain(hashEmail("founder@example.com"));
      // Case-insensitive: the same person hashes the same.
      expect(hashEmail("Founder@Example.com")).toBe(hashEmail("founder@example.com"));
      expect(hashEmail("founder@example.com")).toMatch(/^\[email:[0-9a-f]{12}\]$/);
    });

    it("does not mistake versions, scoped packages or URL credentials for emails", () => {
      expect(redactString("pnpm@9.15.4 and node_modules/@agentdash/cloud-control")).toBe(
        "pnpm@9.15.4 and node_modules/@agentdash/cloud-control",
      );
      expect(redactString("postgresql://postgres:pw-fake@postgres.railway.internal:5432/railway")).toBe(
        "postgresql://postgres:[REDACTED]@postgres.railway.internal:5432/railway",
      );
    });
  });
});
