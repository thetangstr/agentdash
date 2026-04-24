import { pgTable, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySkills } from "./company_skills.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { skillVersions } from "./skill_versions.js";

export const skillUsageEvents = pgTable(
  "skill_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => companySkills.id),
    versionId: uuid("version_id").references(() => skillVersions.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    issueId: uuid("issue_id").references(() => issues.id),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_usage_events_company_skill_idx").on(table.companyId, table.skillId, table.usedAt),
    index("skill_usage_events_company_agent_idx").on(table.companyId, table.agentId, table.usedAt),
  ],
);
