import { Router } from "express";
import { and, eq } from "drizzle-orm";
import {
  type Db,
  authUsers,
  companyMemberships,
} from "@paperclipai/db";
import { billingService } from "../services/billing.js";
import { entitlementSync } from "../services/entitlement-sync.js";
import { stripeWebhookLedger } from "../services/stripe-webhook-ledger.js";
import { companyService } from "../services/companies.js";
import { conversationService } from "../services/conversations.js";
import { agentService } from "../services/agents.js";
import { logger } from "../middleware/logger.js";
import { sendEmail } from "../auth/email.js";
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
  // AgentDash (#249): downgrade notifier — when a company drops from
  // pro_active/pro_trial to pro_canceled/pro_past_due, post a CoS chat
  // message into the company's primary conversation explaining what
  // happened + how to fix. Best-effort; entitlement-sync swallows errors
  // so a notifier failure can never block the entitlement update.
  const conversations = conversationService(db);
  const agents = agentService(db);
  async function notifyDowngrade(input: { companyId: string; from: string; to: string }) {
    const convo = await conversations.findByCompany(input.companyId);
    if (!convo) {
      logger.info(
        { companyId: input.companyId, from: input.from, to: input.to },
        "[billing] no conversation found for downgrade notice; skipping",
      );
      return;
    }
    const allAgents = await agents.list(input.companyId);
    const cos = allAgents.find((a: { role?: string }) => a.role === "chief_of_staff") ?? null;
    if (!cos) {
      logger.info(
        { companyId: input.companyId },
        "[billing] no CoS agent found for downgrade notice; skipping",
      );
      return;
    }
    const message = input.to === "pro_past_due"
      ? "Heads up: Stripe couldn't charge your card, so the subscription is past due. Inviting teammates and hiring agents are paused until the card is updated. [Update payment method](/billing)"
      : "Your Pro subscription ended. Everyone keeps their existing access, but inviting new teammates and hiring new agents now require an active subscription. [Reactivate Pro](/billing)";
    try {
      await conversations.postMessage({
        conversationId: convo.id,
        authorKind: "agent",
        authorId: cos.id,
        body: message,
      });
    } catch (err) {
      logger.error(
        { err, companyId: input.companyId, conversationId: convo.id },
        "[billing] failed to post downgrade chat message",
      );
    }
  }

  // AgentDash (#211): trial-will-end fan-out — when Stripe notifies us 3
  // days before trial expiry, post a CoS chat reminder + email each human
  // member with verified email asking them to add a card. Best-effort;
  // entitlement-sync swallows errors so a notifier failure can never block
  // the webhook handler.
  async function notifyTrialWillEnd(input: { companyId: string; trialEndAt: Date | null }) {
    const daysLeft =
      input.trialEndAt
        ? Math.max(0, Math.round((input.trialEndAt.getTime() - Date.now()) / 86_400_000))
        : 3;
    const chatBody = `Heads up: your Pro trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Add a payment method to keep Pro features (multi-human invites, agent hires) active. [Update payment method](/billing)`;

    // 1. CoS chat reminder
    try {
      const convo = await conversations.findByCompany(input.companyId);
      if (convo) {
        const allAgents = await agents.list(input.companyId);
        const cos = allAgents.find((a: { role?: string }) => a.role === "chief_of_staff") ?? null;
        if (cos) {
          await conversations.postMessage({
            conversationId: convo.id,
            authorKind: "agent",
            authorId: cos.id,
            body: chatBody,
          });
        }
      }
    } catch (err) {
      logger.error(
        { err, companyId: input.companyId },
        "[billing] trial_will_end CoS chat post failed",
      );
    }

    // 2. Email each verified-email human member
    try {
      const memberRows = await db
        .select({ email: authUsers.email, name: authUsers.name })
        .from(companyMemberships)
        .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
        .where(
          and(
            eq(companyMemberships.companyId, input.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
            eq(authUsers.emailVerified, true),
          ),
        );
      const subject = `Your AgentDash Pro trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
      const text = `${chatBody}\n\nManage subscription: ${process.env.BILLING_PUBLIC_BASE_URL ?? ""}/billing`;
      const html = `<p>${chatBody.replace(/\n/g, "<br/>")}</p><p><a href="${process.env.BILLING_PUBLIC_BASE_URL ?? ""}/billing">Manage subscription</a></p>`;
      for (const member of memberRows) {
        if (!member.email) continue;
        await sendEmail({ to: member.email, subject, text, html });
      }
    } catch (err) {
      logger.error(
        { err, companyId: input.companyId },
        "[billing] trial_will_end email fan-out failed",
      );
    }
  }

  const sync = entitlementSync({
    companies: {
      findByStripeSubscriptionId: (id) => companies.findByStripeSubscriptionId(id),
      findByStripeCustomerId: (id) => companies.findByStripeCustomerId(id),
      getById: (id) =>
        companies.getById(id).then((c) =>
          c ? { id: c.id, planTier: c.planTier ?? "free" } : null,
        ),
      update: (id, patch) => companies.update(id, patch),
    },
    ledger: stripeWebhookLedger(db),
    onTierDowngrade: notifyDowngrade,
    onTrialWillEnd: notifyTrialWillEnd,
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
