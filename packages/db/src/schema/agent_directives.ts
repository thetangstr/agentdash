import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * AgentDash-MK: the free-text operating directives a human's local harness
 * pushes to the AgentDash agent it stewards — the agent's "soul" and its
 * explicit don'ts.
 *
 * **Directives inform; they do not grant.** Capability lives entirely in
 * `agent_governance_policies` (owner ceiling ∩ steward request) and is enforced
 * at `resolveActingAs`. Nothing in this table is ever consulted by an
 * authorization decision, and that separation is the load-bearing security
 * property of the pairing architecture: a directive reading "you may access
 * HubSpot" must do exactly nothing, because prose in a context window is not a
 * control. Keeping the two in different tables makes the mistake hard to make
 * by accident — there is no column here an enforcement point could read.
 *
 * **Append-only.** A push seals the prior row by setting `superseded_at` and
 * inserts the next version; no row is ever mutated in place. Provenance has to
 * survive, because "which instructions was the agent operating under when it
 * did that?" is the question an incident review actually asks, and a
 * last-write-wins column cannot answer it.
 *
 * `pushed_by_user_id` mirrors `company_memberships.principal_id` (durable text
 * principal) for the same reason as `agent_stewardships` and `bridge_endpoints`:
 * attribution must outlive the auth account row.
 */
export const agentDirectives = pgTable(
  "agent_directives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    /** Monotonic per agent, starting at 1. Stable identifier in audit trails. */
    version: integer("version").notNull(),
    directives: text("directives").notNull(),
    pushedByUserId: text("pushed_by_user_id").notNull(),
    pushedAt: timestamp("pushed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null exactly while this version is the active one. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => ({
    // At most one live version per agent, enforced by the database rather than
    // by service discipline. Two concurrent harness pushes would otherwise both
    // insert and leave the runtime picking one arbitrarily.
    activeUq: uniqueIndex("agent_directives_active_uq")
      .on(table.companyId, table.agentId)
      .where(sql`${table.supersededAt} is null`),
    versionUq: uniqueIndex("agent_directives_version_uq").on(
      table.companyId,
      table.agentId,
      table.version,
    ),
    companyIdx: index("agent_directives_company_idx").on(table.companyId, table.agentId),
  }),
);
