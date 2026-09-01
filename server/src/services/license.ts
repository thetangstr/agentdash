// AgentDash (On-prem SKU, G2): license verification.
//
// Self-hosted installs are gated by a signed license key. We sign licenses with
// an ed25519 private key (held by AgentDash); each install verifies with the
// embedded/configured public key — so a customer cannot forge or extend a
// license. Dependency-free (Node's crypto supports ed25519).
//
// Token format: `<base64url(payloadJSON)>.<base64url(ed25519 signature)>`
// where the signature is over the base64url payload string bytes.

import crypto from "node:crypto";

export type DeploymentKind = "cloud" | "on_prem";

/** Which SKU this process is running as. Defaults to "cloud". */
export function deploymentKind(): DeploymentKind {
  return (process.env.AGENTDASH_DEPLOYMENT_KIND ?? "cloud").trim() === "on_prem"
    ? "on_prem"
    : "cloud";
}

/**
 * Inference markup applies only to the managed Cloud SKU. On-prem customers
 * bring their own tokens, so their usage is never marked up (G2/G4).
 */
export function inferenceMarkupEnabled(): boolean {
  return deploymentKind() === "cloud";
}

export interface LicenseClaims {
  customer: string;
  plan?: string;
  seats?: number;
  /** Expiry as unix seconds. Absent = perpetual. */
  exp?: number;
}

export interface LicenseStatus {
  valid: boolean;
  reason?:
    | "no_license"
    | "no_public_key"
    | "malformed"
    | "malformed_payload"
    | "bad_key_or_signature"
    | "bad_signature"
    | "expired";
  claims?: LicenseClaims;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verify a signed license token against an ed25519 public key (SPKI PEM).
 * `now` is injectable for testing.
 */
export function verifyLicense(
  token: string | undefined,
  publicKeyPem: string | undefined,
  now: number = Date.now(),
): LicenseStatus {
  if (!token || !token.trim()) return { valid: false, reason: "no_license" };
  if (!publicKeyPem || !publicKeyPem.trim()) return { valid: false, reason: "no_public_key" };

  const parts = token.trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: "malformed" };
  }
  const [payloadB64, sigB64] = parts;

  let claims: LicenseClaims;
  try {
    claims = JSON.parse(b64urlToBuf(payloadB64).toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed_payload" };
  }

  let ok = false;
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    ok = crypto.verify(null, Buffer.from(payloadB64), key, b64urlToBuf(sigB64));
  } catch {
    return { valid: false, reason: "bad_key_or_signature" };
  }
  if (!ok) return { valid: false, reason: "bad_signature" };

  if (claims.exp != null && now > claims.exp * 1000) {
    return { valid: false, reason: "expired", claims };
  }
  return { valid: true, claims };
}

/**
 * An SPKI PEM is multi-line, and an env file is not.
 *
 * Both documented ways of carrying the public key were broken. Writing the PEM
 * across real lines in `agentdash.env` breaks the moment anything sources that
 * file (`command not found: PUBLIC`), and the single-line `\n`-escaped form our
 * own template ships went straight to `crypto.createPublicKey`, which wants
 * real newlines and rejects the literal backslash-n. So an operator following
 * either documented format got `no_public_key` or `bad_key_or_signature` on
 * every gated route, with nothing pointing at the escaping as the cause.
 *
 * Accept the escaped form and restore the newlines. A PEM never legitimately
 * contains a backslash, so this cannot corrupt a well-formed key.
 */
export function normalizePublicKeyPem(pem: string | undefined): string | undefined {
  if (!pem) return pem;
  return pem.includes("\\n") ? pem.replace(/\\r\\n|\\n/g, "\n") : pem;
}

/** Verify the license configured via env (AGENTDASH_LICENSE_KEY + _PUBLIC_KEY). */
export function licenseStatusFromEnv(now: number = Date.now()): LicenseStatus {
  return verifyLicense(
    process.env.AGENTDASH_LICENSE_KEY,
    normalizePublicKeyPem(process.env.AGENTDASH_LICENSE_PUBLIC_KEY),
    now,
  );
}
