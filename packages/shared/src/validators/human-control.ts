import { z } from 'zod';
import { HUMAN_OPERATION_IDS } from '../human-control.js';
export const humanTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company'), companyId: z.guid() }).strict(),
  z.object({ kind: z.literal('self') }).strict(),
  z.object({ kind: z.literal('instance') }).strict(),
  z.object({ kind: z.literal('public') }).strict(),
]);
export const humanOperationRequestSchema = z.object({
  target: humanTargetSchema,
  operationId: z.enum(HUMAN_OPERATION_IDS),
  version: z.literal(1),
  // Each registered operation validates its own strict input before dispatch.
  input: z.record(z.string(), z.unknown()),
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
//
// Reads zod 4's public definition objects (`schema._zod.def`). Dispatch is on
// `def.type`, not `instanceof`: `z.guid()` is a string schema that is not an
// instance of `z.ZodString`. Refinements are checks on the schema itself in
// zod 4 (zod 3 wrapped them in ZodEffects); transforms and preprocessors are
// pipes, rendered by the side that describes the accepted input.
type HumanCheckDef = { check: string; [key: string]: unknown };
function humanChecks(schema: z.ZodType): HumanCheckDef[] {
  return ((schema._zod.def as { checks?: Array<{ _zod: { def: HumanCheckDef } }> }).checks ?? []).map((check) => check._zod.def);
}
// zod 4 records `.trim()` as an anonymous overwrite check; recognise it by what it does.
function isTrimOverwrite(check: HumanCheckDef): boolean {
  return check.check === 'overwrite' && typeof check.tx === 'function' && (check.tx as (value: string) => unknown)(' \tx\n ') === 'x';
}
function humanStringFormat(format: unknown): string | undefined {
  if (format === 'uuid' || format === 'guid') return 'uuid';
  if (format === 'datetime') return 'date-time';
  return undefined;
}
export function humanJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = schema._zod.def as z.core.$ZodTypeDef & Record<string, unknown>;
  switch (def.type) {
    case 'pipe': {
      // `.transform()` is pipe(schema, transform) and `z.preprocess()` is
      // pipe(transform, schema): render the schema side, as zod 3 did for its
      // ZodEffects. Any other `.pipe()` was a ZodPipeline, which failed closed.
      const { in: input, out } = def as unknown as { in: z.ZodType; out: z.ZodType };
      if (out._zod.def.type === 'transform') return humanJsonSchema(input);
      if (input._zod.def.type === 'transform') return humanJsonSchema(out);
      throw new Error('Unsupported human operation schema');
    }
    case 'optional':
      return humanJsonSchema(def.innerType as z.ZodType);
    case 'nullable':
      return { anyOf: [humanJsonSchema(def.innerType as z.ZodType), { type: 'null' }] };
    case 'default':
    case 'prefault':
      return { ...humanJsonSchema(def.innerType as z.ZodType), default: def.defaultValue };
    case 'string': {
      const out: Record<string, unknown> = { type: 'string' };
      const ownFormat = humanStringFormat(def.format);
      if (ownFormat) out.format = ownFormat;
      for (const check of humanChecks(schema)) {
        if (check.check === 'min_length') out.minLength = check.minimum;
        if (check.check === 'max_length') out.maxLength = check.maximum;
        if (check.check === 'string_format' && humanStringFormat(check.format)) out.format = humanStringFormat(check.format);
        if (isTrimOverwrite(check)) out['x-normalization'] = 'trim';
      }
      return out;
    }
    case 'number': {
      // `z.int()` carries its format on the schema; `.int()` adds it as a check.
      const out: Record<string, unknown> = { type: typeof def.format === 'string' && def.format.includes('int') ? 'integer' : 'number' };
      for (const check of humanChecks(schema)) {
        if (check.check === 'number_format' && typeof check.format === 'string' && check.format.includes('int')) out.type = 'integer';
        if (check.check === 'greater_than') out[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
        if (check.check === 'less_than') out[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
      }
      return out;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'literal':
      return { const: (def.values as unknown[])[0] };
    case 'enum':
      return { type: 'string', enum: Object.values(def.entries as Record<string, string>) };
    case 'array': {
      let minItems: unknown;
      let maxItems: unknown;
      for (const check of humanChecks(schema)) {
        if (check.check === 'min_length') minItems = check.minimum;
        if (check.check === 'max_length') maxItems = check.maximum;
      }
      return { type: 'array', items: humanJsonSchema(def.element as z.ZodType), ...(minItems !== undefined ? { minItems } : {}), ...(maxItems !== undefined ? { maxItems } : {}) };
    }
    case 'object': {
      // zod 4 spells `.strict()` as a `never` catchall.
      if ((def.catchall as z.ZodType | undefined)?._zod.def.type !== 'never') throw new Error('Human object contracts must be strict');
      const entries = Object.entries((schema as z.ZodObject).shape) as [string, z.ZodType][];
      return { type: 'object', additionalProperties: false, properties: Object.fromEntries(entries.map(([name, value]) => [name, humanJsonSchema(value)])), required: entries.filter(([, value]) => !value.isOptional()).map(([name]) => name) };
    }
    case 'unknown':
      return {};
    case 'record':
      return { type: 'object', additionalProperties: humanJsonSchema(def.valueType as z.ZodType) };
    case 'union': {
      const options = (def.options as z.ZodType[]).map(humanJsonSchema);
      return 'discriminator' in def ? { oneOf: options } : { anyOf: options };
    }
    default:
      throw new Error('Unsupported human operation schema');
  }
}
// AgentDash: named-human task-recovery permit. One confirm authorizes exactly
// one queued run on the SAME exhausted issue; it never clears the exhaustion
// marker, resets counters, or enables automatic continuation.
export const taskRecoveryPermitStatusSchema = z.enum(['authorized', 'consumed', 'denied', 'expired']);
export const taskRecoveryPermitSchema = z.object({
  kind: z.literal('task_recovery_permit'),
  version: z.literal(1),
  status: taskRecoveryPermitStatusSchema,
  issueId: z.guid(),
  companyId: z.guid(),
  runId: z.guid(),
  wakeupRequestId: z.guid(),
  assigneeAgentId: z.guid(),
  issueUpdatedAt: z.string(),
  exhaustedAt: z.string().nullable(),
  sourceRunId: z.string().nullable(),
  refusedRunId: z.string().nullable(),
  exhaustedBy: z.array(z.string()),
  authorizedByUserId: z.string(),
  actionHandleId: z.string(),
  // AgentDash (GH #891): which transport authorized it. 'session' permits come
  // from the web app's "Authorize one run"; their actionHandleId is a
  // server-generated action id, not a durable handle.
  authorizedVia: z.enum(['board_key', 'session']).optional(),
  authorizedAt: z.string(),
  expiresAt: z.string(),
  consumedAt: z.string().nullable().optional(),
  deniedAt: z.string().nullable().optional(),
  expiredAt: z.string().nullable().optional(),
  denialReason: z.string().nullable().optional(),
  outcomeCriteria: z.string().nullable(),
}).strict();
export const taskRecoveryExhaustedIssueSchema = z.object({
  issueId: z.guid(),
  companyId: z.guid(),
  identifier: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  assigneeAgentId: z.guid().nullable(),
  assigneeAgentName: z.string().nullable(),
  exhausted: z.boolean(),
  exhaustedAt: z.string().nullable(),
  exhaustedBy: z.array(z.string()),
  sourceRunId: z.string().nullable(),
  refusedRunId: z.string().nullable(),
  usage: z.record(z.string(), z.unknown()).nullable(),
  pendingPermit: taskRecoveryPermitSchema.nullable(),
}).strict();
export const taskRecoveryIssueInputSchema = z.object({
  issueId: z.guid(),
}).strict();
export const taskRecoveryRemediateInputSchema = taskRecoveryIssueInputSchema.extend({
  outcomeCriteria: z.string().trim().min(1).max(4000).nullable().optional(),
  expiresInMinutes: z.number().int().min(1).max(120).optional(),
}).strict();
export const taskRecoveryRemediateReceiptSchema = z.object({
  authorized: z.literal(true),
  permit: taskRecoveryPermitSchema,
  runId: z.guid(),
  wakeupRequestId: z.guid(),
  runStatus: z.string(),
  expiresAt: z.string(),
}).strict();
// AgentDash (GH #891): the web app's "Authorize one run" (board session user).
// Review first (preview), then apply with the preconditions the preview returned.
export const taskRecoveryAuthorizeRunPreviewSchema = z.object({
  outcomeCriteria: z.string().trim().min(1).max(4000).nullable().optional(),
  expiresInMinutes: z.number().int().min(1).max(120).optional(),
}).strict();
export const taskRecoveryAuthorizeRunSchema = taskRecoveryAuthorizeRunPreviewSchema.extend({
  preconditions: z.record(z.string(), z.unknown()),
}).strict();
export type TaskRecoveryAuthorizeRunInput = z.infer<typeof taskRecoveryAuthorizeRunSchema>;
export type TaskRecoveryPermit = z.infer<typeof taskRecoveryPermitSchema>;
export type TaskRecoveryExhaustedIssue = z.infer<typeof taskRecoveryExhaustedIssueSchema>;
export type TaskRecoveryRemediateInput = z.input<typeof taskRecoveryRemediateInputSchema>;
export type TaskRecoveryRemediateReceipt = z.infer<typeof taskRecoveryRemediateReceiptSchema>;
