import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { billingService } from "../services/billing.js";
import { entitlementSync } from "../services/entitlement-sync.js";
import { stripeWebhookLedger } from "../services/stripe-webhook-ledger.js";
import { companyService } from "../services/companies.js";
import { unauthorized, forbidden } from "../errors.js";

interface RoutesConfig {
  stripe: any;
  webhookSecret: string;
  proPriceId: string;
  trialDays: number;
  publicBaseUrl: string;
}

export function billingRoutes(db: Db, cfg: RoutesConfig) {
  const router = Router();
  const companies = companyService(db);
  const svc = billingService({
    stripe: cfg.stripe,
    companies,
    config: { proPriceId: cfg.proPriceId, trialDays: cfg.trialDays, publicBaseUrl: cfg.publicBaseUrl },
  });
  const sync = entitlementSync({
    companies: {
      findByStripeSubscriptionId: (id) => companies.findByStripeSubscriptionId(id),
      findByStripeCustomerId: (id) => companies.findByStripeCustomerId(id),
      update: (id, patch) => companies.update(id, patch),
    },
    ledger: stripeWebhookLedger(db),
    stripe: cfg.stripe, // AgentDash (#169): used in onInvoicePaid to retrieve subscription
  });

  router.post("/checkout-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Sign-in required");
    const { companyId } = req.body as { companyId: string };
    if (!req.actor.companyIds?.includes(companyId)) throw forbidden("Not a member of this company");
    const r = await svc.createCheckoutSession(companyId);
    res.json(r);
  });

  router.post("/portal-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Sign-in required");
    const { companyId } = req.body as { companyId: string };
    if (!req.actor.companyIds?.includes(companyId)) throw forbidden("Not a member of this company");
    const r = await svc.createPortalSession(companyId);
    res.json(r);
  });

  router.get("/status", async (req, res) => {
    const companyId = String(req.query.companyId ?? "");
    if (req.actor.type !== "board" || !req.actor.companyIds?.includes(companyId)) {
      throw forbidden("Not a member of this company");
    }
    const r = await svc.getStatus(companyId);
    res.json(r);
  });

  router.post("/webhook", async (req, res) => {
    // AgentDash: security — defensive guard so an accidentally empty webhook
    // secret at runtime never silently accepts all signatures. The startup
    // check in app.ts should prevent this, but belt-and-suspenders here.
    if (!cfg.webhookSecret.trim()) {
      return res.status(503).json({ error: "Webhook secret not configured" });
    }
    const sig = req.header("stripe-signature") ?? "";
    let event;
    try {
      event = cfg.stripe.webhooks.constructEvent((req as any).rawBody, sig, cfg.webhookSecret);
    } catch {
      return res.status(400).json({ error: "invalid signature" });
    }
    await sync.dispatch(event);
    res.status(200).json({ received: true });
  });

  return router;
}
