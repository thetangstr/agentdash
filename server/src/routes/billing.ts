// AgentDash: Billing routes
// Endpoints for Stripe Checkout, Customer Portal, and webhook ingestion.

import { Router, type Request, type Response } from "express";
import type { Db } from "@agentdash/db";
import { billingService, type BillingServiceDeps } from "../services/billing.js";
import { assertCompanyAccess } from "./authz.js";

export type { BillingServiceDeps };

export function billingRoutes(db: Db, deps: BillingServiceDeps) {
  const router = Router();
  const svc = billingService(db, deps);

  // POST /api/companies/:companyId/billing/checkout-session
  router.post("/companies/:companyId/billing/checkout-session", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const { targetTier } = req.body as { targetTier?: string };
    if (!targetTier || !["pro", "enterprise"].includes(targetTier)) {
      res.status(400).json({ error: "Invalid targetTier — must be 'pro' or 'enterprise'" });
      return;
    }
    try {
      const { url } = await svc.createCheckoutSession(companyId, targetTier as "pro" | "enterprise");
      res.json({ url });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/companies/:companyId/billing/portal-session
  router.post("/companies/:companyId/billing/portal-session", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    try {
      const { url } = await svc.createPortalSession(companyId);
      res.json({ url });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}

// Webhook handler is mounted SEPARATELY on `app` at /api/billing/webhook
// (no auth, no /companies/ prefix, outside boardMutationGuard).
export function billingWebhookHandler(db: Db, deps: BillingServiceDeps) {
  const svc = billingService(db, deps);
  return async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"] as string | undefined;
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "Missing raw body" });
      return;
    }
    try {
      const result = await svc.handleWebhookEvent(rawBody, sig ?? "");
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  };
}
