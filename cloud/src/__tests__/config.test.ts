import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { checkAdminTokenStrength, ConfigError, DEFAULT_PRIVATE_NETWORK_CIDRS, loadConfig, parseAllowList } from "../config.js";
import { createCipheriv, randomBytes } from "node:crypto";
import { checkControlUrl, runAdmin } from "../admin/run.js";
import { constantTimeEqual, DataKeyring, dataKeyId, decryptField, encryptField, needsReencrypt, parseDataKey, parseKeyring } from "../crypto.js";
import { createLogger } from "../logger.js";

const KEY_HEX = "11".repeat(32);
const base = {
  DATABASE_URL: "postgres://u:dbpass-fake@localhost:5432/cloud",
  CLOUD_DATA_KEY: KEY_HEX,
  CLOUD_ADMIN_TOKEN: "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e",
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

// ---- GH #778 ---------------------------------------------------------------

describe("admin token strength", () => {
  it("accepts CSPRNG output in hex, base64 and base64url", () => {
    expect(checkAdminTokenStrength("9f2c4e7a1b3d5f60718293a4b5c6d7e8")).toBeNull(); // 32 hex = 128 bits
    expect(checkAdminTokenStrength(base.CLOUD_ADMIN_TOKEN)).toBeNull();
    expect(checkAdminTokenStrength("q3Zk8Xw1+Lm9/Tp2Rs5Vb7Nc0Hj4Yd6Fg8Ae1Uo3Ki=")).toBeNull();
    expect(checkAdminTokenStrength("q3Zk8Xw1-Lm9_Tp2Rs5Vb7Nc0Hj4Yd6Fg8Ae1Uo3Ki")).toBeNull();
    for (let i = 0; i < 200; i++) {
      expect(checkAdminTokenStrength(randomBytes(32).toString("hex"))).toBeNull();
      expect(checkAdminTokenStrength(randomBytes(32).toString("base64url"))).toBeNull();
    }
  });

  it("refuses short, padded, repetitive, passphrase-like and low-alphabet values", () => {
    expect(checkAdminTokenStrength("short")).toMatch(/32 characters/);
    expect(checkAdminTokenStrength("a".repeat(40))).toMatch(/distinct/);
    expect(checkAdminTokenStrength("test-admin-bearer-".padEnd(48, "x"))).toMatch(/repeats/);
    expect(checkAdminTokenStrength("correct horse battery staple extra words")).toMatch(/hex, base64/);
    expect(checkAdminTokenStrength("0101010101010101010101010101010101")).toMatch(/distinct/);
    expect(checkAdminTokenStrength("abcdefabcdefabcdefabcdefabcdef12")).toMatch(/distinct/);
    expect(() => loadConfig({ ...base, CLOUD_ADMIN_TOKEN: "a".repeat(40) })).toThrow(/openssl rand -hex 32/);
  });
});

describe("private network and brute-force settings", () => {
  it("defaults to the private ranges, accepts a custom list, and 'none' turns the check off", () => {
    const d = loadConfig(base);
    expect(DEFAULT_PRIVATE_NETWORK_CIDRS).toContain("fc00::/7");
    expect(d.privateNetwork?.check("fd12:3456::1", "ipv6")).toBe(true);
    expect(d.privateNetwork?.check("10.1.2.3", "ipv4")).toBe(true);
    // Measured on Railway (GH #763): siblings on the private network.
    expect(d.privateNetwork?.check("10.204.184.232", "ipv4")).toBe(true);
    expect(d.privateNetwork?.check("fd12:bc61:cdb6:1:2000:92:eecc:b8e8", "ipv6")).toBe(true);
    // Railway's public edge connects from 100.64.0.0/10; it must not count as private.
    expect(d.privateNetwork?.check("100.64.0.3", "ipv4")).toBe(false);
    expect(d.privateNetwork?.check("100.64.0.9", "ipv4")).toBe(false);
    expect(d.privateNetwork?.check("203.0.113.7", "ipv4")).toBe(false);
    expect(d.privateNetwork?.check("127.0.0.1", "ipv4")).toBe(false);
    expect(d.adminMaxFailures).toBe(5);
    expect(d.adminLockoutMs).toBe(900_000);
    const c = loadConfig({ ...base, CLOUD_PRIVATE_NETWORK_CIDRS: "fd00::/8", CLOUD_ADMIN_MAX_FAILURES: "3", CLOUD_ADMIN_LOCKOUT_SECONDS: "60" });
    expect(c.privateNetwork?.check("10.1.2.3", "ipv4")).toBe(false);
    expect(c.adminMaxFailures).toBe(3);
    expect(c.adminLockoutMs).toBe(60_000);
    expect(loadConfig({ ...base, CLOUD_PRIVATE_NETWORK_CIDRS: "none" }).privateNetwork).toBeNull();
    expect(() => loadConfig({ ...base, CLOUD_PRIVATE_NETWORK_CIDRS: "" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CLOUD_PRIVATE_NETWORK_CIDRS: "nope" })).toThrow(/CLOUD_PRIVATE_NETWORK_CIDRS/);
    expect(() => loadConfig({ ...base, CLOUD_ADMIN_MAX_FAILURES: "0" })).toThrow(/positive integer/);
  });
});

describe("data key rotation", () => {
  const oldKey = parseDataKey("44".repeat(32));
  const newKey = parseDataKey("55".repeat(32));

  it("writes v2 with the current key's id, and the id reveals nothing of the key", () => {
    const ring = new DataKeyring(newKey);
    const enc = encryptField(ring, "AGD-rotate", "boxes.claim_code_enc");
    const parts = enc.split(".");
    expect(parts[0]).toBe("v2");
    expect(parts[1]).toBe(dataKeyId(newKey));
    expect(parts[1]).toMatch(/^[0-9a-f]{16}$/);
    expect(newKey.reveal()).not.toContain(parts[1]!);
    expect(needsReencrypt(ring, enc)).toBe(false);
  });

  it("decrypts rows under a previous key after rotation, by key id", () => {
    const before = encryptField(new DataKeyring(oldKey), "AGD-before", "boxes.claim_code_enc");
    const rotated = parseKeyring("55".repeat(32), `${"44".repeat(32)}, ${Buffer.alloc(32, 9).toString("base64")}`);
    expect(rotated.size).toBe(3);
    expect(decryptField(rotated, before, "boxes.claim_code_enc")).toBe("AGD-before");
    expect(needsReencrypt(rotated, before)).toBe(true);
    const after = encryptField(rotated, "AGD-after", "boxes.claim_code_enc");
    expect(after.split(".")[1]).toBe(dataKeyId(newKey));
    // Once the old key is dropped, its rows fail loudly instead of silently.
    expect(() => decryptField(new DataKeyring(newKey), before, "boxes.claim_code_enc")).toThrow(/not in the keyring/);
    // AAD binding still holds under rotation.
    expect(() => decryptField(rotated, before, "boxes.edge_secret_enc")).toThrow();
  });

  it("still reads SC-1 v1 rows (no key id) with any key in the ring", () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(oldKey.reveal(), "hex"), iv);
    cipher.setAAD(Buffer.from("boxes.claim_code_enc"));
    const ct = Buffer.concat([cipher.update("AGD-legacy", "utf8"), cipher.final()]);
    const v1 = ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
    const ring = new DataKeyring(newKey, [oldKey]);
    expect(decryptField(ring, v1, "boxes.claim_code_enc")).toBe("AGD-legacy");
    expect(needsReencrypt(ring, v1)).toBe(true);
    expect(() => decryptField(new DataKeyring(newKey), v1, "boxes.claim_code_enc")).toThrow(/any key/);
  });

  it("loads CLOUD_DATA_KEYS_PREVIOUS from env and never prints the keys", () => {
    const c = loadConfig({ ...base, CLOUD_DATA_KEYS_PREVIOUS: "44".repeat(32) });
    expect(c.dataKeys.size).toBe(2);
    const dumped = JSON.stringify(c) + inspect(c, { depth: 6 });
    expect(dumped).not.toContain("44".repeat(32));
    expect(dumped).not.toContain(KEY_HEX);
    expect(() => loadConfig({ ...base, CLOUD_DATA_KEYS_PREVIOUS: "short" })).toThrow(/CLOUD_DATA_KEYS_PREVIOUS/);
  });
});

describe("admin CLI transport", () => {
  it("allows https anywhere and plain http only to this machine", () => {
    for (const ok of ["https://cloud-control.up.railway.app", "http://localhost:3200", "http://127.0.0.1:3200", "http://127.8.9.10", "http://[::1]:3200"]) {
      expect(checkControlUrl(ok)).toBeNull();
    }
    for (const bad of ["http://cloud-control.up.railway.app", "http://10.0.0.5:3200", "http://localhost.evil.example", "http://[fd12::1]:3200", "ftp://localhost", "not a url", "https://u:p@host.example"]) {
      expect(checkControlUrl(bad)).not.toBeNull();
    }
  });

  it("refuses to send the bearer over http to a remote host, before any request", async () => {
    let calls = 0;
    const err: string[] = [];
    const code = await runAdmin(["settings", "get"], { CLOUD_CONTROL_URL: "http://cloud.example.com", CLOUD_ADMIN_TOKEN: base.CLOUD_ADMIN_TOKEN }, {
      out: () => {},
      err: (l) => err.push(l),
      fetch: (() => {
        calls += 1;
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    expect(code).toBe(2);
    expect(calls).toBe(0);
    expect(err.join("")).toMatch(/plain http/);
    expect(err.join("")).not.toContain(base.CLOUD_ADMIN_TOKEN);
  });
});

describe("GCM tag length", () => {
  it("refuses a truncated authentication tag", () => {
    const key = parseDataKey(KEY_HEX);
    const parts = encryptField(key, "AGD-tag", "a").split(".");
    parts[3] = Buffer.from(parts[3]!, "base64url").subarray(0, 4).toString("base64url");
    expect(() => decryptField(key, parts.join("."), "a")).toThrow(/authentication tag/);
  });
});
