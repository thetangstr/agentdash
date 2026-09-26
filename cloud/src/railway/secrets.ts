// AgentDash: the box secrets the provisioner generates (spec §3.3 "Secret
// rules", lib.sh). All come from crypto.randomBytes and live in memory; the
// escrow seals the master key to an OFFLINE public key (libsodium sealed box),
// so the control plane can escrow it but never decrypt it.
import { createHash, randomBytes } from "node:crypto";
import sodium from "libsodium-wrappers";

/** lib.sh write_random_hex 32: 64 hex characters. */
export function newAuthSecret(): string {
  return randomBytes(32).toString("hex");
}

/** lib.sh write_random_b64 32: 32 random bytes, base64. */
export function newMasterKey(): string {
  return randomBytes(32).toString("base64");
}

/** lib.sh write_invite_code: "AGD-" plus 26 uppercase hex (13 bytes, about 100 bits). */
export function newClaimCode(): string {
  return `AGD-${randomBytes(13).toString("hex").toUpperCase()}`;
}

/** The per-box secret the edge router sends in X-AgentDash-Edge (spec §4.4). */
export function newEdgeSecret(): string {
  return randomBytes(32).toString("hex");
}

/** A Postgres password: 32 alphanumerics (no URL escaping needed in DATABASE_URL). */
export function newPostgresPassword(): string {
  let out = "";
  while (out.length < 32) out += randomBytes(48).toString("base64").replace(/[^A-Za-z0-9]/g, "");
  return out.slice(0, 32);
}

export function parseEscrowPublicKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  const bytes = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (bytes.length !== 32) throw new Error("CLOUD_ESCROW_PUBLIC_KEY must be a 32-byte X25519 public key (base64 or hex)");
  return new Uint8Array(bytes);
}

/**
 * A stable, non-secret id for an escrow public key (16 hex characters), so a
 * sealed blob names the key that opens it and the escrow key can be rotated:
 * old blobs keep naming the old key (GH #800 review).
 */
export function escrowKeyId(publicKey: Uint8Array): string {
  return createHash("sha256").update("agentdash-escrow-key-id:").update(publicKey).digest("hex").slice(0, 16);
}

const ESCROW_FORMAT = "e1";

/** Seal to the escrow public key. Format: `e1.<key id>.<base64 sealed box>`. */
export async function sealToEscrow(publicKey: Uint8Array, plaintext: string): Promise<string> {
  await sodium.ready;
  const sealed = Buffer.from(sodium.crypto_box_seal(plaintext, publicKey)).toString("base64");
  return `${ESCROW_FORMAT}.${escrowKeyId(publicKey)}.${sealed}`;
}

export function escrowBlobKeyId(blob: string): string | null {
  const parts = blob.trim().split(".");
  return parts.length === 3 && parts[0] === ESCROW_FORMAT ? parts[1]! : null;
}

/** Open a sealed blob with the OFFLINE key pair (used only by the recovery tool, never by the control plane). */
export async function openEscrow(publicKey: Uint8Array, secretKey: Uint8Array, blob: string): Promise<string> {
  await sodium.ready;
  const parts = blob.trim().split(".");
  if (parts.length !== 3 || parts[0] !== ESCROW_FORMAT) throw new Error("not an escrow blob (expected e1.<key id>.<ciphertext>)");
  if (parts[1] !== escrowKeyId(publicKey)) {
    throw new Error(`this blob was sealed to escrow key ${parts[1]}, not ${escrowKeyId(publicKey)}; use that key`);
  }
  return sodium.to_string(sodium.crypto_box_seal_open(Buffer.from(parts[2]!, "base64"), publicKey, secretKey));
}
