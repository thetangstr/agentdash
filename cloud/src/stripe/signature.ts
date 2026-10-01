// AgentDash (SC-8, GH #769): Stripe's webhook signature scheme, both ways.
//
//   Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=…]
//
// verifyStripeSignature checks what Stripe sent to the account endpoint (the
// same rules as stripe-node's constructEvent: the exact raw bytes, any v1
// entry may match, compared in constant time, and a timestamp at most
// `toleranceSec` old). signStripePayload produces the header a box's own,
// unmodified constructEvent accepts for its own STRIPE_WEBHOOK_SECRET. The
// tests check both against the stripe package itself.
import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_TOLERANCE_SEC = 300;

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSignatureError";
  }
}

function hmacHex(secret: string, timestamp: number, payload: Buffer): string {
  return createHmac("sha256", secret).update(`${timestamp}.`, "utf8").update(payload).digest("hex");
}

export function parseSignatureHeader(header: string): { timestamp: number; v1: string[] } {
  let timestamp = NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  return { timestamp, v1 };
}

/**
 * Throws StripeSignatureError unless one of the header's v1 signatures is an
 * HMAC of the raw body under one of `secrets` (several during an endpoint
 * secret roll) and its timestamp is within the tolerance.
 */
export function verifyStripeSignature(
  payload: Buffer,
  header: string | undefined,
  secrets: string[],
  opts: { toleranceSec?: number; nowSec?: number } = {},
): { timestamp: number } {
  if (!header) throw new StripeSignatureError("missing Stripe-Signature header");
  const usable = secrets.map((s) => s.trim()).filter(Boolean);
  if (!usable.length) throw new StripeSignatureError("no webhook secret configured");
  const { timestamp, v1 } = parseSignatureHeader(header);
  if (!Number.isFinite(timestamp)) throw new StripeSignatureError("Stripe-Signature has no timestamp");
  if (!v1.length) throw new StripeSignatureError("Stripe-Signature has no v1 signature");
  let ok = false;
  for (const secret of usable) {
    const expected = Buffer.from(hmacHex(secret, timestamp, payload), "hex");
    for (const sig of v1) {
      // Every pair is compared, so timing does not reveal which one matched.
      ok = timingSafeEqual(expected, Buffer.from(sig, "hex")) || ok;
    }
  }
  if (!ok) throw new StripeSignatureError("no signature matches the payload");
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) {
    throw new StripeSignatureError("timestamp outside the tolerance window");
  }
  return { timestamp };
}

/** A Stripe-format signature header over the raw body for one secret, at `timestampSec` (now by default). */
export function signStripePayload(payload: Buffer, secret: string, timestampSec: number = Math.floor(Date.now() / 1000)): string {
  if (!secret.trim()) throw new Error("cannot sign with an empty webhook secret");
  return `t=${timestampSec},v1=${hmacHex(secret, timestampSec, payload)}`;
}
