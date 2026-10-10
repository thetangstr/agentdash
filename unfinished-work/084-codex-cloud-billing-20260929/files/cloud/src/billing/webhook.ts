// AgentDash (SC-8): authenticated raw-byte fanout. Stripe retries until delivery AND commit succeed.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import type { CloudConfig } from "../config.js";
import { decryptField } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { boxes, cloudBilling, stripeDeliveries } from "../db/schema.js";
import type { Alerter } from "../jobs/alerts.js";
import type { Logger } from "../logger.js";
import { Secret } from "../secret.js";
import { stripeRequest, stripeSignature, subscriptionPlanTier, verifyStripeSignature } from "./stripe.js";

type ObjectData = { id?: string; status?: string; metadata?: { box_slug?: unknown }; subscription_details?: { metadata?: { box_slug?: unknown } }; parent?: { subscription_details?: { metadata?: { box_slug?: unknown } } } };
class InvalidEvent extends Error {}
export function stripeWebhook(deps: { db: CloudDb; config: CloudConfig; log: Logger; alerter: Alerter; fetch?: typeof fetch }): RequestHandler {
  const { db, config } = deps;
  return async (req, res) => {
    const raw = req.body;
    try {
      const [billing] = await db.select().from(cloudBilling).where(eq(cloudBilling.id, "cloud"));
      const secret = billing?.stripeEndpointSecretEnc ? new Secret(decryptField(config.dataKeys, billing.stripeEndpointSecretEnc, "cloud_billing.stripe_endpoint_secret_enc")) : config.billing?.webhookSecret;
      if (!secret) { res.status(503).json({ error: "Stripe webhook not configured" }); return; }
      if (!Buffer.isBuffer(raw) || !verifyStripeSignature(raw, req.get("stripe-signature"), secret)) { res.status(400).json({ error: "invalid Stripe signature" }); return; }
      let event: { id: string; type: string; data: { object: ObjectData } };
      try { event = JSON.parse(raw.toString("utf8")); } catch { throw new InvalidEvent(); }
      if (!/^evt_[A-Za-z0-9_]{1,200}$/.test(event?.id ?? "") || typeof event.type !== "string" || !event.data?.object) throw new InvalidEvent();
      const object = event.data.object;
      const slug = object.metadata?.box_slug ?? object.subscription_details?.metadata?.box_slug ?? object.parent?.subscription_details?.metadata?.box_slug;
      const found = typeof slug === "string" && /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) ? (await db.select({ id: boxes.id }).from(boxes).where(eq(boxes.slug, slug)))[0] : undefined;
      if (!found) {
        // Signed payload still contains untrusted strings: neither slug nor body enters the alert.
        deps.log.warn("Stripe event dropped: unknown box", { eventId: event.id });
        await deps.alerter.send({ kind: "stripe_unknown_box", subject: "Stripe event has no known box; dropped", error: event.id });
        res.status(200).json({ received: true, dropped: true }); return;
      }
      const hash = createHash("sha256").update(raw).digest("hex");
      await db.transaction(async (tx) => {
        const [box] = await tx.select().from(boxes).where(eq(boxes.id, found.id)).for("update");
        const [delivered] = await tx.select().from(stripeDeliveries).where(eq(stripeDeliveries.eventId, event.id));
        if (delivered) { if (delivered.boxId !== box.id || delivered.payloadHash !== hash) throw new InvalidEvent(); return; }
        if (!["active", "awaiting_claim", "suspended", "provisioning"].includes(box.state) || !box.stripeWebhookSecretEnc || !box.upstreamHost || !/^[a-z0-9][a-z0-9-]*\.up\.railway\.app$/.test(box.upstreamHost)) throw new Error("box billing unavailable");
        let planTier: string | undefined;
        if (event.type.startsWith("customer.subscription.")) {
          if (!config.billing?.controlKey || !/^sub_[A-Za-z0-9_]{1,200}$/.test(object.id ?? "")) throw new Error("subscription reconciliation unavailable");
          const current = await stripeRequest<ObjectData>(config.billing.controlKey, `subscriptions/${object.id}`, { fetch: deps.fetch });
          if (current.id !== object.id || current.metadata?.box_slug !== box.slug || typeof current.status !== "string") throw new Error("subscription routing mismatch");
          planTier = subscriptionPlanTier(current.status);
        }
        const boxSecret = new Secret(decryptField(config.dataKeys, box.stripeWebhookSecretEnc, "boxes.stripe_webhook_secret_enc"));
        // The direct Railway host also enforces the box's edge credential
        // after SC-5 is enabled. Sending its stored header does not open that gate.
        const edge = box.edgeSecretEnc ? decryptField(config.dataKeys, box.edgeSecretEnc, "boxes.edge_secret_enc") : null;
        try {
          const response = await (deps.fetch ?? fetch)(`https://${box.upstreamHost}/api/billing/webhook`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", "stripe-signature": stripeSignature(raw, boxSecret), ...(edge ? { "x-agentdash-edge": edge } : {}) }, body: new Uint8Array(raw) });
          if (!response.ok) throw new Error("box refused delivery");
        } catch { throw new Error("box Stripe delivery failed"); }
        if (planTier !== undefined) await tx.update(boxes).set({ planTier, updatedAt: new Date() }).where(eq(boxes.id, box.id));
        await tx.insert(stripeDeliveries).values({ eventId: event.id, payloadHash: hash, boxId: box.id });
      });
      res.json({ received: true });
    } catch (error) {
      if (error instanceof InvalidEvent) { res.status(400).json({ error: "invalid Stripe event" }); return; }
      // Never log provider errors or raw data: these can contain payment data and credentials.
      deps.log.error("Stripe delivery pending retry");
      res.status(502).json({ error: "Stripe delivery pending retry" });
    }
  };
}
