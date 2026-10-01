// AgentDash (SC-8, GH #769): the account's ONE webhook endpoint, created by
// the control plane with its own restricted key (CLOUD_STRIPE_CONTROL_KEY,
// webhook endpoints write) so its signing secret goes straight into
// fleet_secrets, encrypted, and never through a person. Stripe returns the
// secret only when the endpoint is created: if one already exists for the URL
// the command says so and changes nothing.
import type { Secret } from "../secret.js";
import { type FleetSecretStore, STRIPE_ENDPOINT_SECRET } from "./fleet-secrets.js";

export const STRIPE_API = "https://api.stripe.com";
/** The API version the boxes pin (server/src/app.ts); payload shapes follow the endpoint's version. */
export const BOX_STRIPE_API_VERSION = "2026-04-22.dahlia";
/** Everything a box's billing webhook handles, plus checkout completion. */
export const FORWARDED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

export interface StripeEndpoint {
  id: string;
  url: string;
  status: string;
  enabledEvents: string[];
  apiVersion: string | null;
}

export interface StripeEndpointsClient {
  list(): Promise<StripeEndpoint[]>;
  create(input: { url: string; enabledEvents: readonly string[]; apiVersion: string; description: string }): Promise<{ id: string; secret: string }>;
}

export class StripeApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`Stripe ${operation} failed: HTTP ${status}`);
    this.name = "StripeApiError";
  }
}

export function stripeEndpointsClient(opts: { apiKey: Secret; fetch?: typeof fetch; baseUrl?: string }): StripeEndpointsClient {
  const f = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? STRIPE_API).replace(/\/+$/, "");
  const auth = () => ({ authorization: `Bearer ${opts.apiKey.reveal()}` });
  return {
    async list() {
      const res = await f(`${base}/v1/webhook_endpoints?limit=100`, { headers: auth(), signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!res?.ok) throw new StripeApiError("webhook_endpoints list", res?.status ?? 0);
      const j = (await res.json()) as { data?: Array<Record<string, unknown>> };
      return (j.data ?? []).map((e) => ({
        id: String(e.id),
        url: String(e.url),
        status: String(e.status),
        enabledEvents: Array.isArray(e.enabled_events) ? e.enabled_events.map(String) : [],
        apiVersion: typeof e.api_version === "string" ? e.api_version : null,
      }));
    },
    async create(input) {
      const form = new URLSearchParams();
      form.set("url", input.url);
      form.set("api_version", input.apiVersion);
      form.set("description", input.description);
      input.enabledEvents.forEach((e, i) => form.set(`enabled_events[${i}]`, e));
      const res = await f(`${base}/v1/webhook_endpoints`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (!res?.ok) throw new StripeApiError("webhook_endpoints create", res?.status ?? 0);
      const j = (await res.json()) as { id?: unknown; secret?: unknown };
      if (typeof j.id !== "string" || typeof j.secret !== "string" || !j.secret.startsWith("whsec_")) throw new StripeApiError("webhook_endpoints create (unexpected answer)", res.status);
      return { id: j.id, secret: j.secret };
    },
  };
}

export async function ensureStripeEndpoint(input: {
  client: StripeEndpointsClient;
  store: FleetSecretStore;
  url: string;
  apply: boolean;
  actor: string;
  ip?: string | null;
}): Promise<Record<string, unknown>> {
  const existing = (await input.client.list()).filter((e) => e.url === input.url);
  if (existing.length) {
    const stored = await input.store.info(STRIPE_ENDPOINT_SECRET);
    return {
      outcome: "exists",
      endpoints: existing,
      secretStored: stored !== null,
      note: stored
        ? "the endpoint exists and its secret is stored"
        : "the endpoint exists but Stripe shows its secret only at creation: copy it from the Dashboard into CLOUD_STRIPE_WEBHOOK_SECRET, or delete the endpoint and run this again",
    };
  }
  const plan = { url: input.url, enabledEvents: [...FORWARDED_EVENTS], apiVersion: BOX_STRIPE_API_VERSION };
  if (!input.apply) return { outcome: "would_create", dryRun: true, ...plan };
  const created = await input.client.create({ ...plan, description: "AgentDash cloud: forwards each event to its box (SC-8)" });
  await input.store.set(STRIPE_ENDPOINT_SECRET, created.secret, input.actor, input.ip ?? null);
  return { outcome: "created", id: created.id, ...plan, secretStored: true };
}
