// AgentDash: the box secrets the provisioner generates (spec §3.3 "Secret
// rules", lib.sh). All come from crypto.randomBytes and live in memory; the
// escrow seals the master key to an OFFLINE public key (libsodium sealed box),
// so the control plane can escrow it but never decrypt it.
import { randomBytes } from "node:crypto";
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

/** Seal the master key to the escrow public key; returns base64 ciphertext. */
export async function sealToEscrow(publicKey: Uint8Array, plaintext: string): Promise<string> {
  await sodium.ready;
  return Buffer.from(sodium.crypto_box_seal(plaintext, publicKey)).toString("base64");
}
