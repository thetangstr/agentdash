// AgentDash (SC-8, GH #769): reading a Stripe event just enough to route it.
// The box writes `box_slug` (its AGENTDASH_BOX_SLUG) into the metadata of the
// customer, the checkout session and the subscription it creates
// (server/src/services/billing.ts). Invoices carry the subscription's
// metadata under parent.subscription_details (API 2025-03-31 and later) or
// subscription_details (earlier).

export interface StripeEventLike {
  id: string;
  type: string;
  created: number | null;
  livemode: boolean;
  object: Record<string, unknown> | null;
}

const EVENT_ID_RE = /^evt_[A-Za-z0-9_]{1,200}$/;
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const CUSTOMER_RE = /^cus_[A-Za-z0-9]{1,100}$/;

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Parse the verified raw body. Null when it is not a Stripe event shape. */
export function parseStripeEvent(raw: Buffer): StripeEventLike | null {
  let v: unknown;
  try {
    v = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  const e = rec(v);
  if (!e || typeof e.id !== "string" || !EVENT_ID_RE.test(e.id) || typeof e.type !== "string" || e.type.length > 200) return null;
  return {
    id: e.id,
    type: e.type,
    created: typeof e.created === "number" ? e.created : null,
    livemode: e.livemode === true,
    object: rec(rec(e.data)?.object),
  };
}

function metadataSlug(m: unknown): string | null {
  const s = rec(m)?.box_slug;
  return typeof s === "string" ? s.trim().toLowerCase() : null;
}

/**
 * The box_slug the event names, or null when it names none. A value that is
 * present but not a valid slug is returned as-is so the caller can treat it as
 * unknown (and alert), never as "missing".
 */
export function boxSlugOf(event: StripeEventLike): string | null {
  const o = event.object;
  if (!o) return null;
  const candidates = [
    o.metadata,
    rec(o.subscription_details)?.metadata,
    rec(rec(o.parent)?.subscription_details)?.metadata,
    rec(o.subscription_data)?.metadata,
  ];
  for (const m of candidates) {
    const s = metadataSlug(m);
    if (s) return s;
  }
  return null;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** The Stripe customer id the event concerns, when there is one. */
export function customerOf(event: StripeEventLike): string | null {
  const o = event.object;
  if (!o) return null;
  const c = event.type.startsWith("customer.") && !event.type.startsWith("customer.subscription.") ? o.id : o.customer;
  const id = typeof c === "string" ? c : typeof rec(c)?.id === "string" ? (rec(c)!.id as string) : null;
  return id && CUSTOMER_RE.test(id) ? id : null;
}

/** The box's own mapping (server/src/services/entitlement-sync.ts STATUS_TO_TIER), kept identical. */
export const STATUS_TO_TIER: Record<string, string> = {
  trialing: "pro_trial",
  active: "pro_active",
  past_due: "pro_past_due",
  unpaid: "pro_canceled",
  canceled: "pro_canceled",
  incomplete: "free",
  incomplete_expired: "free",
};

/** plan_tier from a customer.subscription.* event, or null for any other event. */
export function planTierOf(event: StripeEventLike): string | null {
  if (!event.type.startsWith("customer.subscription.") || event.type === "customer.subscription.trial_will_end") return null;
  const status = event.object?.status;
  if (typeof status !== "string") return null;
  return STATUS_TO_TIER[status] ?? "free";
}
