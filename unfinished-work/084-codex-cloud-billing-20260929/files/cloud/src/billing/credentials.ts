// AgentDash (SC-8): encrypt before Railway writes, so a crash can resume with the same keys.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { CloudConfig } from "../config.js";
import { decryptField, encryptField } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes, cloudBilling } from "../db/schema.js";
import { Secret } from "../secret.js";
import { resendClient } from "./resend.js";
import { upsertVariables } from "../railway/api.js";
import type { RailwayClient } from "../railway/client.js";

export function assertBillingProvisioning(config: CloudConfig): void {
  const billing = config.billing;
  if (!billing?.controlKey || !billing.boxKey || !billing.priceIds.STRIPE_PRO_PRICE_ID || !billing.resendManagementKey || !billing.resendDomainId) {
    throw new Error("SC-8 billing provisioning requires Stripe restricted keys, Pro price, and Resend management key/domain");
  }
}

/** Refresh the fleet key under the rotation lock immediately before the external write. */
export async function upsertBillingVariables(db: CloudDb, config: CloudConfig, client: RailwayClient, target: { projectId: string; environmentId: string; serviceId: string }, variables: Record<string, string>, signal?: AbortSignal): Promise<void> {
  await db.insert(cloudBilling).values({ id: "cloud" }).onConflictDoNothing();
  await db.transaction(async (tx) => {
    const [state] = await tx.select().from(cloudBilling).where(eq(cloudBilling.id, "cloud")).for("update");
    const key = state.stripeBoxKeyEnc ? decryptField(config.dataKeys, state.stripeBoxKeyEnc, "cloud_billing.stripe_box_key_enc") : config.billing?.boxKey?.reveal();
    if (!key) throw new Error("Stripe box key not configured");
    await upsertVariables(client, target.projectId, target.environmentId, target.serviceId, { ...variables, STRIPE_SECRET_KEY: key }, { signal });
  });
}

export async function billingVariables(db: CloudDb, boxId: string, config: CloudConfig, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<Record<string, string>> {
  assertBillingProvisioning(config);
  const billing = config.billing!;
  return db.transaction(async (tx) => {
    const [box] = await tx.select().from(boxes).where(eq(boxes.id, boxId)).for("update");
    if (!box || ["cleanup", "deleted", "pending_delete"].includes(box.state)) throw new Error("box credential creation refused");
    const stripeSecret = box.stripeWebhookSecretEnc ? decryptField(config.dataKeys, box.stripeWebhookSecretEnc, "boxes.stripe_webhook_secret_enc") : `whsec_${randomBytes(32).toString("hex")}`;
    let resendToken: string;
    if (box.resendApiKeyId && box.resendApiKeyEnc) {
      resendToken = decryptField(config.dataKeys, box.resendApiKeyEnc, "boxes.resend_api_key_enc");
    } else {
      if (box.resendApiKeyId || box.resendApiKeyEnc) throw new Error("box mail credential incomplete; operator recovery required");
      const client = resendClient(billing.resendManagementKey!, opts);
      await client.verifyDomain(billing.resendDomainId!);
      // A create may succeed just before a process dies. Tokens cannot be read
      // back: revoke only this UUID's stable-name orphans, then create again.
      const name = `agentdash-box-${box.id}`;
      for (const orphan of (await client.list()).filter((key) => key.name === name)) await client.revoke(orphan.id);
      const created = await client.create(name, billing.resendDomainId!);
      resendToken = created.token;
      try { await tx.update(boxes).set({ resendApiKeyId: created.id, resendApiKeyEnc: encryptField(config.dataKeys, resendToken, "boxes.resend_api_key_enc"), updatedAt: new Date() }).where(eq(boxes.id, box.id)); }
      catch { throw new Error("box mail credential persistence failed"); }
      await tx.insert(boxEvents).values({ boxId: box.id, kind: "mail_key_created", actor: "provisioner", detail: { providerId: created.id } });
    }
    if (!box.stripeWebhookSecretEnc) {
      try { await tx.update(boxes).set({ stripeWebhookSecretEnc: encryptField(config.dataKeys, stripeSecret, "boxes.stripe_webhook_secret_enc"), updatedAt: new Date() }).where(eq(boxes.id, box.id)); }
      catch { throw new Error("box webhook credential persistence failed"); }
    }
    const [state] = await tx.select().from(cloudBilling).where(eq(cloudBilling.id, "cloud"));
    const sharedKey = state?.stripeBoxKeyEnc ? new Secret(decryptField(config.dataKeys, state.stripeBoxKeyEnc, "cloud_billing.stripe_box_key_enc")) : billing.boxKey!;
    return { STRIPE_SECRET_KEY: sharedKey.reveal(), STRIPE_WEBHOOK_SECRET: stripeSecret, ...billing.priceIds, STRIPE_TRIAL_DAYS: "14", AGENTDASH_FREE_AGENT_CAP: "2", RESEND_API_KEY: resendToken, AGENTDASH_EMAIL_FROM: "AgentDash <no-reply@mail.agentdash.cloud>" };
  });
}

/** Called only AFTER the existing guarded project deletion step succeeds. */
export async function revokeBoxMail(db: CloudDb, boxId: string, config: CloudConfig, opts: { fetch?: typeof fetch; signal?: AbortSignal; requireCleanup?: boolean } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    const [box] = await tx.select().from(boxes).where(eq(boxes.id, boxId)).for("update");
    if (!box) throw new Error("box not found");
    if (opts.requireCleanup && (box.state !== "cleanup" || box.claimedAt)) throw new Error("box mail revocation requires unclaimed cleanup state");
    if (!config.billing?.resendManagementKey) {
      if (box.resendApiKeyId || box.resendApiKeyEnc) throw new Error("Resend management key required for revocation");
      return;
    }
    const client = resendClient(config.billing.resendManagementKey, opts);
    // Also recover a provider create that never reached the DB before failure.
    const ids = new Set((await client.list()).filter((key) => key.name === `agentdash-box-${box.id}`).map((key) => key.id));
    if (box.resendApiKeyId) ids.add(box.resendApiKeyId);
    for (const id of ids) await client.revoke(id);
    if (ids.size || box.resendApiKeyEnc) {
      await tx.update(boxes).set({ resendApiKeyId: null, resendApiKeyEnc: null, updatedAt: new Date() }).where(eq(boxes.id, box.id));
      await tx.insert(boxEvents).values({ boxId: box.id, kind: "mail_keys_revoked", actor: "delete-job", detail: { count: ids.size } });
    }
  });
}
