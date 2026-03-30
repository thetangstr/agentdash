import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Lightweight CRM account model — syncs bidirectionally with HubSpot/Salesforce.
 * Not a full CRM replacement, but enough context for agents to understand
 * who they're working for and why.
 */
export const crmAccounts = pgTable(
  "crm_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    domain: text("domain"),
    industry: text("industry"),
    size: text("size"),
    stage: text("stage"),
    ownerAgentId: uuid("owner_agent_id"),
    ownerUserId: text("owner_user_id"),
    externalId: text("external_id"),
    externalSource: text("external_source"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_accounts_company_idx").on(table.companyId),
    uniqueIndex("crm_accounts_external_unique").on(table.companyId, table.externalSource, table.externalId),
  ],
);

export const crmContacts = pgTable(
  "crm_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    accountId: uuid("account_id").references(() => crmAccounts.id),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    title: text("title"),
    ownerAgentId: uuid("owner_agent_id"),
    ownerUserId: text("owner_user_id"),
    externalId: text("external_id"),
    externalSource: text("external_source"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_contacts_company_idx").on(table.companyId),
    index("crm_contacts_account_idx").on(table.companyId, table.accountId),
    uniqueIndex("crm_contacts_external_unique").on(table.companyId, table.externalSource, table.externalId),
  ],
);

export const crmDeals = pgTable(
  "crm_deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    accountId: uuid("account_id").references(() => crmAccounts.id),
    contactId: uuid("contact_id").references(() => crmContacts.id),
    name: text("name").notNull(),
    stage: text("stage"),
    amountCents: text("amount_cents"),
    currency: text("currency").default("USD"),
    closeDate: timestamp("close_date", { withTimezone: true }),
    probability: text("probability"),
    ownerAgentId: uuid("owner_agent_id"),
    ownerUserId: text("owner_user_id"),
    linkedProjectId: uuid("linked_project_id"),
    linkedIssueId: uuid("linked_issue_id"),
    externalId: text("external_id"),
    externalSource: text("external_source"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_deals_company_idx").on(table.companyId),
    index("crm_deals_account_idx").on(table.companyId, table.accountId),
    index("crm_deals_stage_idx").on(table.companyId, table.stage),
    uniqueIndex("crm_deals_external_unique").on(table.companyId, table.externalSource, table.externalId),
  ],
);

export const crmActivities = pgTable(
  "crm_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    accountId: uuid("account_id").references(() => crmAccounts.id),
    contactId: uuid("contact_id").references(() => crmContacts.id),
    dealId: uuid("deal_id").references(() => crmDeals.id),
    activityType: text("activity_type").notNull(),
    subject: text("subject"),
    body: text("body"),
    performedByAgentId: uuid("performed_by_agent_id"),
    performedByUserId: text("performed_by_user_id"),
    externalId: text("external_id"),
    externalSource: text("external_source"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_activities_company_idx").on(table.companyId, table.occurredAt),
    index("crm_activities_account_idx").on(table.accountId, table.occurredAt),
    index("crm_activities_deal_idx").on(table.dealId, table.occurredAt),
    uniqueIndex("crm_activities_external_unique").on(table.companyId, table.externalSource, table.externalId),
  ],
);

/**
 * Leads — pre-qualification contacts/companies that haven't become accounts yet.
 * Maps to HubSpot contacts with lifecycle stage = "lead" or "subscriber".
 */
export const crmLeads = pgTable(
  "crm_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    company: text("company"),
    title: text("title"),
    source: text("source"),
    status: text("status").notNull().default("new"),
    score: text("score"),
    ownerAgentId: uuid("owner_agent_id"),
    ownerUserId: text("owner_user_id"),
    convertedAccountId: uuid("converted_account_id").references(() => crmAccounts.id),
    convertedContactId: uuid("converted_contact_id").references(() => crmContacts.id),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    externalId: text("external_id"),
    externalSource: text("external_source"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_leads_company_status_idx").on(table.companyId, table.status),
    index("crm_leads_company_source_idx").on(table.companyId, table.source),
    uniqueIndex("crm_leads_external_unique").on(table.companyId, table.externalSource, table.externalId),
  ],
);

/**
 * Partners — referral partners, resellers, agencies, technology partners.
 * Tracks the partner relationship and any revenue attribution.
 */
export const crmPartners = pgTable(
  "crm_partners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    type: text("type").notNull().default("referral"),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    website: text("website"),
    status: text("status").notNull().default("active"),
    tier: text("tier"),
    referralCount: text("referral_count"),
    revenueAttributedCents: text("revenue_attributed_cents"),
    ownerAgentId: uuid("owner_agent_id"),
    ownerUserId: text("owner_user_id"),
    linkedAccountId: uuid("linked_account_id").references(() => crmAccounts.id),
    externalId: text("external_id"),
    externalSource: text("external_source"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_partners_company_status_idx").on(table.companyId, table.status),
    index("crm_partners_company_type_idx").on(table.companyId, table.type),
    uniqueIndex("crm_partners_external_unique").on(table.companyId, table.externalSource, table.externalId),
  ],
);
