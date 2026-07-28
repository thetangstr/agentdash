import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { AgentGovernancePolicy } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * AgentDash-MK: one governance row per company agent.
 *
 * The owner ceiling and the steward request are stored separately and the
 * effective policy is the persisted intersection of the two, so runtime
 * authorization never has to recompute it. `revision` is a single monotonic
 * counter across both sides and is the optimistic-concurrency anchor.
 *
 * User ids mirror `company_memberships.principal_id` (durable text principals)
 * for the same reason as `agent_stewardships`: attribution must survive auth
 * identity lifecycle changes.
 */
export const agentGovernancePolicies = pgTable(
  "agent_governance_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    ownerCeiling: jsonb("owner_ceiling").$type<AgentGovernancePolicy>().notNull(),
    ownerCeilingRevision: integer("owner_ceiling_revision").notNull().default(1),
    ownerCeilingUpdatedByUserId: text("owner_ceiling_updated_by_user_id"),
    stewardRequest: jsonb("steward_request").$type<AgentGovernancePolicy>().notNull(),
    stewardRequestRevision: integer("steward_request_revision").notNull().default(1),
    stewardRequestUpdatedByUserId: text("steward_request_updated_by_user_id"),
    effectivePolicy: jsonb("effective_policy").$type<AgentGovernancePolicy>().notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentUq: uniqueIndex("agent_governance_policies_company_agent_uq").on(
      table.companyId,
      table.agentId,
    ),
    companyIdx: index("agent_governance_policies_company_idx").on(table.companyId),
  }),
);
