// AgentDash (SC-8): explicit guarded operations only; no provider writes at boot.
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { CloudConfig } from "../config.js";
import { encryptField } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes, cloudBilling } from "../db/schema.js";
import { getProject, upsertVariables, variableNames } from "../railway/api.js";
import type { RailwayClient } from "../railway/client.js";
import { assertBoxProjectName, boxProjectName, projectTag } from "../railway/names.js";
import type { Secret } from "../secret.js";
import { STRIPE_EVENTS, stripeRequest } from "./stripe.js";

export function restrictedBoxKey(value: string): boolean { return /^rk_(test|live)_[A-Za-z0-9]{8,}$/.test(value); }

export async function configureStripeEndpoint(db: CloudDb, config: CloudConfig, opts: { fetch?: typeof fetch } = {}) {
  const controlKey = config.billing?.controlKey;
  if (!controlKey) throw new Error("Stripe control key not configured");
  const url = `${config.frontDoor.siteUrl}/api/cloud/stripe/webhook`;
  if (new URL(url).protocol !== "https:") throw new Error("Stripe endpoint requires public HTTPS");
  await db.insert(cloudBilling).values({ id: "cloud" }).onConflictDoNothing();
  return db.transaction(async (tx) => {
    const [state] = await tx.select().from(cloudBilling).where(eq(cloudBilling.id, "cloud")).for("update");
    if (state.stripeEndpointId && state.stripeEndpointSecretEnc) {
      if (state.stripeEndpointUrl !== url) throw new Error("Stripe endpoint URL changed; operator migration required");
      return { id: state.stripeEndpointId, url, existing: true };
    }
    type Endpoint = { id: string; url: string; secret?: string };
    const matching: Endpoint[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await stripeRequest<{ data: Endpoint[]; has_more: boolean }>(controlKey, `webhook_endpoints?limit=100${after ? `&starting_after=${after}` : ""}`, opts);
      if (!Array.isArray(result.data) || result.data.some((e) => !/^we_[A-Za-z0-9_]+$/.test(e.id))) throw new Error("Stripe endpoint listing invalid");
      matching.push(...result.data.filter((e) => e.url === url));
      if (!result.has_more) break;
      const next = result.data.at(-1)?.id;
      if (!next || next === after || page === 99) throw new Error("Stripe endpoint pagination invalid");
      after = next;
    }
    if (matching.length > 1) throw new Error("multiple Stripe endpoints require operator recovery");
    let endpoint: Endpoint;
    if (matching.length) {
      // Creation-only secrets cannot be recovered by GET. Refuse a duplicate
      // after a crash; an operator can supply the saved signing secret.
      if (!config.billing?.webhookSecret) throw new Error("existing Stripe endpoint requires saved CLOUD_STRIPE_WEBHOOK_SECRET");
      endpoint = { ...matching[0], secret: config.billing.webhookSecret.reveal() };
    } else {
      const body = new URLSearchParams({ url, description: "AgentDash cloud-control signed box fanout" });
      STRIPE_EVENTS.forEach((event, index) => body.set(`enabled_events[${index}]`, event));
      endpoint = await stripeRequest<Endpoint>(controlKey, "webhook_endpoints", { ...opts, method: "POST", body, idempotencyKey: `agentdash-cloud-webhook-${createHash("sha256").update(url).digest("hex")}` });
    }
    if (!/^we_[A-Za-z0-9_]+$/.test(endpoint.id) || endpoint.url !== url || !endpoint.secret?.startsWith("whsec_")) throw new Error("Stripe endpoint response invalid");
    try { await tx.update(cloudBilling).set({ stripeEndpointId: endpoint.id, stripeEndpointUrl: url, stripeEndpointSecretEnc: encryptField(config.dataKeys, endpoint.secret, "cloud_billing.stripe_endpoint_secret_enc"), updatedAt: new Date() }).where(eq(cloudBilling.id, "cloud")); }
    catch { throw new Error("Stripe endpoint credential persistence failed"); }
    await tx.insert(boxEvents).values({ kind: "stripe_endpoint_configured", actor: "admin-cli", detail: { endpointId: endpoint.id, url } });
    return { id: endpoint.id, url, existing: Boolean(matching.length) };
  });
}

export async function rotateBoxKey(db: CloudDb, config: CloudConfig, client: RailwayClient, workspaceId: string, key: Secret) {
  if (!restrictedBoxKey(key.reveal())) throw new Error("one Stripe restricted key required");
  await db.insert(cloudBilling).values({ id: "cloud" }).onConflictDoNothing();
  // Commit the future-provisioning source BEFORE touching the fleet. A failed
  // upsert leaves a durable source for an idempotent retry, never a job payload.
  const generation = encryptField(config.dataKeys, key.reveal(), "cloud_billing.stripe_box_key_enc");
  try { await db.update(cloudBilling).set({ stripeBoxKeyEnc: generation, updatedAt: new Date() }).where(eq(cloudBilling.id, "cloud")); }
  catch { throw new Error("Stripe box credential persistence failed"); }
  const fleet = await db.select().from(boxes).where(inArray(boxes.state, ["provisioning", "awaiting_claim", "active", "suspended"]));
  const updated: string[] = [], skipped: string[] = [], failed: Array<{ slug: string; reason: string }> = [];
  for (const box of fleet) {
    if (!box.projectId || !box.environmentId || !box.webServiceId) { skipped.push(box.slug); continue; }
    try {
      const project = await getProject(client, box.projectId);
      assertBoxProjectName(project.name);
      if (project.workspaceId !== workspaceId || project.id !== box.projectId || project.name !== boxProjectName(box.slug) || !(project.description ?? "").includes(projectTag(box.id)) || !project.environments.some((e) => e.id === box.environmentId) || !project.services.some((s) => s.id === box.webServiceId)) throw new Error();
      await variableNames(client, box.projectId, box.environmentId, box.webServiceId);
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(cloudBilling).where(eq(cloudBilling.id, "cloud")).for("update");
        if (current.stripeBoxKeyEnc !== generation) throw new Error("rotation superseded");
        await upsertVariables(client, box.projectId!, box.environmentId!, box.webServiceId!, { STRIPE_SECRET_KEY: key.reveal() });
      });
      updated.push(box.slug);
    } catch { failed.push({ slug: box.slug, reason: "guard_or_variable_update_failed" }); }
  }
  await db.insert(boxEvents).values({ kind: "stripe_box_key_rotated", actor: "admin-cli", detail: { updated: updated.length, skipped: skipped.length, failed: failed.length } });
  return { updated, skipped, failed, deploymentRequired: true };
}
