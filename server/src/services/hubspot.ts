import type { Db } from "@agentdash/db";
import { companies } from "@agentdash/db";
import { eq } from "drizzle-orm";
import { crmService } from "./crm.js";
import { logger } from "../middleware/logger.js";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

interface HubSpotConfig {
  accessToken: string;
  portalId: string;
  syncEnabled: boolean;
}

interface SyncResult {
  synced: number;
  created: number;
  updated: number;
  errors: number;
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

  // ── Config ────────────────────────────────────────────────────────────

  async function getConfig(companyId: string): Promise<HubSpotConfig | null> {
    const company = await db
      .select({ metadata: companies.metadata })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company?.metadata) return null;
    const meta = company.metadata as Record<string, unknown>;
    const hs = meta.hubspot as Record<string, unknown> | undefined;
    if (!hs?.accessToken) return null;
    return {
      accessToken: String(hs.accessToken),
      portalId: String(hs.portalId ?? ""),
      syncEnabled: hs.syncEnabled !== false,
    };
  }

  async function setConfig(
    companyId: string,
    config: { accessToken: string; portalId?: string; syncEnabled?: boolean },
  ): Promise<void> {
    const company = await db
      .select({ metadata: companies.metadata })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    const existingMeta = (company?.metadata as Record<string, unknown>) ?? {};
    const updatedMeta = {
      ...existingMeta,
      hubspot: {
        accessToken: config.accessToken,
        portalId: config.portalId ?? "",
        syncEnabled: config.syncEnabled ?? true,
      },
    };
    await db
      .update(companies)
      .set({ metadata: updatedMeta } as any)
      .where(eq(companies.id, companyId));
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

  // ── Sync All ──────────────────────────────────────────────────────────

  async function syncAll(companyId: string) {
    const [contactsResult, companiesResult, dealsResult] = await Promise.all([
      syncContacts(companyId),
      syncCompanies(companyId),
      syncDeals(companyId),
    ]);

    return {
      contacts: contactsResult,
      companies: companiesResult,
      deals: dealsResult,
      totalSynced: contactsResult.synced + companiesResult.synced + dealsResult.synced,
      totalErrors: contactsResult.errors + companiesResult.errors + dealsResult.errors,
    };
  }

  // ── Webhook ───────────────────────────────────────────────────────────

  async function handleWebhook(companyId: string, events: Array<Record<string, unknown>>) {
    for (const event of events) {
      const objectType = String(event.objectType ?? "").toLowerCase();
      const eventType = String(event.subscriptionType ?? "");

      try {
        if (objectType === "contact" && eventType.includes("creation") || eventType.includes("propertyChange")) {
          await syncContacts(companyId);
        } else if (objectType === "company") {
          await syncCompanies(companyId);
        } else if (objectType === "deal") {
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
    syncContacts,
    syncCompanies,
    syncDeals,
    syncAll,
    handleWebhook,
  };
}
