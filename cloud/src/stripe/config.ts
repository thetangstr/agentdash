// AgentDash (SC-8, GH #769): Stripe and per-box Resend settings, from the
// environment. Every credential is a Secret from the moment it is read.
// The boxes' shared restricted key is NOT here: it lives encrypted in
// fleet_secrets and only changes through `admin stripe rotate-box-key`.
import { Secret } from "../secret.js";

export class BillingConfigError extends Error {}

export type StripeMode = "test" | "live";

export interface BillingConfig {
  /** Which Stripe mode the fleet runs in; keys and events of the other mode are refused. */
  stripeMode: StripeMode;
  /**
   * Signing secrets of the account endpoint https://www.agentdash.cloud/api/cloud/stripe/webhook
   * (comma-separated during a roll). Joined at runtime by one stored in
   * fleet_secrets when the control plane created the endpoint itself.
   */
  stripeWebhookSecrets: Secret[];
  /** The control plane's own restricted key (webhook endpoints), only for `admin stripe endpoint ensure`. */
  stripeControlKey: Secret | null;
  /** The Pro per-seat price every box sells (not a secret). */
  stripeProPriceId: string | null;
  stripeTrialDays: number;
  /** A full-access Resend key used ONLY to create and revoke the boxes' sending-only keys. */
  resendAdminKey: Secret | null;
  /** Resend's id for the verified domain (mail.agentdash.cloud) each box key is restricted to. */
  resendBoxDomainId: string | null;
  /** The From line boxes send invites and resets with. */
  boxEmailFrom: string;
  /**
   * Slugs of boxes the control plane does not manage but that share the Stripe
   * account (the script-provisioned launch box, which keeps its own endpoint):
   * their events are dropped quietly instead of alerting as unknown.
   */
  stripeIgnoredSlugs: string[];
}

function secretList(raw: string | undefined, name: string, prefix: string): Secret[] {
  const out: Secret[] = [];
  for (const v of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!v.startsWith(prefix)) throw new BillingConfigError(`${name} entries must start with ${prefix}`);
    out.push(new Secret(v));
  }
  return out;
}

export function loadBillingConfig(env: NodeJS.ProcessEnv): BillingConfig {
  const mode = (env.CLOUD_STRIPE_MODE ?? "test").trim();
  if (mode !== "test" && mode !== "live") throw new BillingConfigError("CLOUD_STRIPE_MODE must be 'test' or 'live'");
  const control = env.CLOUD_STRIPE_CONTROL_KEY?.trim() || null;
  if (control && !control.startsWith(`rk_${mode}_`)) {
    throw new BillingConfigError(`CLOUD_STRIPE_CONTROL_KEY must be a ${mode}-mode restricted key (rk_${mode}_…)`);
  }
  const price = env.CLOUD_STRIPE_PRO_PRICE_ID?.trim() || null;
  if (price && !/^price_[A-Za-z0-9]+$/.test(price)) throw new BillingConfigError("CLOUD_STRIPE_PRO_PRICE_ID must be a Stripe price id (price_…)");
  const trialRaw = (env.CLOUD_STRIPE_TRIAL_DAYS ?? "14").trim();
  const trial = Number(trialRaw);
  if (!/^\d+$/.test(trialRaw) || trial < 1 || trial > 730) throw new BillingConfigError("CLOUD_STRIPE_TRIAL_DAYS must be an integer from 1 to 730");
  const resendAdmin = env.CLOUD_RESEND_ADMIN_API_KEY?.trim() || null;
  if (resendAdmin && !resendAdmin.startsWith("re_")) throw new BillingConfigError("CLOUD_RESEND_ADMIN_API_KEY must be a Resend key (re_…)");
  const domainId = env.CLOUD_RESEND_BOX_DOMAIN_ID?.trim() || null;
  if (domainId && !/^[A-Za-z0-9-]{8,64}$/.test(domainId)) throw new BillingConfigError("CLOUD_RESEND_BOX_DOMAIN_ID must be a Resend domain id");
  if (Boolean(resendAdmin) !== Boolean(domainId)) {
    throw new BillingConfigError("CLOUD_RESEND_ADMIN_API_KEY and CLOUD_RESEND_BOX_DOMAIN_ID are set together or not at all");
  }
  const from = env.CLOUD_BOX_EMAIL_FROM?.trim() || "AgentDash <no-reply@mail.agentdash.cloud>";
  if (/[\r\n]/.test(from) || !/@/.test(from)) throw new BillingConfigError("CLOUD_BOX_EMAIL_FROM must be one From line with an address");
  return {
    stripeMode: mode,
    stripeWebhookSecrets: secretList(env.CLOUD_STRIPE_WEBHOOK_SECRET, "CLOUD_STRIPE_WEBHOOK_SECRET", "whsec_"),
    stripeControlKey: control ? new Secret(control) : null,
    stripeProPriceId: price,
    stripeTrialDays: trial,
    resendAdminKey: resendAdmin ? new Secret(resendAdmin) : null,
    resendBoxDomainId: domainId,
    boxEmailFrom: from,
    stripeIgnoredSlugs: (env.CLOUD_STRIPE_IGNORE_BOX_SLUGS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

/** A shared box key acceptable for this mode: a restricted key of the same mode. */
export function checkBoxStripeKey(key: string, mode: StripeMode): string | null {
  if (!/^rk_(test|live)_[A-Za-z0-9]{10,250}$/.test(key)) return "must be a Stripe restricted key (rk_test_… or rk_live_…)";
  if (!key.startsWith(`rk_${mode}_`)) return `is not a ${mode}-mode key (CLOUD_STRIPE_MODE=${mode})`;
  return null;
}
