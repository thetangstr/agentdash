// AgentDash (SC-8, GH #769): the Stripe variables every box gets (spec §3.7)
// and the fleet-wide sync behind `admin stripe rotate-box-key`.
//
//   STRIPE_SECRET_KEY      the ONE shared restricted key (rk_…), from fleet_secrets
//   STRIPE_WEBHOOK_SECRET  the box's OWN secret; the control plane keeps it
//                          encrypted to re-sign forwarded events
//   STRIPE_PRO_PRICE_ID    the Pro per-seat price
//   STRIPE_TRIAL_DAYS      14
//
// A box records which fleet billing config it holds in boxes.stripe_config_rev
// (`k<key version>.<price>.<trial days>`). The sync upserts every box whose
// rev differs, one Railway variables upsert per box, recording the rev only
// after Railway accepted it: a run that stops part-way is resumed by running
// it again. Nothing secret reaches a log, an event, an error or a response.
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, or, ne } from "drizzle-orm";
import { decryptField, encryptField, type DataKeyring } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { redactString } from "../logger.js";
import type { RailwayClient } from "../railway/client.js";
import type { BoxRow } from "../jobs/runner.js";
import { type BillingConfig, checkBoxStripeKey } from "./config.js";
import { BOX_STRIPE_KEY, type FleetSecretStore } from "./fleet-secrets.js";

export const WEBHOOK_SECRET_AAD = "boxes.stripe_webhook_secret_enc";
/** Boxes that hold (or are about to hold) a running web service. */
export const BILLING_SYNC_STATES = ["provisioning", "awaiting_claim", "active", "suspended"] as const;

/** A box's own webhook signing secret. Stripe's format; constructEvent uses the whole string as the HMAC key. */
export function newBoxWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export interface FleetBilling {
  secretKey: string;
  keyVersion: number;
  priceId: string;
  trialDays: number;
  rev: string;
}

export function billingRev(keyVersion: number, priceId: string, trialDays: number): string {
  return `k${keyVersion}.${priceId}.${trialDays}`;
}

/** The fleet's billing config, or null (with the reason) while it is incomplete. */
export async function currentFleetBilling(store: FleetSecretStore, cfg: BillingConfig): Promise<{ billing: FleetBilling | null; missing: string[] }> {
  const missing: string[] = [];
  const key = await store.reveal(BOX_STRIPE_KEY);
  if (!key) missing.push("the shared box key (run `admin stripe rotate-box-key --apply`)");
  if (!cfg.stripeProPriceId) missing.push("CLOUD_STRIPE_PRO_PRICE_ID");
  if (!key || !cfg.stripeProPriceId) return { billing: null, missing };
  return {
    billing: {
      secretKey: key.value,
      keyVersion: key.version,
      priceId: cfg.stripeProPriceId,
      trialDays: cfg.stripeTrialDays,
      rev: billingRev(key.version, cfg.stripeProPriceId, cfg.stripeTrialDays),
    },
    missing,
  };
}

/** The box's webhook secret, generated and stored (encrypted) first if it has none. */
export async function ensureBoxWebhookSecret(db: CloudDb, keys: DataKeyring, box: Pick<BoxRow, "id" | "stripeWebhookSecretEnc">): Promise<string> {
  if (box.stripeWebhookSecretEnc) return decryptField(keys, box.stripeWebhookSecretEnc, WEBHOOK_SECRET_AAD);
  const fresh = newBoxWebhookSecret();
  const won = await db
    .update(boxes)
    .set({ stripeWebhookSecretEnc: encryptField(keys, fresh, WEBHOOK_SECRET_AAD), updatedAt: new Date() })
    .where(and(eq(boxes.id, box.id), isNull(boxes.stripeWebhookSecretEnc)))
    .returning({ id: boxes.id });
  if (won.length) return fresh;
  // Another writer stored one first: use theirs.
  const [row] = await db.select({ enc: boxes.stripeWebhookSecretEnc }).from(boxes).where(eq(boxes.id, box.id));
  if (!row?.enc) throw new Error("the box's webhook secret could not be stored");
  return decryptField(keys, row.enc, WEBHOOK_SECRET_AAD);
}

export function stripeVariables(fleet: FleetBilling, webhookSecret: string): Record<string, string> {
  return {
    STRIPE_SECRET_KEY: fleet.secretKey,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_PRO_PRICE_ID: fleet.priceId,
    STRIPE_TRIAL_DAYS: String(fleet.trialDays),
  };
}

/**
 * Railway's variables upsert. skipDeploys true (the default everywhere else)
 * means the values take effect at the box's next deploy; false redeploys it
 * now (a short outage on a Volume service).
 */
export async function upsertBoxVariables(
  client: RailwayClient,
  ids: { projectId: string; environmentId: string; serviceId: string },
  variables: Record<string, string>,
  opts: { skipDeploys: boolean; signal?: AbortSignal },
): Promise<void> {
  await client.request(
    "variableCollectionUpsert",
    `mutation($i:VariableCollectionUpsertInput!){ variableCollectionUpsert(input:$i) }`,
    { i: { projectId: ids.projectId, environmentId: ids.environmentId, serviceId: ids.serviceId, variables, skipDeploys: opts.skipDeploys } },
    { signal: opts.signal },
  );
}

export class BoxKeyRotationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "BoxKeyRotationError";
  }
}

export interface SyncInput {
  /** The new shared key from stdin; absent to resume (or converge price/trial changes) with the stored key. */
  newKey?: string | null;
  /** False (the default) is a dry run: nothing is stored or sent. */
  apply: boolean;
  /** Redeploy each box so the change takes effect now (default: at its next deploy). */
  redeploy?: boolean;
  actor: string;
  ip?: string | null;
}

export interface SyncDeps {
  db: CloudDb;
  keys: DataKeyring;
  billing: BillingConfig;
  store: FleetSecretStore;
  /** Absent without a Railway token: only a dry run is possible. */
  client: RailwayClient | null;
  log: Logger;
  signal?: AbortSignal;
}

export interface SyncResult {
  dryRun: boolean;
  mode: BillingConfig["stripeMode"];
  key: "new" | "unchanged" | "not_given";
  keyVersion: number | null;
  targetRev: string | null;
  redeploy: boolean;
  boxes: Array<{ slug: string; state: string; from: string | null; outcome: "would_update" | "updated" | "failed"; error?: string }>;
  updated: number;
  failed: number;
  /** Boxes still behind after this run; re-run with --apply to resume. */
  remaining: number;
}

/** Plan (dry run) or apply the shared key and billing variables across the fleet. */
export async function syncFleetBilling(deps: SyncDeps, input: SyncInput): Promise<SyncResult> {
  const { db, billing: cfg, store } = deps;
  let keyState: SyncResult["key"] = "not_given";
  if (input.newKey !== undefined && input.newKey !== null) {
    const key = input.newKey.trim();
    const bad = checkBoxStripeKey(key, cfg.stripeMode);
    if (bad) throw new BoxKeyRotationError(`the new key ${bad}`);
    keyState = (await store.matches(BOX_STRIPE_KEY, key)) ? "unchanged" : "new";
    if (input.apply && keyState === "new") await store.set(BOX_STRIPE_KEY, key, input.actor, input.ip ?? null);
  }
  if (!cfg.stripeProPriceId) throw new BoxKeyRotationError("CLOUD_STRIPE_PRO_PRICE_ID is not set on the control plane", 409);
  const info = await store.info(BOX_STRIPE_KEY);
  // In a dry run with a new key, the target is the version the apply would create.
  const targetVersion = keyState === "new" && !input.apply ? (info?.version ?? 0) + 1 : info?.version ?? null;
  if (targetVersion === null) throw new BoxKeyRotationError("no shared box key is stored yet; pipe one in: `admin stripe rotate-box-key --apply < key`", 409);
  const targetRev = billingRev(targetVersion, cfg.stripeProPriceId, cfg.stripeTrialDays);
  const redeploy = input.redeploy === true;

  const targets = await db
    .select()
    .from(boxes)
    .where(
      and(
        inArray(boxes.state, [...BILLING_SYNC_STATES]),
        isNotNull(boxes.projectId),
        isNotNull(boxes.environmentId),
        isNotNull(boxes.webServiceId),
        or(isNull(boxes.stripeConfigRev), ne(boxes.stripeConfigRev, targetRev)),
      ),
    )
    .orderBy(boxes.createdAt);

  const result: SyncResult = { dryRun: !input.apply, mode: cfg.stripeMode, key: keyState, keyVersion: targetVersion, targetRev, redeploy, boxes: [], updated: 0, failed: 0, remaining: targets.length };
  if (!input.apply) {
    result.boxes = targets.map((b) => ({ slug: b.slug, state: b.state, from: b.stripeConfigRev, outcome: "would_update" as const }));
    return result;
  }
  if (!deps.client) throw new BoxKeyRotationError("no Railway token is configured on the control plane; only a dry run is possible", 409);
  const { billing: fleet } = await currentFleetBilling(store, cfg);
  if (!fleet || fleet.rev !== targetRev) throw new BoxKeyRotationError("the shared key changed during this run; run it again", 409);

  for (const box of targets) {
    try {
      const webhookSecret = await ensureBoxWebhookSecret(db, deps.keys, box);
      const vars = stripeVariables(fleet, webhookSecret);
      await upsertBoxVariables(
        deps.client,
        { projectId: box.projectId!, environmentId: box.environmentId!, serviceId: box.webServiceId! },
        vars,
        { skipDeploys: !redeploy, signal: deps.signal },
      );
      await db.update(boxes).set({ stripeConfigRev: fleet.rev, updatedAt: new Date() }).where(eq(boxes.id, box.id));
      await db.insert(boxEvents).values({
        boxId: box.id,
        kind: "billing_variables_synced",
        actor: input.actor,
        detail: { rev: fleet.rev, from: box.stripeConfigRev, names: Object.keys(vars).sort(), redeploy },
      });
      result.boxes.push({ slug: box.slug, state: box.state, from: box.stripeConfigRev, outcome: "updated" });
      result.updated += 1;
    } catch (err) {
      const error = redactString(err instanceof Error ? err.message : String(err)).slice(0, 300);
      deps.log.warn("billing variables sync failed for a box", { slug: box.slug, error });
      result.boxes.push({ slug: box.slug, state: box.state, from: box.stripeConfigRev, outcome: "failed", error });
      result.failed += 1;
    }
  }
  result.remaining = result.failed;
  deps.log.info("fleet billing sync", { rev: fleet.rev, updated: result.updated, failed: result.failed, redeploy });
  return result;
}
