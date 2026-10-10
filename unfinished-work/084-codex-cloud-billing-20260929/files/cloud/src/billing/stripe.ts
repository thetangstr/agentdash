// AgentDash (SC-8): Stripe's wire signature, on the original Buffer. No SDK dependency.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Secret } from "../secret.js";

export const STRIPE_EVENTS = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.trial_will_end", "invoice.payment_failed"] as const;
/** Mirrors the box entitlement-sync policy: past_due never grants active Pro. */
export function subscriptionPlanTier(status: string): string {
  const tiers: Record<string, string> = { trialing: "pro_trial", active: "pro_active", past_due: "pro_past_due", unpaid: "pro_canceled", canceled: "pro_canceled", incomplete: "free", incomplete_expired: "free" };
  return tiers[status] ?? "free";
}
export function stripeSignature(raw: Buffer, secret: Secret, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret.reveal()).update(`${timestamp}.`).update(raw).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: Secret, now = Math.floor(Date.now() / 1000)): boolean {
  if (!header || header.length > 4096) return false;
  const parts = header.split(",").map((part) => part.trim());
  const times = parts.filter((p) => p.startsWith("t="));
  if (times.length !== 1 || !/^t=\d{1,12}$/.test(times[0])) return false;
  const time = Number(times[0].slice(2));
  if (!Number.isSafeInteger(time) || Math.abs(now - time) > 300) return false;
  const expected = Buffer.from(stripeSignature(raw, secret, time).split("v1=")[1], "hex");
  return parts.some((p) => /^v1=[a-f0-9]{64}$/i.test(p) && timingSafeEqual(expected, Buffer.from(p.slice(3), "hex")));
}

/** Provider errors may echo credentials or event bodies: discard their text entirely. */
export async function stripeRequest<T>(key: Secret, path: string, opts: { fetch?: typeof fetch; method?: string; body?: URLSearchParams; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
  try {
    const response = await (opts.fetch ?? fetch)(`https://api.stripe.com/v1/${path}`, {
      method: opts.method ?? "GET", redirect: "error", signal: opts.signal ?? AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${key.reveal()}`, ...(opts.body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}) },
      body: opts.body,
    });
    if (!response.ok) throw new Error("Stripe request refused");
    return await response.json() as T;
  } catch { throw new Error("Stripe request failed"); }
}
