import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  crmAccounts,
  crmContacts,
  crmDeals,
  crmActivities,
  crmLeads,
  crmPartners,
} from "@paperclipai/db";
import { notFound } from "../errors.js";

export function crmService(db: Db) {
  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  async function listAccounts(
    companyId: string,
    opts?: {
      limit?: number;
      offset?: number;
      accountId?: string;
      stage?: string;
      ownerAgentId?: string;
    },
  ) {
    const conditions = [eq(crmAccounts.companyId, companyId)];
    if (opts?.stage) conditions.push(eq(crmAccounts.stage, opts.stage));
    if (opts?.ownerAgentId)
      conditions.push(eq(crmAccounts.ownerAgentId, opts.ownerAgentId));

    return db
      .select()
      .from(crmAccounts)
      .where(and(...conditions))
      .orderBy(desc(crmAccounts.createdAt))
      .limit(opts?.limit ?? 50)
      .offset(opts?.offset ?? 0);
  }

  async function getAccountById(id: string) {
    const row = await db
      .select()
      .from(crmAccounts)
      .where(eq(crmAccounts.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("CRM account not found");
    return row;
  }

  async function createAccount(
    companyId: string,
    data: Omit<typeof crmAccounts.$inferInsert, "id" | "companyId" | "createdAt" | "updatedAt">,
  ) {
    return db
      .insert(crmAccounts)
      .values({ ...data, companyId })
      .returning()
      .then((rows) => rows[0]);
  }

  async function updateAccount(
    id: string,
    data: Partial<
      Omit<typeof crmAccounts.$inferInsert, "id" | "companyId" | "createdAt">
    >,
  ) {
    const row = await db
      .update(crmAccounts)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(crmAccounts.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("CRM account not found");
    return row;
  }

  async function upsertByExternalId(
    companyId: string,
    externalSource: string,
    externalId: string,
    data: Omit<typeof crmAccounts.$inferInsert, "id" | "companyId" | "externalId" | "externalSource" | "createdAt" | "updatedAt">,
  ) {
    return db
      .insert(crmAccounts)
      .values({ ...data, companyId, externalSource, externalId, lastSyncedAt: new Date() })
      .onConflictDoUpdate({
        target: [crmAccounts.companyId, crmAccounts.externalSource, crmAccounts.externalId],
        set: { ...data, lastSyncedAt: new Date(), updatedAt: new Date() },
      })
      .returning()
      .then((rows) => rows[0]);
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  async function listContacts(
    companyId: string,
    opts?: {
      limit?: number;
      offset?: number;
      accountId?: string;
      stage?: string;
      ownerAgentId?: string;
    },
  ) {
    const conditions = [eq(crmContacts.companyId, companyId)];
    if (opts?.accountId)
      conditions.push(eq(crmContacts.accountId, opts.accountId));
    if (opts?.ownerAgentId)
      conditions.push(eq(crmContacts.ownerAgentId, opts.ownerAgentId));

    return db
      .select()
      .from(crmContacts)
      .where(and(...conditions))
      .orderBy(desc(crmContacts.createdAt))
      .limit(opts?.limit ?? 50)
      .offset(opts?.offset ?? 0);
  }

  async function getContactById(id: string) {
    const row = await db
      .select()
      .from(crmContacts)
      .where(eq(crmContacts.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("CRM contact not found");
    return row;
  }

  async function createContact(
    companyId: string,
    data: Omit<typeof crmContacts.$inferInsert, "id" | "companyId" | "createdAt" | "updatedAt">,
  ) {
    return db
      .insert(crmContacts)
      .values({ ...data, companyId })
      .returning()
      .then((rows) => rows[0]);
  }

  async function updateContact(
    id: string,
    data: Partial<
      Omit<typeof crmContacts.$inferInsert, "id" | "companyId" | "createdAt">
    >,
  ) {
    const row = await db
      .update(crmContacts)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(crmContacts.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("CRM contact not found");
    return row;
  }

  async function upsertContactByExternalId(
    companyId: string,
    externalSource: string,
    externalId: string,
    data: Omit<typeof crmContacts.$inferInsert, "id" | "companyId" | "externalId" | "externalSource" | "createdAt" | "updatedAt">,
  ) {
    return db
      .insert(crmContacts)
      .values({ ...data, companyId, externalSource, externalId, lastSyncedAt: new Date() })
      .onConflictDoUpdate({
        target: [crmContacts.companyId, crmContacts.externalSource, crmContacts.externalId],
        set: { ...data, lastSyncedAt: new Date(), updatedAt: new Date() },
      })
      .returning()
      .then((rows) => rows[0]);
  }

  // ---------------------------------------------------------------------------
  // Deals
  // ---------------------------------------------------------------------------

  async function listDeals(
    companyId: string,
    opts?: {
      limit?: number;
      offset?: number;
      accountId?: string;
      stage?: string;
      ownerAgentId?: string;
    },
  ) {
    const conditions = [eq(crmDeals.companyId, companyId)];
    if (opts?.accountId)
      conditions.push(eq(crmDeals.accountId, opts.accountId));
    if (opts?.stage) conditions.push(eq(crmDeals.stage, opts.stage));
    if (opts?.ownerAgentId)
      conditions.push(eq(crmDeals.ownerAgentId, opts.ownerAgentId));

    return db
      .select()
      .from(crmDeals)
      .where(and(...conditions))
      .orderBy(desc(crmDeals.createdAt))
      .limit(opts?.limit ?? 50)
      .offset(opts?.offset ?? 0);
  }

  async function getDealById(id: string) {
    const row = await db
      .select()
      .from(crmDeals)
      .where(eq(crmDeals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("CRM deal not found");
    return row;
  }

  async function createDeal(
    companyId: string,
    data: Omit<typeof crmDeals.$inferInsert, "id" | "companyId" | "createdAt" | "updatedAt">,
  ) {
    return db
      .insert(crmDeals)
      .values({ ...data, companyId })
      .returning()
      .then((rows) => rows[0]);
  }

  async function updateDeal(
    id: string,
    data: Partial<
      Omit<typeof crmDeals.$inferInsert, "id" | "companyId" | "createdAt">
    >,
  ) {
    const row = await db
      .update(crmDeals)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(crmDeals.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("CRM deal not found");
    return row;
  }

  async function upsertDealByExternalId(
    companyId: string,
    externalSource: string,
    externalId: string,
    data: Omit<typeof crmDeals.$inferInsert, "id" | "companyId" | "externalId" | "externalSource" | "createdAt" | "updatedAt">,
  ) {
    return db
      .insert(crmDeals)
      .values({ ...data, companyId, externalSource, externalId, lastSyncedAt: new Date() })
      .onConflictDoUpdate({
        target: [crmDeals.companyId, crmDeals.externalSource, crmDeals.externalId],
        set: { ...data, lastSyncedAt: new Date(), updatedAt: new Date() },
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function getDealsByStage(companyId: string, stage: string) {
    return db
      .select()
      .from(crmDeals)
      .where(and(eq(crmDeals.companyId, companyId), eq(crmDeals.stage, stage)))
      .orderBy(desc(crmDeals.createdAt));
  }

  // ---------------------------------------------------------------------------
  // Activities
  // ---------------------------------------------------------------------------

  async function listActivities(
    companyId: string,
    opts?: {
      limit?: number;
      offset?: number;
      accountId?: string;
      dealId?: string;
      ownerAgentId?: string;
    },
  ) {
    const conditions = [eq(crmActivities.companyId, companyId)];
    if (opts?.accountId)
      conditions.push(eq(crmActivities.accountId, opts.accountId));
    if (opts?.dealId)
      conditions.push(eq(crmActivities.dealId, opts.dealId));

    return db
      .select()
      .from(crmActivities)
      .where(and(...conditions))
      .orderBy(desc(crmActivities.createdAt))
      .limit(opts?.limit ?? 50)
      .offset(opts?.offset ?? 0);
  }

  async function createActivity(
    companyId: string,
    data: Omit<typeof crmActivities.$inferInsert, "id" | "companyId" | "createdAt">,
  ) {
    return db
      .insert(crmActivities)
      .values({ ...data, companyId })
      .returning()
      .then((rows) => rows[0]);
  }

  async function getActivitiesForDeal(dealId: string) {
    return db
      .select()
      .from(crmActivities)
      .where(eq(crmActivities.dealId, dealId))
      .orderBy(desc(crmActivities.createdAt));
  }

  async function upsertActivityByExternalId(
    companyId: string,
    externalSource: string,
    externalId: string,
    data: Omit<typeof crmActivities.$inferInsert, "id" | "companyId" | "externalId" | "externalSource" | "createdAt">,
  ) {
    return db
      .insert(crmActivities)
      .values({ ...data, companyId, externalSource, externalId })
      .onConflictDoUpdate({
        target: [crmActivities.companyId, crmActivities.externalSource, crmActivities.externalId],
        set: { ...data },
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function getActivitiesForAccount(accountId: string) {
    return db
      .select()
      .from(crmActivities)
      .where(eq(crmActivities.accountId, accountId))
      .orderBy(desc(crmActivities.createdAt));
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  async function getPipelineSummary(companyId: string) {
    const rows = await db
      .select({
        stage: crmDeals.stage,
        count: sql<number>`count(*)::int`,
        totalAmountCents: sql<number>`coalesce(sum(${crmDeals.amountCents}::int), 0)::int`,
      })
      .from(crmDeals)
      .where(eq(crmDeals.companyId, companyId))
      .groupBy(crmDeals.stage);

    const totalDeals = rows.reduce((sum, r) => sum + r.count, 0);
    const totalPipelineValueCents = rows.reduce(
      (sum, r) => sum + r.totalAmountCents,
      0,
    );

    return {
      stages: rows,
      totalDeals,
      totalPipelineValueCents,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    // Accounts
    listAccounts,
    getAccountById,
    createAccount,
    updateAccount,
    upsertByExternalId,

    // Contacts
    listContacts,
    getContactById,
    createContact,
    updateContact,
    upsertContactByExternalId,

    // Deals
    listDeals,
    getDealById,
    createDeal,
    updateDeal,
    upsertDealByExternalId,
    getDealsByStage,

    // Activities
    listActivities,
    createActivity,
    upsertActivityByExternalId,
    getActivitiesForDeal,
    getActivitiesForAccount,

    // Dashboard
    getPipelineSummary,

    // Leads
    listLeads: async (companyId: string, opts?: { status?: string; source?: string; limit?: number; offset?: number }) => {
      const conditions = [eq(crmLeads.companyId, companyId)];
      if (opts?.status) conditions.push(eq(crmLeads.status, opts.status));
      if (opts?.source) conditions.push(eq(crmLeads.source, opts.source));
      return db.select().from(crmLeads).where(and(...conditions))
        .orderBy(desc(crmLeads.createdAt)).limit(opts?.limit ?? 50).offset(opts?.offset ?? 0);
    },
    getLeadById: async (id: string) => {
      const lead = await db.select().from(crmLeads).where(eq(crmLeads.id, id)).then((r) => r[0] ?? null);
      if (!lead) throw notFound("Lead not found");
      return lead;
    },
    createLead: async (companyId: string, data: Omit<typeof crmLeads.$inferInsert, "id" | "companyId" | "createdAt" | "updatedAt">) =>
      db.insert(crmLeads).values({ ...data, companyId }).returning().then((r) => r[0]),
    updateLead: async (id: string, data: Partial<typeof crmLeads.$inferInsert>) => {
      const updated = await db.update(crmLeads).set({ ...data, updatedAt: new Date() })
        .where(eq(crmLeads.id, id)).returning().then((r) => r[0] ?? null);
      if (!updated) throw notFound("Lead not found");
      return updated;
    },
    convertLead: async (id: string, accountId: string, contactId: string) => {
      const updated = await db.update(crmLeads).set({
        status: "converted",
        convertedAccountId: accountId,
        convertedContactId: contactId,
        convertedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(crmLeads.id, id)).returning().then((r) => r[0] ?? null);
      if (!updated) throw notFound("Lead not found");
      return updated;
    },

    // Partners
    listPartners: async (companyId: string, opts?: { type?: string; status?: string; limit?: number; offset?: number }) => {
      const conditions = [eq(crmPartners.companyId, companyId)];
      if (opts?.type) conditions.push(eq(crmPartners.type, opts.type));
      if (opts?.status) conditions.push(eq(crmPartners.status, opts.status));
      return db.select().from(crmPartners).where(and(...conditions))
        .orderBy(desc(crmPartners.createdAt)).limit(opts?.limit ?? 50).offset(opts?.offset ?? 0);
    },
    getPartnerById: async (id: string) => {
      const partner = await db.select().from(crmPartners).where(eq(crmPartners.id, id)).then((r) => r[0] ?? null);
      if (!partner) throw notFound("Partner not found");
      return partner;
    },
    createPartner: async (companyId: string, data: Omit<typeof crmPartners.$inferInsert, "id" | "companyId" | "createdAt" | "updatedAt">) =>
      db.insert(crmPartners).values({ ...data, companyId }).returning().then((r) => r[0]),
    updatePartner: async (id: string, data: Partial<typeof crmPartners.$inferInsert>) => {
      const updated = await db.update(crmPartners).set({ ...data, updatedAt: new Date() })
        .where(eq(crmPartners.id, id)).returning().then((r) => r[0] ?? null);
      if (!updated) throw notFound("Partner not found");
      return updated;
    },
  };
}
