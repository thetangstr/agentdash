import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * AgentDash: an agent's own durable memory — the curated document it carries
 * from one wake to the next.
 *
 * **Memory informs; it does not grant.** This is the same rule `agent_directives`
 * states, and it binds harder here: directives are written by a human, memory is
 * written by the agent. Nothing in this table is ever read by an authorization
 * decision, and there is deliberately no column an enforcement point could
 * consult. An agent that could widen its own reach by writing a sentence about
 * it would have no boundary at all.
 *
 * **Why a table and not the session.** A CLI session already carries context
 * between wakes, but it is a cache, not a memory: it is keyed per adapter, so
 * switching an agent from Hermes to Codex silently orphans every session it had
 * (observed 2026-08-19), and the fallback chain does exactly that automatically
 * on a provider failure. Memory sits above the adapter and is re-injected on
 * every run, fresh or resumed, so it survives the switch.
 *
 * **Append-only.** A write seals the prior row via `superseded_at` and inserts
 * the next version; no row is mutated in place. `version` is both the audit
 * anchor and the optimistic-concurrency token — two concurrent runs cannot
 * silently clobber each other, because the second write names a version that is
 * no longer current.
 *
 * **Curated, not accumulated.** The size cap in `AGENT_MEMORY_MAX_LENGTH` is the
 * point, not a limitation: a document that can always grow is never revised, and
 * an unrevised memory preserves every stale belief the agent ever held.
 */
export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    /** Monotonic per agent, starting at 1. */
    version: integer("version").notNull(),
    content: text("content").notNull(),
    /** "agent" when self-authored; "steward" or "admin" when a human corrected it. */
    authorKind: text("author_kind").notNull(),
    /**
     * Attribution is split rather than a single polymorphic id so a reader can
     * tell an agent's own belief from a human's correction without decoding a
     * discriminator, and so each side can carry its natural reference.
     */
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    /** Durable text principal, mirroring `agent_stewardships.user_id`. */
    authorUserId: text("author_user_id"),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null exactly while this version is the active one. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => ({
    // At most one live version per agent, enforced by the database rather than
    // by the service — the transaction narrows the race, this index closes it.
    activeUq: uniqueIndex("agent_memory_active_uniq")
      .on(table.companyId, table.agentId)
      .where(sql`${table.supersededAt} is null`),
    versionUq: uniqueIndex("agent_memory_agent_version_uniq").on(table.agentId, table.version),
    companyAgentIdx: index("agent_memory_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
