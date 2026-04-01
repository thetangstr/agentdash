import type { Db } from "@agentdash/db";
import { companies } from "@agentdash/db";
import { eq, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { crmService } from "./crm.js";
import { logger } from "../middleware/logger.js";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

interface HubSpotConfig {
  accessToken: string;
  portalId: string;
  syncEnabled: boolean;
  clientSecret?: string;
}

interface SyncResult {
  synced: number;
  created: number;
  updated: number;
  errors: number;
}

interface HubSpotSyncStatus {
  lastSyncAt: string | null;
  lastSyncResult: {
    contacts: SyncResult;
    companies: SyncResult;
    deals: SyncResult;
    activities: SyncResult;
  } | null;
  lastSyncError: string | null;
  syncInProgress: boolean;
}

async function hubspotFetch(path: string, accessToken: string): Promise<any> {
  const res = await fetch(`${HUBSPOT_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API error ${res.status}: ${text}`);
  }
  return res.json();
}

export function hubspotService(db: Db) {
  const crm = crmService(db);

  // ── Metadata helpers ──────────────────────────────────────────────────

  async function getMetadata(companyId: string): Promise<Record<string, unknown>> {
    const company = await db
      .select({ metadata: companies.metadata })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return (company?.metadata as Record<string, unknown>) ?? {};
  }

  async function updateHubspotMeta(companyId: string, patch: Record<string, unknown>) {
    const meta = await getMetadata(companyId);
    const existing = (meta.hubspot as Record<string, unknown>) ?? {};
    const updatedMeta = { ...meta, hubspot: { ...existing, ...patch } };
    await db
      .update(companies)
      .set({ metadata: updatedMeta } as any)
      .where(eq(companies.id, companyId));
  }

  // ── Config ────────────────────────────────────────────────────────────

  async function getConfig(companyId: string): Promise<HubSpotConfig | null> {
    const meta = await getMetadata(companyId);
    const hs = meta.hubspot as Record<string, unknown> | undefined;
    if (!hs?.accessToken) return null;
    return {
      accessToken: String(hs.accessToken),
      portalId: String(hs.portalId ?? ""),
      syncEnabled: hs.syncEnabled !== false,
      clientSecret: hs.clientSecret ? String(hs.clientSecret) : undefined,
    };
  }

  async function setConfig(
    companyId: string,
    config: { accessToken: string; portalId?: string; syncEnabled?: boolean; clientSecret?: string },
  ): Promise<void> {
    const meta = await getMetadata(companyId);
    const existing = (meta.hubspot as Record<string, unknown>) ?? {};
    const updatedMeta = {
      ...meta,
      hubspot: {
        ...existing,
        accessToken: config.accessToken,
        portalId: config.portalId ?? "",
        syncEnabled: config.syncEnabled ?? true,
        ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
      },
    };
    await db
      .update(companies)
      .set({ metadata: updatedMeta } as any)
      .where(eq(companies.id, companyId));
  }

  // ── Sync Status ─────────────────────────────────────────────────────

  async function getSyncStatus(companyId: string): Promise<HubSpotSyncStatus> {
    const meta = await getMetadata(companyId);
    const hs = (meta.hubspot as Record<string, unknown>) ?? {};
    return {
      lastSyncAt: hs.lastSyncAt ? String(hs.lastSyncAt) : null,
      lastSyncResult: (hs.lastSyncResult as HubSpotSyncStatus["lastSyncResult"]) ?? null,
      lastSyncError: hs.lastSyncError ? String(hs.lastSyncError) : null,
      syncInProgress: hs.syncInProgress === true,
    };
  }

  // ── Test Connection ─────────────────────────────────────────────────

  async function testConnection(companyId: string): Promise<{ ok: boolean; error?: string }> {
    const config = await getConfig(companyId);
    if (!config) return { ok: false, error: "HubSpot not configured" };
    try {
      await hubspotFetch("/crm/v3/objects/contacts?limit=1", config.accessToken);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
    }
  }

  // ── Sync: Contacts ────────────────────────────────────────────────────

  async function syncContacts(companyId: string): Promise<SyncResult> {
    const config = await getConfig(companyId);
    if (!config) throw new Error("HubSpot not configured for this company");

    const result: SyncResult = { synced: 0, created: 0, updated: 0, errors: 0 };
    let after: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: "100",
        properties: "firstname,lastname,email,phone,jobtitle,company",
      });
      if (after) params.set("after", after);

      const data = await hubspotFetch(`/crm/v3/objects/contacts?${params}`, config.accessToken);

      for (const contact of data.results ?? []) {
        try {
          const props = contact.properties ?? {};
          await crm.upsertContactByExternalId(companyId, "hubspot", String(contact.id), {
            firstName: props.firstname ?? null,
            lastName: props.lastname ?? null,
            email: props.email ?? null,
            phone: props.phone ?? null,
            title: props.jobtitle ?? null,
          });
          result.synced++;
        } catch (err) {
          result.errors++;
          logger.warn({ err, contactId: contact.id }, "Failed to sync HubSpot contact");
        }
      }

      after = data.paging?.next?.after;
      hasMore = !!after;
    }

    return result;
  }

  // ── Sync: Companies → Accounts ────────────────────────────────────────

  async function syncCompanies(companyId: string): Promise<SyncResult> {
    const config = await getConfig(companyId);
    if (!config) throw new Error("HubSpot not configured for this company");

    const result: SyncResult = { synced: 0, created: 0, updated: 0, errors: 0 };
    let after: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: "100",
        properties: "name,domain,industry,numberofemployees",
      });
      if (after) params.set("after", after);

      const data = await hubspotFetch(`/crm/v3/objects/companies?${params}`, config.accessToken);

      for (const company of data.results ?? []) {
        try {
          const props = company.properties ?? {};
          await crm.upsertByExternalId(companyId, "hubspot", String(company.id), {
            name: props.name ?? "Unknown",
            domain: props.domain ?? null,
            industry: props.industry ?? null,
            size: props.numberofemployees ?? null,
          });
          result.synced++;
        } catch (err) {
          result.errors++;
          logger.warn({ err, hubspotCompanyId: company.id }, "Failed to sync HubSpot company");
        }
      }

      after = data.paging?.next?.after;
      hasMore = !!after;
    }

    return result;
  }

  // ── Sync: Deals ───────────────────────────────────────────────────────

  async function syncDeals(companyId: string): Promise<SyncResult> {
    const config = await getConfig(companyId);
    if (!config) throw new Error("HubSpot not configured for this company");

    const result: SyncResult = { synced: 0, created: 0, updated: 0, errors: 0 };
    let after: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: "100",
        properties: "dealname,dealstage,amount,closedate,pipeline",
      });
      if (after) params.set("after", after);

      const data = await hubspotFetch(`/crm/v3/objects/deals?${params}`, config.accessToken);

      for (const deal of data.results ?? []) {
        try {
          const props = deal.properties ?? {};
          const amountCents = props.amount ? String(Math.round(Number(props.amount) * 100)) : null;
          await crm.upsertDealByExternalId(companyId, "hubspot", String(deal.id), {
            name: props.dealname ?? "Untitled Deal",
            stage: props.dealstage ?? null,
            amountCents,
            closeDate: props.closedate ? new Date(props.closedate) : null,
          });
          result.synced++;
        } catch (err) {
          result.errors++;
          logger.warn({ err, dealId: deal.id }, "Failed to sync HubSpot deal");
        }
      }

      after = data.paging?.next?.after;
      hasMore = !!after;
    }

    return result;
  }

  // ── Sync: Activities (notes, calls, emails) ─────────────────────────

  async function syncActivities(companyId: string): Promise<SyncResult> {
    const config = await getConfig(companyId);
    if (!config) throw new Error("HubSpot not configured for this company");

    const result: SyncResult = { synced: 0, created: 0, updated: 0, errors: 0 };

    const objectTypes = [
      { type: "notes", activityType: "note", subjectProp: null, bodyProp: "hs_note_body", timeProp: "hs_timestamp", properties: "hs_note_body,hs_timestamp" },
      { type: "calls", activityType: "call", subjectProp: "hs_call_title", bodyProp: "hs_call_body", timeProp: "hs_timestamp", properties: "hs_call_title,hs_call_body,hs_timestamp" },
      { type: "emails", activityType: "email", subjectProp: "hs_email_subject", bodyProp: "hs_email_text", timeProp: "hs_timestamp", properties: "hs_email_subject,hs_email_text,hs_timestamp" },
    ];

    for (const objType of objectTypes) {
      let after: string | undefined;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          limit: "100",
          properties: objType.properties,
        });
        if (after) params.set("after", after);

        try {
          const data = await hubspotFetch(`/crm/v3/objects/${objType.type}?${params}`, config.accessToken);

          for (const item of data.results ?? []) {
            try {
              const props = item.properties ?? {};
              const subject = objType.subjectProp ? (props[objType.subjectProp] ?? null) : null;
              const body = objType.bodyProp ? (props[objType.bodyProp] ?? null) : null;
              const occurredAt = props[objType.timeProp] ? new Date(props[objType.timeProp]) : new Date();

              await crm.upsertActivityByExternalId(companyId, "hubspot", String(item.id), {
                activityType: objType.activityType,
                subject,
                body,
                occurredAt,
              });
              result.synced++;
            } catch (err) {
              result.errors++;
              logger.warn({ err, objectId: item.id, type: objType.type }, "Failed to sync HubSpot activity");
            }
          }

          after = data.paging?.next?.after;
          hasMore = !!after;
        } catch (err) {
          // Some HubSpot accounts may not have all object types enabled
          logger.warn({ err, type: objType.type }, "Failed to fetch HubSpot activities of type");
          hasMore = false;
        }
      }
    }

    return result;
  }

  // ── Sync All ──────────────────────────────────────────────────────────

  async function syncAll(companyId: string) {
    await updateHubspotMeta(companyId, { syncInProgress: true, lastSyncError: null });

    try {
      const [contactsResult, companiesResult, dealsResult, activitiesResult] = await Promise.all([
        syncContacts(companyId),
        syncCompanies(companyId),
        syncDeals(companyId),
        syncActivities(companyId),
      ]);

      const syncResult = {
        contacts: contactsResult,
        companies: companiesResult,
        deals: dealsResult,
        activities: activitiesResult,
        totalSynced:
          contactsResult.synced + companiesResult.synced + dealsResult.synced + activitiesResult.synced,
        totalErrors:
          contactsResult.errors + companiesResult.errors + dealsResult.errors + activitiesResult.errors,
      };

      await updateHubspotMeta(companyId, {
        syncInProgress: false,
        lastSyncAt: new Date().toISOString(),
        lastSyncResult: {
          contacts: contactsResult,
          companies: companiesResult,
          deals: dealsResult,
          activities: activitiesResult,
        },
        lastSyncError: null,
      });

      return syncResult;
    } catch (err) {
      await updateHubspotMeta(companyId, {
        syncInProgress: false,
        lastSyncError: err instanceof Error ? err.message : "Unknown error",
      });
      throw err;
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────────

  async function findCompanyByPortalId(portalId: string): Promise<string | null> {
    const rows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(sql`${companies.metadata}->'hubspot'->>'portalId' = ${portalId}`)
      .limit(1);
    return rows[0]?.id ?? null;
  }

  function verifyWebhookSignature(
    clientSecret: string,
    requestBody: string,
    signatureHeader: string,
    httpMethod: string,
    requestUri: string,
    timestamp: string,
  ): boolean {
    // HubSpot v3: HMAC-SHA256(clientSecret, method + URI + body + timestamp)
    const message = httpMethod + requestUri + requestBody + timestamp;
    const hash = createHmac("sha256", clientSecret).update(message).digest("hex");
    const hashBuf = Buffer.from(hash, "utf8");
    const sigBuf = Buffer.from(signatureHeader, "utf8");
    if (hashBuf.length !== sigBuf.length) return false;
    return timingSafeEqual(hashBuf, sigBuf);
  }

  async function handleWebhook(companyId: string, events: Array<Record<string, unknown>>) {
    for (const event of events) {
      const objectType = String(event.objectType ?? "").toLowerCase();
      const eventType = String(event.subscriptionType ?? "");

      try {
        if (objectType === "contact" && (eventType.includes("creation") || eventType.includes("propertyChange"))) {
          await syncContacts(companyId);
        } else if (objectType === "company" && (eventType.includes("creation") || eventType.includes("propertyChange"))) {
          await syncCompanies(companyId);
        } else if (objectType === "deal" && (eventType.includes("creation") || eventType.includes("propertyChange"))) {
          await syncDeals(companyId);
        }
      } catch (err) {
        logger.warn({ err, event }, "Failed to handle HubSpot webhook event");
      }
    }
  }

  return {
    getConfig,
    setConfig,
    getSyncStatus,
    testConnection,
    syncContacts,
    syncCompanies,
    syncDeals,
    syncActivities,
    syncAll,
    findCompanyByPortalId,
    verifyWebhookSignature,
    handleWebhook,
  };
}
