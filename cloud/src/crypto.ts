// AgentDash: AES-256-GCM for the control plane's `*_enc` columns, keyed by
// CLOUD_DATA_KEY (32 bytes, base64 or hex). Format: `v1.<iv>.<tag>.<ciphertext>`
// (base64url). The caller passes an AAD naming the column (e.g.
// "boxes.claim_code_enc") so a ciphertext cannot be moved to another column.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Secret } from "./secret.js";

const VERSION = "v1";

export function parseDataKey(raw: string): Secret {
  const trimmed = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) key = Buffer.from(trimmed, "hex");
  else {
    const b = Buffer.from(trimmed, "base64");
    if (b.length === 32) key = b;
  }
  if (!key || key.length !== 32) {
    throw new Error("CLOUD_DATA_KEY must be 32 bytes, as 64 hex characters or base64");
  }
  return new Secret(key.toString("hex"));
}

function keyBytes(key: Secret): Buffer {
  return Buffer.from(key.reveal(), "hex");
}

export function encryptField(key: Secret, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptField(key: Secret, stored: string, aad: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("unrecognised encrypted field format");
  const [, iv, tag, ct] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/** SHA-256 hex, for `*_hash` columns (claim codes, email tokens, invite codes). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time string comparison via fixed-length digests. */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}
