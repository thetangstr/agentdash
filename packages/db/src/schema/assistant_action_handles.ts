import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assistantGrants } from "./assistant_grants.js";
import { companies } from "./companies.js";

/**
 * AgentDash assistant MCP (GH #679, M4): a proposed gated action, read back to
 * the person by their assistant, waiting for `confirm_action`.
 *
 * Same shape as `steward_inbox_action_handles`, for the same reason: the
 * assistant OAuth grant is a read/act credential, never a decision credential.
 * Deciding an approval or hiring an agent is authorized by a handle minted for
 * one resolved action at one approval revision, spent once, dead in fifteen
 * minutes — and bound to the grant it was minted for, so a handle leaking into
 * another connection or company is worthless.
 *
 * The row stores the RESOLVED action, not the sentence the person typed: the
 * approval id + revision (or the hire's role/name) are fixed at prepare time,
 * so what is confirmed is exactly what was read back and never a
 * re-interpretation of free text.
 */
export const assistantActionHandles = pgTable(
  "assistant_action_handles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The opaque handle. Never logged, never re-derivable. */
    token: text("token").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Bound to the grant it was minted for — a decide-scope credential. */
    grantId: uuid("grant_id")
      .notNull()
      .references(() => assistantGrants.id, { onDelete: "cascade" }),
    /**
     * The person it was minted for. Authority is re-resolved against this at
     * redemption, so a handle is proof of the two-step flow and never of
     * permission.
     */
    actorUserId: text("actor_user_id").notNull(),
    /** `approval_decision` | `hire_request`. */
    kind: text("kind").notNull(),
    /** The resolved action, exactly as it was read back. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUq: uniqueIndex("assistant_action_handles_token_uq").on(table.token),
    grantIdx: index("assistant_action_handles_grant_idx").on(table.grantId),
  }),
);
