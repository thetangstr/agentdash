// AgentDash: AES-256-GCM for the control plane's `*_enc` columns, keyed by
// CLOUD_DATA_KEY (32 bytes, base64 or hex). The caller passes an AAD naming
// the column (e.g. "boxes.claim_code_enc") so a ciphertext cannot be moved to
// another column.
//
// Formats (base64url parts):
//   v2.<kid>.<iv>.<tag>.<ciphertext>   written now; <kid> names the key
//   v1.<iv>.<tag>.<ciphertext>         SC-1 rows, no key id; still readable
//
// Rotation (GH #778): encrypt always uses the CURRENT key. Decrypt looks the
// key up by id in a keyring of the current key plus CLOUD_DATA_KEYS_PREVIOUS,
// so old rows stay readable until they are re-encrypted. The key id is a
// truncated SHA-256 of a domain-separated key hash: it identifies a key
// without revealing anything usable about it.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";
import { Secret } from "./secret.js";

const V1 = "v1";
const V2 = "v2";

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

/** A stable, non-secret identifier for a data key (16 hex characters). */
export function dataKeyId(key: Secret): string {
  return createHash("sha256").update("agentdash-cloud-data-key-id:").update(keyBytes(key)).digest("hex").slice(0, 16);
}

/** The current key (encrypts) plus previous keys (decrypt only). */
export class DataKeyring {
  readonly current: Secret;
  readonly currentId: string;
  readonly #byId = new Map<string, Secret>();

  constructor(current: Secret, previous: Secret[] = []) {
    this.current = current;
    this.currentId = dataKeyId(current);
    for (const k of [current, ...previous]) {
      const id = dataKeyId(k);
      if (!this.#byId.has(id)) this.#byId.set(id, k);
    }
  }

  get(id: string): Secret | undefined {
    return this.#byId.get(id);
  }

  all(): Secret[] {
    return [...this.#byId.values()];
  }

  get size(): number {
    return this.#byId.size;
  }

  toJSON(): string {
    return `[DataKeyring ${this.#byId.size} key(s)]`;
  }

  [inspect.custom](): string {
    return this.toJSON();
  }
}

/** Parse CLOUD_DATA_KEY plus an optional comma-separated CLOUD_DATA_KEYS_PREVIOUS. */
export function parseKeyring(current: string, previous?: string): DataKeyring {
  const prev = (previous ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return parseDataKey(s);
      } catch {
        throw new Error("CLOUD_DATA_KEYS_PREVIOUS: every entry must be 32 bytes, as 64 hex characters or base64");
      }
    });
  return new DataKeyring(parseDataKey(current), prev);
}

function asKeyring(key: Secret | DataKeyring): DataKeyring {
  return key instanceof DataKeyring ? key : new DataKeyring(key);
}

function gcmDecrypt(key: Secret, iv: string, tag: string, ct: string, aad: string): string {
  const tagBytes = Buffer.from(tag, "base64url");
  // A full 16-byte tag only: a truncated tag would weaken authentication.
  if (tagBytes.length !== 16) throw new Error("encrypted field has a malformed authentication tag");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), Buffer.from(iv, "base64url"), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function encryptField(key: Secret | DataKeyring, plaintext: string, aad: string): string {
  const ring = asKeyring(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(ring.current), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [V2, ring.currentId, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptField(key: Secret | DataKeyring, stored: string, aad: string): string {
  const ring = asKeyring(key);
  const parts = stored.split(".");
  if (parts.length === 5 && parts[0] === V2) {
    const [, kid, iv, tag, ct] = parts as [string, string, string, string, string];
    const k = ring.get(kid);
    if (!k) throw new Error("encrypted field uses a key that is not in the keyring");
    return gcmDecrypt(k, iv, tag, ct, aad);
  }
  if (parts.length === 4 && parts[0] === V1) {
    // No key id: try each key; GCM authentication rejects the wrong ones.
    const [, iv, tag, ct] = parts as [string, string, string, string];
    for (const k of ring.all()) {
      try {
        return gcmDecrypt(k, iv, tag, ct, aad);
      } catch {
        // next key
      }
    }
    throw new Error("encrypted field did not authenticate under any key in the keyring");
  }
  throw new Error("unrecognised encrypted field format");
}

/** True when a stored value is not under the current key (a rotation job should re-encrypt it). */
export function needsReencrypt(key: DataKeyring, stored: string): boolean {
  const parts = stored.split(".");
  return !(parts.length === 5 && parts[0] === V2 && parts[1] === key.currentId);
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
