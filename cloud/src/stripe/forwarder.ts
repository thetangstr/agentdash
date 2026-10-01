// AgentDash (SC-8, GH #769): Stripe fan-out (spec §3.7). Stripe allows 16
// webhook endpoints per account, so the account has ONE endpoint,
// https://www.agentdash.cloud/api/cloud/stripe/webhook, and this module:
//
//   receive   verifies Stripe's signature over the exact raw body with the
//             account endpoint's secret, finds the box from metadata.box_slug
//             (or a customer id an earlier event taught us), keeps plan_tier
//             from customer.subscription.*, and stores the event once per
//             event id (Stripe's retries and replays inside the signature
//             tolerance are acknowledged, never forwarded twice). The raw
//             body is kept encrypted only while it may still be delivered.
//             Events naming no box, or an unknown one, are acknowledged with
//             200 and dropped (unknown also alerts ops) so Stripe does not
//             retry them for three days.
//   deliver   POSTs the unchanged raw body to the box's /api/billing/webhook
//             with a FRESH Stripe-format signature under the box's own
//             STRIPE_WEBHOOK_SECRET, so the box's unmodified constructEvent
//             accepts it. Failures retry on RETRY_SCHEDULE_MS, then go `dead`
//             (alert; `admin stripe events dead`, `admin stripe redeliver`).
//             A box that is not running yet, or is suspended, parks the event
//             (no attempt used) for up to PARK_MAX_MS.
//
// Nothing secret or personal is logged: no body, no secret, no signature.
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { decryptField, encryptField, type DataKeyring } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { boxes, stripeEvents, type StripeEventState } from "../db/schema.js";
import type { Alerter } from "../jobs/alerts.js";
import type { Logger } from "../logger.js";
import { redactString } from "../logger.js";
import type { BillingConfig } from "./config.js";
import { WEBHOOK_SECRET_AAD } from "./box-billing.js";
import { STRIPE_ENDPOINT_SECRET, type FleetSecretStore } from "./fleet-secrets.js";
import { boxSlugOf, customerOf, isValidSlug, parseStripeEvent, planTierOf, type StripeEventLike } from "./routing.js";
import { signStripePayload, StripeSignatureError, verifyStripeSignature } from "./signature.js";

export const STRIPE_WEBHOOK_PATH = "/api/cloud/stripe/webhook";
export const BOX_WEBHOOK_PATH = "/api/billing/webhook";
/** Waits after attempt 1, 2, …; the attempt after the last entry is the final one. */
export const RETRY_SCHEDULE_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 3_600_000, 4 * 3_600_000, 8 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;
/** How long an event waits for a box that is not running (Stripe's own retry window is 3 days). */
export const PARK_MAX_MS = 3 * 86_400_000;
export const PARK_RETRY_MS = 10 * 60_000;
const LOCK_MS = 2 * 60_000;

const DELIVERABLE_STATES = new Set(["awaiting_claim", "active"]);
const GONE_STATES = new Set(["pending_delete", "cleanup", "deleted"]);
/** A Railway service domain or similar bare host name: never a path, port, user or scheme. */
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const bodyAad = (eventId: string) => `stripe_events.body:${eventId}`;

export interface ForwarderDeps {
  db: CloudDb;
  log: Logger;
  keys: DataKeyring;
  billing: BillingConfig;
  store: FleetSecretStore;
  alerter?: Alerter;
  /** For deliveries to boxes; tests pass a fake that runs the box's real webhook route. */
  fetch?: typeof fetch;
  deliveryTimeoutMs?: number;
  now?: () => number;
  /** Tests turn off the background delivery a receive kicks off. */
  deliverOnReceive?: boolean;
}

export interface ReceiveResult {
  status: number;
  body: Record<string, unknown>;
}

export type StripeEventView = {
  eventId: string;
  type: string;
  boxSlug: string | null;
  state: StripeEventState;
  reason: string | null;
  attempts: number;
  lastStatus: number | null;
  nextAttemptAt: Date;
  createdAt: Date;
  deliveredAt: Date | null;
};

export function stripeForwarder(deps: ForwarderDeps) {
  const { db, log } = deps;
  const now = deps.now ?? Date.now;
  const f = deps.fetch ?? fetch;
  let storedSecret: { value: string | null; at: number } | null = null;

  /** The account endpoint's secrets: env (several during a roll) plus the one the control plane stored when it created the endpoint. */
  async function endpointSecrets(): Promise<string[]> {
    const fromEnv = deps.billing.stripeWebhookSecrets.map((s) => s.reveal());
    if (!storedSecret || now() - storedSecret.at > 60_000) {
      const r = await deps.store.reveal(STRIPE_ENDPOINT_SECRET).catch((err: unknown) => {
        log.error("could not read the stored Stripe endpoint secret", { err });
        return null;
      });
      storedSecret = { value: r?.value ?? null, at: now() };
    }
    return storedSecret.value ? [...fromEnv, storedSecret.value] : fromEnv;
  }

  async function findBox(event: StripeEventLike): Promise<{ slug: string | null; box: typeof boxes.$inferSelect | null; via: "slug" | "customer" | null }> {
    const slug = boxSlugOf(event);
    if (slug) {
      if (!isValidSlug(slug)) return { slug, box: null, via: "slug" };
      const [box] = await db.select().from(boxes).where(eq(boxes.slug, slug));
      return { slug, box: box ?? null, via: "slug" };
    }
    const customer = customerOf(event);
    if (customer) {
      const [box] = await db.select().from(boxes).where(eq(boxes.stripeCustomerId, customer));
      if (box) return { slug: box.slug, box, via: "customer" };
    }
    return { slug: null, box: null, via: null };
  }

  async function insertEvent(values: typeof stripeEvents.$inferInsert): Promise<string | null> {
    const rows = await db.insert(stripeEvents).values(values).onConflictDoNothing({ target: stripeEvents.eventId }).returning({ id: stripeEvents.id });
    return rows[0]?.id ?? null;
  }

  /** What the control plane itself learns from an event for a known box. */
  async function learn(event: StripeEventLike, box: typeof boxes.$inferSelect, via: "slug" | "customer"): Promise<void> {
    const customer = customerOf(event);
    if (via === "slug" && customer && box.stripeCustomerId !== customer) {
      await db.update(boxes).set({ stripeCustomerId: customer, updatedAt: new Date() }).where(eq(boxes.id, box.id));
    }
    const tier = planTierOf(event);
    if (tier && event.created !== null) {
      const at = new Date(event.created * 1000);
      // Stripe does not order events: an older event never overwrites a newer one's tier.
      await db
        .update(boxes)
        .set({ planTier: tier, planTierEventAt: at, updatedAt: new Date() })
        .where(and(eq(boxes.id, box.id), or(isNull(boxes.planTierEventAt), lte(boxes.planTierEventAt, at))));
    }
  }

  async function receive(raw: Buffer, signature: string | undefined): Promise<ReceiveResult> {
    const secrets = await endpointSecrets();
    if (!secrets.length) {
      log.error("Stripe webhook refused: no endpoint secret is configured (CLOUD_STRIPE_WEBHOOK_SECRET)");
      return { status: 503, body: { error: "webhook not configured" } };
    }
    try {
      verifyStripeSignature(raw, signature, secrets, { nowSec: Math.floor(now() / 1000) });
    } catch (err) {
      if (err instanceof StripeSignatureError) {
        log.warn("Stripe webhook signature refused", { reason: err.message });
        return { status: 400, body: { error: "invalid signature" } };
      }
      throw err;
    }
    const event = parseStripeEvent(raw);
    if (!event) {
      log.warn("Stripe webhook: signed body is not a Stripe event");
      return { status: 400, body: { error: "not a Stripe event" } };
    }
    const base = { eventId: event.id, eventType: event.type, livemode: event.livemode, stripeCreatedAt: event.created !== null ? new Date(event.created * 1000) : null };

    if (event.livemode !== (deps.billing.stripeMode === "live")) {
      const id = await insertEvent({ ...base, state: "dropped", reason: "livemode_mismatch" });
      log.warn("Stripe event dropped: livemode does not match CLOUD_STRIPE_MODE", { eventId: event.id, type: event.type, mode: deps.billing.stripeMode });
      return { status: 200, body: { received: true, dropped: "livemode_mismatch", duplicate: id === null } };
    }

    const { slug, box, via } = await findBox(event);
    if (!box && slug && deps.billing.stripeIgnoredSlugs.includes(slug)) {
      const id = await insertEvent({ ...base, boxSlug: isValidSlug(slug) ? slug : null, state: "dropped", reason: "ignored_box" });
      log.info("Stripe event for a box outside the control plane; dropped", { eventId: event.id, type: event.type, slug });
      return { status: 200, body: { received: true, dropped: "ignored_box", duplicate: id === null } };
    }
    if (!box) {
      const reason = slug ? "unknown_box" : "no_box_slug";
      const id = await insertEvent({ ...base, boxSlug: slug && isValidSlug(slug) ? slug : null, state: "dropped", reason });
      if (id && slug) {
        log.warn("Stripe event names a box the control plane does not know; dropped", { eventId: event.id, type: event.type, slug: isValidSlug(slug) ? slug : "(invalid)" });
        await deps.alerter
          ?.send({ kind: "stripe_unknown_box", subject: `Stripe event ${event.id} (${event.type}) names unknown box ${isValidSlug(slug) ? slug : "(invalid slug)"}; dropped`, slug: isValidSlug(slug) ? slug : null })
          .catch((err: unknown) => log.error("alert failed", { err }));
      } else if (id) {
        log.info("Stripe event names no box; dropped", { eventId: event.id, type: event.type });
      }
      return { status: 200, body: { received: true, dropped: reason, duplicate: id === null } };
    }

    if (GONE_STATES.has(box.state)) {
      const id = await insertEvent({ ...base, boxSlug: box.slug, boxId: box.id, state: "dropped", reason: `box_${box.state}` });
      log.info("Stripe event for a deleted box; dropped", { eventId: event.id, type: event.type, slug: box.slug, boxState: box.state });
      return { status: 200, body: { received: true, dropped: `box_${box.state}`, duplicate: id === null } };
    }

    const id = await insertEvent({
      ...base,
      boxSlug: box.slug,
      boxId: box.id,
      state: "pending",
      bodyEnc: encryptField(deps.keys, raw.toString("base64"), bodyAad(event.id)),
      nextAttemptAt: new Date(now()),
    });
    if (!id) {
      log.info("Stripe event already received; acknowledged", { eventId: event.id, type: event.type });
      return { status: 200, body: { received: true, duplicate: true } };
    }
    await learn(event, box, via!);
    log.info("Stripe event queued for its box", { eventId: event.id, type: event.type, slug: box.slug, via });
    if (deps.deliverOnReceive !== false) {
      void deliver(id).catch((err: unknown) => log.error("Stripe delivery failed", { err, eventId: event.id }));
    }
    return { status: 200, body: { received: true } };
  }

  /** Take the row for this worker for LOCK_MS; null when it is not due or someone else holds it. */
  async function claim(id: string): Promise<typeof stripeEvents.$inferSelect | null> {
    const rows = await db
      .update(stripeEvents)
      .set({ lockedUntil: new Date(now() + LOCK_MS), updatedAt: new Date() })
      .where(
        and(
          eq(stripeEvents.id, id),
          eq(stripeEvents.state, "pending"),
          lte(stripeEvents.nextAttemptAt, new Date(now())),
          or(isNull(stripeEvents.lockedUntil), lt(stripeEvents.lockedUntil, new Date(now()))),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async function settle(id: string, patch: Partial<typeof stripeEvents.$inferInsert>): Promise<void> {
    await db.update(stripeEvents).set({ ...patch, lockedUntil: null, updatedAt: new Date() }).where(eq(stripeEvents.id, id));
  }

  /** One delivery attempt for a due, pending event. Returns its state afterwards. */
  async function deliver(id: string): Promise<StripeEventState | "skipped"> {
    const row = await claim(id);
    if (!row) return "skipped";
    const [box] = row.boxId ? await db.select().from(boxes).where(eq(boxes.id, row.boxId)) : [];
    if (!box || GONE_STATES.has(box.state)) {
      await settle(row.id, { state: "dropped", reason: box ? `box_${box.state}` : "box_missing", bodyEnc: null });
      return "dropped";
    }
    const park = async (reason: string): Promise<StripeEventState> => {
      if (now() - row.createdAt.getTime() > PARK_MAX_MS) {
        await settle(row.id, { state: "dead", reason: `${reason}; waited ${Math.round(PARK_MAX_MS / 86_400_000)} days` });
        await deps.alerter
          ?.send({ kind: "stripe_delivery_dead", subject: `Stripe event ${row.eventId} (${row.eventType}) for ${box.slug} gave up: ${reason}`, slug: box.slug, boxId: box.id, error: reason })
          .catch((err: unknown) => log.error("alert failed", { err }));
        return "dead";
      }
      await settle(row.id, { reason: `parked:${reason}`, nextAttemptAt: new Date(now() + PARK_RETRY_MS) });
      return "pending";
    };
    if (!DELIVERABLE_STATES.has(box.state)) return park(`box_${box.state}`);
    if (!box.upstreamHost || !HOST_RE.test(box.upstreamHost)) return park("box_has_no_upstream_host");
    if (!box.stripeWebhookSecretEnc) return park("box_has_no_webhook_secret");
    if (!row.bodyEnc) {
      await settle(row.id, { state: "dead", reason: "no stored body" });
      return "dead";
    }

    let raw: Buffer;
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "user-agent": "agentdash-cloud-stripe-forwarder" };
    try {
      raw = Buffer.from(decryptField(deps.keys, row.bodyEnc, bodyAad(row.eventId)), "base64");
      headers["stripe-signature"] = signStripePayload(raw, decryptField(deps.keys, box.stripeWebhookSecretEnc, WEBHOOK_SECRET_AAD), Math.floor(now() / 1000));
      // The box behind the edge (SC-5) refuses requests without its edge secret; the router would add it.
      if (box.edgeSecretEnc) headers["x-agentdash-edge"] = decryptField(deps.keys, box.edgeSecretEnc, "boxes.edge_secret_enc");
    } catch {
      // A data key missing from the keyring: retrying cannot help, and an operator must look.
      await settle(row.id, { state: "dead", reason: "a stored secret or the body could not be decrypted" });
      await deps.alerter
        ?.send({ kind: "stripe_delivery_dead", subject: `Stripe event ${row.eventId} for ${box.slug}: stored data could not be decrypted`, slug: box.slug, boxId: box.id })
        .catch((err: unknown) => log.error("alert failed", { err }));
      return "dead";
    }

    const attempts = row.attempts + 1;
    let status = 0;
    let failure: string;
    try {
      const res = await f(`https://${box.upstreamHost}${BOX_WEBHOOK_PATH}`, {
        method: "POST",
        headers,
        body: new Uint8Array(raw),
        redirect: "manual",
        signal: AbortSignal.timeout(deps.deliveryTimeoutMs ?? 15_000),
      });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) {
        await settle(row.id, { state: "delivered", attempts, lastStatus: status, reason: null, bodyEnc: null, deliveredAt: new Date(now()) });
        log.info("Stripe event delivered", { eventId: row.eventId, type: row.eventType, slug: box.slug, attempts });
        return "delivered";
      }
      failure = `box answered HTTP ${status}`;
    } catch (err) {
      const code = err instanceof Error ? ((err as { code?: string }).code ?? err.name) : "unknown";
      failure = `transport error (${code})`;
    }
    failure = redactString(failure);
    if (attempts >= MAX_ATTEMPTS) {
      await settle(row.id, { state: "dead", attempts, lastStatus: status || null, reason: failure });
      log.error("Stripe event delivery gave up", { eventId: row.eventId, type: row.eventType, slug: box.slug, attempts, reason: failure });
      await deps.alerter
        ?.send({ kind: "stripe_delivery_dead", subject: `Stripe event ${row.eventId} (${row.eventType}) for ${box.slug} undeliverable after ${attempts} attempts`, slug: box.slug, boxId: box.id, attempt: attempts, error: failure })
        .catch((err: unknown) => log.error("alert failed", { err }));
      return "dead";
    }
    await settle(row.id, { attempts, lastStatus: status || null, reason: failure, nextAttemptAt: new Date(now() + RETRY_SCHEDULE_MS[attempts - 1]!) });
    log.warn("Stripe event delivery failed; will retry", { eventId: row.eventId, type: row.eventType, slug: box.slug, attempts, reason: failure });
    return "pending";
  }

  /** The background pass: every due event, oldest first. */
  async function deliverDue(limit = 25): Promise<Record<string, number>> {
    const due = await db
      .select({ id: stripeEvents.id })
      .from(stripeEvents)
      .where(
        and(
          eq(stripeEvents.state, "pending"),
          lte(stripeEvents.nextAttemptAt, new Date(now())),
          or(isNull(stripeEvents.lockedUntil), lt(stripeEvents.lockedUntil, new Date(now()))),
        ),
      )
      .orderBy(stripeEvents.nextAttemptAt)
      .limit(limit);
    const counts: Record<string, number> = {};
    for (const { id } of due) {
      const outcome = await deliver(id).catch((err: unknown) => {
        log.error("Stripe delivery failed", { err });
        return "error" as const;
      });
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return counts;
  }

  async function list(state: StripeEventState | "all", limit = 100): Promise<StripeEventView[]> {
    const q = db
      .select({
        eventId: stripeEvents.eventId,
        type: stripeEvents.eventType,
        boxSlug: stripeEvents.boxSlug,
        state: stripeEvents.state,
        reason: stripeEvents.reason,
        attempts: stripeEvents.attempts,
        lastStatus: stripeEvents.lastStatus,
        nextAttemptAt: stripeEvents.nextAttemptAt,
        createdAt: stripeEvents.createdAt,
        deliveredAt: stripeEvents.deliveredAt,
      })
      .from(stripeEvents);
    const rows = await (state === "all" ? q : q.where(eq(stripeEvents.state, state))).orderBy(sql`${stripeEvents.createdAt} desc`).limit(Math.min(Math.max(limit, 1), 500));
    return rows;
  }

  /** Put a dead (or waiting) event back at the front of the queue with a fresh attempt budget. */
  async function redeliver(eventId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const [row] = await db.select().from(stripeEvents).where(eq(stripeEvents.eventId, eventId));
    if (!row) return { ok: false, status: 404, error: "no such event" };
    if (row.state !== "dead" && row.state !== "pending") return { ok: false, status: 409, error: `event is ${row.state}; only dead or pending events can be redelivered` };
    if (!row.bodyEnc) return { ok: false, status: 409, error: "the event's body is not kept; resend it from the Stripe Dashboard" };
    await db
      .update(stripeEvents)
      .set({ state: "pending", attempts: 0, reason: "redeliver requested", nextAttemptAt: new Date(now()), lockedUntil: null, updatedAt: new Date() })
      .where(eq(stripeEvents.id, row.id));
    return { ok: true };
  }

  return { receive, deliver, deliverDue, list, redeliver, endpointSecrets };
}

export type StripeForwarder = ReturnType<typeof stripeForwarder>;
