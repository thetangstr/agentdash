import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseAllowList } from "../config.js";
import { constantTimeEqual, decryptField, encryptField, parseDataKey } from "../crypto.js";
import { createLogger } from "../logger.js";

const KEY_HEX = "11".repeat(32);
const base = {
  DATABASE_URL: "postgres://u:dbpass-fake@localhost:5432/cloud",
  CLOUD_DATA_KEY: KEY_HEX,
  CLOUD_ADMIN_TOKEN: "a".repeat(40),
  RAILWAY_API_TOKEN: "railway-workspace-token-fake-123",
};

describe("config", () => {
  it("loads from env and wraps every credential", () => {
    const c = loadConfig({ ...base, CLOUD_ADMIN_ALLOWED_IPS: "10.0.0.0/8, 203.0.113.7, fd00::/8" });
    expect(c.port).toBe(3200);
    expect(c.adminAllowListSize).toBe(3);
    expect(c.railwayToken?.reveal()).toBe(base.RAILWAY_API_TOKEN);
    const dumped = JSON.stringify(c) + inspect(c, { depth: 5 });
    for (const v of [base.RAILWAY_API_TOKEN, base.CLOUD_ADMIN_TOKEN, "dbpass-fake", KEY_HEX]) {
      expect(dumped).not.toContain(v);
    }
    const lines: string[] = [];
    createLogger({ write: (l) => lines.push(l) }).info("config", { config: c as unknown as Record<string, unknown> });
    expect(lines.join("")).not.toContain(base.RAILWAY_API_TOKEN);
  });

  it("refuses missing or weak settings", () => {
    expect(() => loadConfig({ ...base, CLOUD_ADMIN_TOKEN: "" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CLOUD_ADMIN_TOKEN: "short" })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...base, CLOUD_DATA_KEY: "abc" })).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, CLOUD_CLIENT_IP_SOURCE: "x-forwarded-for" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, RAILWAY_API_TOKEN: undefined }).railwayToken).toBeNull();
  });

  it("parses the allow-list and treats empty as nobody", () => {
    const { list, size } = parseAllowList("192.168.1.0/24,::1");
    expect(size).toBe(2);
    expect(list.check("192.168.1.9", "ipv4")).toBe(true);
    expect(list.check("192.168.2.9", "ipv4")).toBe(false);
    expect(list.check("::1", "ipv6")).toBe(true);
    expect(parseAllowList("").size).toBe(0);
    expect(() => parseAllowList("not-an-ip")).toThrow(ConfigError);
    expect(() => parseAllowList("10.0.0.0/40")).toThrow(ConfigError);
  });
});

describe("field encryption", () => {
  const key = parseDataKey(KEY_HEX);
  it("round-trips and binds the column", () => {
    const enc = encryptField(key, "AGD-feedface", "boxes.claim_code_enc");
    expect(enc).not.toContain("feedface");
    expect(decryptField(key, enc, "boxes.claim_code_enc")).toBe("AGD-feedface");
    expect(() => decryptField(key, enc, "boxes.edge_secret_enc")).toThrow();
    expect(() => decryptField(parseDataKey("22".repeat(32)), enc, "boxes.claim_code_enc")).toThrow();
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptField(key, parts.join("."), "boxes.claim_code_enc")).toThrow();
  });
  it("uses a fresh IV each time and accepts base64 keys", () => {
    expect(encryptField(key, "x", "a")).not.toBe(encryptField(key, "x", "a"));
    const b64 = parseDataKey(Buffer.alloc(32, 7).toString("base64"));
    expect(decryptField(b64, encryptField(b64, "y", "a"), "a")).toBe("y");
  });
  it("compares in constant time", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
