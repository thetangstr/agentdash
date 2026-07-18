// AgentDash (Test Drive): persisted artifacts produced by a trial hero task.
//
// One row per completed curated run (e.g. a sales-outreach sequence). `content`
// holds the structured artifact the agent produced; the UI / share view renders
// it as a real product output, not raw chat text.
//
// See docs/superpowers/specs/2026-06-27-test-drive-no-signup-trial.md (§5, §10).

import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { trialSessions } from "./trial_sessions.js";

export const trialArtifacts = pgTable(
  "trial_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trialSessionId: uuid("trial_session_id")
      .notNull()
      .references(() => trialSessions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    // Hero-task id, e.g. "sales_outreach".
    useCase: text("use_case").notNull(),
    title: text("title").notNull(),
    // Structured artifact payload (shape depends on useCase).
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    // Short human summary of the input that produced this artifact.
    inputSummary: text("input_summary"),
    // AgentDash (Test Drive, Slice 3): opaque url-safe token for the PUBLIC,
    // read-only share view. Null until the trial user shares the artifact;
    // unique so a token resolves to exactly one artifact.
    shareToken: text("share_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("trial_artifacts_session_idx").on(table.trialSessionId),
    shareTokenUniqueIdx: uniqueIndex("trial_artifacts_share_token_unique_idx")
      .on(table.shareToken)
      .where(sql`${table.shareToken} IS NOT NULL`),
  }),
);
