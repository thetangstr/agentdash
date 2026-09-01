import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    role: text("role").notNull().default("general"),
    title: text("title"),
    icon: text("icon"),
    status: text("status").notNull().default("idle"),
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").notNull().default("process"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    clockchainDid: text("clockchain_did"),
    // A3/A4 (2026-08-16): whoever creates an agent owns it — the decided
    // answer to "who is answerable for each agent" after the stewardship
    // roster idea collided with stewardship's 1:1 uniqueness. Backfilled to
    // each company's first admin.
    createdByUserId: text("created_by_user_id"),
    /**
     * Does this agent mirror one person, or does it work on its own?
     *
     * `stewarded` — exactly one human runs it. That pairing is the whole point
     * of the personal agent: the steward's My Agent page, their connect code
     * and API key, their messaging channel, and the person an escalation
     * reaches. `agent_stewardships` holds the pairing and enforces 1:1 in both
     * directions; this column records which kind of agent it is, so the
     * absence of a stewardship row stops being ambiguous.
     *
     * `autonomous` — no human runs it. It is part of a team that works without
     * a person at a terminal, so it has no steward, no connect code and no API
     * key, and it escalates to `accountable_user_id` instead.
     *
     * Before this column the two were indistinguishable: an autonomous agent
     * and an agent whose pairing had simply never been set up both read as
     * "no steward", so approval cards for either were delivered to nobody
     * (`approval-card-delivery` returned early on a null stewardship) and the
     * board could not tell a person which was which.
     */
    autonomy: text("autonomy").notNull().default("stewarded"),
    /**
     * The human answerable for an autonomous agent's work.
     *
     * Distinct from `created_by_user_id`, which is provenance and never
     * changes: accountability is transferable, because the person who set an
     * agent up is often not the person who should be woken by it six months
     * later.
     *
     * Null for a stewarded agent, where the steward is by definition the
     * accountable party — one place to look, so the two cannot disagree.
     * Resolve it through `resolveAgentAccountability` rather than reading this
     * column directly.
     */
    accountableUserId: text("accountable_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
    companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    companyDefaultEnvironmentIdx: index("agents_company_default_environment_idx").on(table.companyId, table.defaultEnvironmentId),
    autonomyCk: check(
      "agents_autonomy_ck",
      sql`${table.autonomy} in ('stewarded', 'autonomous')`,
    ),
    /**
     * An agent nobody answers for must not exist.
     *
     * A stewarded agent gets its accountable human from the stewardship, so
     * this only has teeth for autonomous ones — and that is exactly where the
     * gap was: no stewardship row, no accountable column, and an escalation
     * with nowhere to go. Enforced in the database rather than only in the
     * route because a backfill or a psql session can create agents too.
     */
    accountableCk: check(
      "agents_accountable_ck",
      sql`${table.autonomy} <> 'autonomous' or ${table.accountableUserId} is not null`,
    ),
  }),
);
