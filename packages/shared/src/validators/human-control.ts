import { z } from 'zod';
import { HUMAN_OPERATION_IDS } from '../human-control.js';
export const humanTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company'), companyId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('self') }).strict(),
  z.object({ kind: z.literal('instance') }).strict(),
  z.object({ kind: z.literal('public') }).strict(),
]);
export const humanOperationRequestSchema = z.object({
  target: humanTargetSchema,
  operationId: z.enum(HUMAN_OPERATION_IDS),
  version: z.literal(1),
  // Each registered operation validates its own strict input before dispatch.
  input: z.record(z.unknown()),
}).strict();
export const humanDiscoverRequestSchema = z.object({
  target: humanTargetSchema,
  pageId: z.enum(['workforce', 'inbox']).optional(),
  cursor: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(100).default(100),
}).strict();
export const humanConfirmRequestSchema = z.object({
  target: humanTargetSchema,
  handle: z.string().min(32).max(128),
  personSaid: z.string().max(4000).optional(),
}).strict();

// Finite registry schema rendering. Unsupported types fail closed; this is not
// the permissive legacy MCP converter. Runtime Zod validation remains binding.
export function humanJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def;
  if (schema instanceof z.ZodEffects) return humanJsonSchema(schema.innerType());
  if (schema instanceof z.ZodOptional) return humanJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodNullable) return { anyOf: [humanJsonSchema(schema.unwrap()), { type: 'null' }] };
  if (schema instanceof z.ZodDefault) return { ...humanJsonSchema(schema.removeDefault()), default: def.defaultValue() };
  if (schema instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: 'string' };
    for (const check of def.checks) {
      if (check.kind === 'min') out.minLength = check.value;
      if (check.kind === 'max') out.maxLength = check.value;
      if (check.kind === 'uuid') out.format = 'uuid';
      if (check.kind === 'datetime') out.format = 'date-time';
      if (check.kind === 'trim') out['x-normalization'] = 'trim';
    }
    return out;
  }
  if (schema instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: 'number' };
    for (const check of def.checks) {
      if (check.kind === 'int') out.type = 'integer';
      if (check.kind === 'min') out[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
      if (check.kind === 'max') out[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
    }
    return out;
  }
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodLiteral) return { const: def.value };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: def.values };
  if (schema instanceof z.ZodArray) return { type: 'array', items: humanJsonSchema(schema.element), ...(def.minLength ? { minItems: def.minLength.value } : {}), ...(def.maxLength ? { maxItems: def.maxLength.value } : {}) };
  if (schema instanceof z.ZodObject) {
    if (def.unknownKeys !== 'strict') throw new Error('Human object contracts must be strict');
    const entries = Object.entries(schema.shape) as [string, z.ZodTypeAny][];
    return { type: 'object', additionalProperties: false, properties: Object.fromEntries(entries.map(([name, value]) => [name, humanJsonSchema(value)])), required: entries.filter(([, value]) => !value.isOptional()).map(([name]) => name) };
  }
  if (schema instanceof z.ZodUnknown) return {};
  if (schema instanceof z.ZodRecord) return { type: 'object', additionalProperties: humanJsonSchema(def.valueType) };
  if (schema instanceof z.ZodDiscriminatedUnion) return { oneOf: def.options.map(humanJsonSchema) };
  if (schema instanceof z.ZodUnion) return { anyOf: def.options.map(humanJsonSchema) };
  throw new Error('Unsupported human operation schema');
}
// AgentDash: named-human task-recovery permit. One confirm authorizes exactly
// one queued run on the SAME exhausted issue; it never clears the exhaustion
// marker, resets counters, or enables automatic continuation.
export const taskRecoveryPermitStatusSchema = z.enum(['authorized', 'consumed', 'denied', 'expired']);
export const taskRecoveryPermitSchema = z.object({
  kind: z.literal('task_recovery_permit'),
  version: z.literal(1),
  status: taskRecoveryPermitStatusSchema,
  issueId: z.string().uuid(),
  companyId: z.string().uuid(),
  runId: z.string().uuid(),
  wakeupRequestId: z.string().uuid(),
  assigneeAgentId: z.string().uuid(),
  issueUpdatedAt: z.string(),
  exhaustedAt: z.string().nullable(),
  sourceRunId: z.string().nullable(),
  refusedRunId: z.string().nullable(),
  exhaustedBy: z.array(z.string()),
  authorizedByUserId: z.string(),
  actionHandleId: z.string(),
  authorizedAt: z.string(),
  expiresAt: z.string(),
  consumedAt: z.string().nullable().optional(),
  deniedAt: z.string().nullable().optional(),
  expiredAt: z.string().nullable().optional(),
  denialReason: z.string().nullable().optional(),
  outcomeCriteria: z.string().nullable(),
}).strict();
export const taskRecoveryExhaustedIssueSchema = z.object({
  issueId: z.string().uuid(),
  companyId: z.string().uuid(),
  identifier: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  assigneeAgentId: z.string().uuid().nullable(),
  assigneeAgentName: z.string().nullable(),
  exhausted: z.boolean(),
  exhaustedAt: z.string().nullable(),
  exhaustedBy: z.array(z.string()),
  sourceRunId: z.string().nullable(),
  refusedRunId: z.string().nullable(),
  usage: z.record(z.unknown()).nullable(),
  pendingPermit: taskRecoveryPermitSchema.nullable(),
}).strict();
export const taskRecoveryIssueInputSchema = z.object({
  issueId: z.string().uuid(),
}).strict();
export const taskRecoveryRemediateInputSchema = taskRecoveryIssueInputSchema.extend({
  outcomeCriteria: z.string().trim().min(1).max(4000).nullable().optional(),
  expiresInMinutes: z.number().int().min(1).max(120).optional(),
}).strict();
export const taskRecoveryRemediateReceiptSchema = z.object({
  authorized: z.literal(true),
  permit: taskRecoveryPermitSchema,
  runId: z.string().uuid(),
  wakeupRequestId: z.string().uuid(),
  runStatus: z.string(),
  expiresAt: z.string(),
}).strict();
export type TaskRecoveryPermit = z.infer<typeof taskRecoveryPermitSchema>;
export type TaskRecoveryExhaustedIssue = z.infer<typeof taskRecoveryExhaustedIssueSchema>;
export type TaskRecoveryRemediateInput = z.input<typeof taskRecoveryRemediateInputSchema>;
export type TaskRecoveryRemediateReceipt = z.infer<typeof taskRecoveryRemediateReceiptSchema>;
