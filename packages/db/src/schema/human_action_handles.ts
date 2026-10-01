// AgentDash: named-human readback records are not permission grants.
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authUsers } from './auth.js';
import { boardApiKeys } from './board_api_keys.js';
import { companies } from './companies.js';
export const humanActionHandles = pgTable('human_action_handles', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull(),
  actorUserId: text('actor_user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  boardApiKeyId: uuid('board_api_key_id').notNull().references(() => boardApiKeys.id, { onDelete: 'cascade' }),
  targetKind: text('target_kind').notNull(),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  operationId: text('operation_id').notNull(),
  version: integer('version').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  preconditions: jsonb('preconditions').$type<Record<string, unknown>>().notNull(),
  confirmationMode: text('confirmation_mode').notNull().default('human_readback'),
  status: text('status').notNull().default('prepared'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('human_action_handles_hash_uq').on(t.tokenHash),
  index('human_action_handles_actor_idx').on(t.actorUserId, t.boardApiKeyId),
  // Retention sweep scans (status, expires_at); company cascade deletes use company_id.
  index('human_action_handles_status_expires_idx').on(t.status, t.expiresAt),
  index('human_action_handles_company_idx').on(t.companyId),
  check('human_action_handles_target_check', sql`(${t.targetKind} = 'company' AND ${t.companyId} IS NOT NULL) OR (${t.targetKind} IN ('self', 'instance', 'public') AND ${t.companyId} IS NULL)`),
  check('human_action_handles_status_check', sql`${t.status} IN ('prepared', 'completed', 'denied', 'stale', 'expired', 'recovery_required')`),
  check('human_action_handles_version_check', sql`${t.version} > 0`),
]);
