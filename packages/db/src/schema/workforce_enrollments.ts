// AgentDash: enrollment pins work instructions; acceptance is derived from evidence.
import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { goals } from './goals.js';
import { issues } from './issues.js';
export const workforceEnrollments = pgTable('workforce_enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  templateId: text('template_id').notNull(), templateVersion: integer('template_version').notNull(),
  objective: text('objective'), metrics: jsonb('metrics').$type<string[]>().notNull().default([]),
  goalId: uuid('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  learnedBriefRevision: integer('learned_brief_revision'),
  firstJobIssueId: uuid('first_job_issue_id').references(() => issues.id, { onDelete: 'set null' }),
  installedSkillKeys: jsonb('installed_skill_keys').$type<string[]>().notNull().default([]),
  skillInstallError: text('skill_install_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('workforce_enrollments_agent_unique').on(t.agentId), index('workforce_enrollments_company_idx').on(t.companyId)]);
