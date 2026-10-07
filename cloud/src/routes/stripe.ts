// AgentDash (SC-8, GH #769): the Stripe surface of the control plane.
//   stripeWebhookHandlers  POST /api/cloud/stripe/webhook, the account's one
//                          endpoint (public; www rewrites /api/cloud/* here).
//                          Mounted BEFORE the JSON parser: the signature is
//                          over the exact raw bytes.
//   stripeInternalRoutes   /internal/stripe/* for the admin CLI (behind the
//                          operator guard like every /internal route).
import express, { Router, type Request, type RequestHandler, type Response, type Router as ExpressRouter } from "express";
import { and, count, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxes, STRIPE_EVENT_STATES, stripeEvents, type StripeEventState } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { BILLING_SYNC_STATES, BoxKeyRotationError, currentFleetBilling, syncFleetBilling, type SyncDeps } from "../stripe/box-billing.js";
import type { BillingConfig } from "../stripe/config.js";
import { ensureStripeEndpoint, type StripeEndpointsClient } from "../stripe/endpoint.js";
import { BOX_STRIPE_KEY, STRIPE_ENDPOINT_SECRET, type FleetSecretStore } from "../stripe/fleet-secrets.js";
import type { StripeForwarder } from "../stripe/forwarder.js";

export function stripeWebhookHandlers(forwarder: StripeForwarder, log: Logger): RequestHandler[] {
  return [
    express.raw({ type: () => true, limit: "1mb" }),
    async (req: Request, res: Response) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sig = req.headers["stripe-signature"];
      try {
        const r = await forwarder.receive(raw, Array.isArray(sig) ? sig[0] : sig);
        res.status(r.status).json(r.body);
      } catch (err) {
        // A 500 makes Stripe retry, which is what a database outage needs.
        log.error("Stripe webhook failed", { err });
        if (!res.headersSent) res.status(500).json({ error: "internal error" });
      }
    },
  ];
}

const EVENT_ID_RE = /^evt_[A-Za-z0-9_]{1,200}$/;

export interface StripeInternalDeps {
  db: CloudDb;
  log: Logger;
  forwarder: StripeForwarder;
  billing: BillingConfig;
  store: FleetSecretStore;
  /** Builds the sync's dependencies; its Railway client is null without a token. */
  syncDeps: () => SyncDeps;
  /** Null without CLOUD_STRIPE_CONTROL_KEY. */
  endpoints: StripeEndpointsClient | null;
  /** https://www.agentdash.cloud/api/cloud/stripe/webhook */
  webhookUrl: string;
}

export function stripeInternalRoutes(deps: StripeInternalDeps): ExpressRouter {
  const router = Router();
  const { db, billing } = deps;

  router.get("/stripe/status", async (_req, res) => {
    const { billing: fleet, missing } = await currentFleetBilling(deps.store, billing);
    // GH #923: this GET must stay read-only. A box counts as on a config once
    // a deployment after the send has succeeded; that promotion now happens in
    // the 15-second background pass in index.ts, so status only reports the
    // pending count below instead of promoting inline.
    const pendingDeploy = fleet
      ? (
          await db
            .select({ n: count() })
            .from(boxes)
            .where(and(inArray(boxes.state, [...BILLING_SYNC_STATES]), eq(boxes.stripeConfigPendingRev, fleet.rev)))
        )[0]!.n
      : null;
    const live = await db
      .select({ rev: boxes.stripeConfigRev, n: count() })
      .from(boxes)
      .where(and(inArray(boxes.state, [...BILLING_SYNC_STATES]), isNotNull(boxes.webServiceId)))
      .groupBy(boxes.stripeConfigRev);
    const events = await db.select({ state: stripeEvents.state, n: count() }).from(stripeEvents).groupBy(stripeEvents.state);
    const behind = fleet
      ? (
          await db
            .select({ n: count() })
            .from(boxes)
            .where(
              and(
                inArray(boxes.state, [...BILLING_SYNC_STATES]),
                isNotNull(boxes.webServiceId),
                or(isNull(boxes.stripeConfigRev), ne(boxes.stripeConfigRev, fleet.rev)),
              ),
            )
        )[0]!.n
      : null;
    res.json({
      mode: billing.stripeMode,
      webhookUrl: deps.webhookUrl,
      endpointSecrets: { fromEnv: billing.stripeWebhookSecrets.length, stored: (await deps.store.info(STRIPE_ENDPOINT_SECRET)) !== null },
      sharedBoxKey: await deps.store.info(BOX_STRIPE_KEY),
      proPriceId: billing.stripeProPriceId,
      trialDays: billing.stripeTrialDays,
      targetRev: fleet?.rev ?? null,
      incomplete: missing,
      boxesByRev: Object.fromEntries(live.map((r) => [r.rev ?? "none", r.n])),
      // Behind = not yet RUNNING the target config (includes boxesPendingDeploy). The old key must outlive this reaching 0.
      boxesBehind: behind,
      boxesPendingDeploy: pendingDeploy,
      resend: { boxKeys: billing.resendAdminKey !== null, domainId: billing.resendBoxDomainId, from: billing.boxEmailFrom },
      events: Object.fromEntries(events.map((r) => [r.state, r.n])),
    });
  });

  // The dead-letter view (and the rest of the queue). Never a body.
  router.get("/stripe/events", async (req, res) => {
    const state = String(req.query.state ?? "dead");
    if (state !== "all" && !(STRIPE_EVENT_STATES as readonly string[]).includes(state)) {
      res.status(400).json({ error: `state must be one of ${STRIPE_EVENT_STATES.join(", ")}, all` });
      return;
    }
    const limit = Number(req.query.limit ?? 100);
    res.json(await deps.forwarder.list(state as StripeEventState | "all", Number.isInteger(limit) ? limit : 100));
  });

  router.post("/stripe/events/:eventId/redeliver", async (req, res) => {
    const { eventId } = req.params;
    if (!EVENT_ID_RE.test(eventId)) {
      res.status(400).json({ error: "not a Stripe event id" });
      return;
    }
    const r = await deps.forwarder.redeliver(eventId);
    if (!r.ok) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    deps.log.info("Stripe event redelivery requested", { eventId });
    res.json({ eventId, state: "pending" });
  });

  // Dry run unless apply is true. The key, when given, arrives in the body from stdin and is never echoed.
  router.post("/stripe/box-key", async (req, res) => {
    const body = (req.body ?? {}) as { key?: unknown; apply?: unknown; redeploy?: unknown };
    if (body.key !== undefined && typeof body.key !== "string") {
      res.status(400).json({ error: "key must be a string" });
      return;
    }
    try {
      const ip = typeof res.locals.adminIp === "string" ? res.locals.adminIp : null;
      const result = await syncFleetBilling(deps.syncDeps(), {
        newKey: (body.key as string | undefined) ?? null,
        apply: body.apply === true,
        redeploy: body.redeploy === true,
        actor: "admin-cli",
        ip,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof BoxKeyRotationError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.post("/stripe/endpoint", async (req, res) => {
    if (!deps.endpoints) {
      res.status(409).json({ error: "CLOUD_STRIPE_CONTROL_KEY is not set; create the endpoint in the Stripe Dashboard and set CLOUD_STRIPE_WEBHOOK_SECRET instead" });
      return;
    }
    const apply = (req.body as { apply?: unknown } | undefined)?.apply === true;
    const ip = typeof res.locals.adminIp === "string" ? res.locals.adminIp : null;
    res.json(await ensureStripeEndpoint({ client: deps.endpoints, store: deps.store, url: deps.webhookUrl, apply, actor: "admin-cli", ip }));
  });

  return router;
}

