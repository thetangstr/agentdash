// AgentDash: explicit trusted-local-human mode, using the existing board key.
import { z } from 'zod';
import { humanConfirmRequestSchema, humanDiscoverRequestSchema, humanOperationRequestSchema, humanTargetSchema, type HumanTarget } from '@paperclipai/shared';
import type { PaperclipMcpConfig } from './config.js';
import type { ToolDefinition } from './tools.js';

export const HUMAN_PLAYBOOK = `You relay the signed-in human's intent. Call human_identity and explicitly select an authorized target. Discover operation schemas before use. Never infer a company from source content. For each mutation, prepare, show the complete readback including sharing and execution effects, and obtain the person's consent before confirm. personSaid is context, never proof of consent. A handle is permanently bound to its original target. Required browser security ceremonies must still be completed. On recovery_required, inspect the canonical resource and report uncertainty; never blindly repeat an unknown effect. For an inactive pinned question owner, use human_questions.recovery.list with the issueId for safe metadata, then explicitly prepare/confirm human_questions.recovery.cancel. Only the exact active current accountable human may cancel; required input stays held until explicit human_questions.replace and a genuine replacement answer. Never infer an answer or replay an uncertain confirmation. This human surface currently covers only the operations returned by discovery. Other page families remain pending.`;

export function assertHumanConfig(config: PaperclipMcpConfig) {
  if (!config.apiKey.startsWith('pcp_board_') || config.agentId || config.runId) throw new Error('Human mode requires an existing board key and no agent or run identity');
  const url = new URL(config.apiUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Human mode requires a credential-free API base URL');
}
class HumanBridgeRefusal extends Error {
  constructor(readonly result: Record<string, unknown>) { super('Human bridge refused'); }
}
async function request(config: PaperclipMcpConfig, action: 'identity' | 'discover' | 'read' | 'prepare' | 'confirm', body?: unknown) {
  assertHumanConfig(config);
  // Fixed paths and error-on-redirect prevent a caller or server redirect from
  // switching the credential-bearing origin. Never print transport exceptions.
  const response = await fetch(`${config.apiUrl.replace(/\/+$/, '')}/human-control/${action}`, {
    method: action === 'identity' ? 'GET' : 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { details?: unknown };
    const details = z.object({
      status: z.enum(['prepared', 'completed', 'denied', 'stale', 'expired', 'recovery_required']).optional(),
      actionId: z.string().uuid().optional(),
      result: z.object({ reference: z.object({ issueId: z.string().uuid().optional(), interactionId: z.string().uuid().optional(), enrollmentId: z.string().uuid().optional() }).optional() }).nullable().optional(),
    }).safeParse(body.details ?? {});
    throw new HumanBridgeRefusal({ error: 'Human bridge refused the request. Inspect current state before retrying.', httpStatus: response.status, ...(details.success ? details.data : {}) });
  }
  return await response.json() as Record<string, unknown>;
}
export async function verifyHumanConnection(config: PaperclipMcpConfig) {
  const identity = await request(config, 'identity');
  const parsed = z.object({ source: z.literal('board_key'), user: z.object({ id: z.string().min(1) }), targets: z.array(humanTargetSchema) }).parse(identity);
  return { ...identity, user: { ...(identity.user as Record<string, unknown>), id: parsed.user.id }, targets: parsed.targets };
}
export function humanTools(config: PaperclipMcpConfig): ToolDefinition[] {
  assertHumanConfig(config);
  let selected: HumanTarget | null = config.humanTarget ?? (config.companyId ? humanTargetSchema.parse({ kind: 'company', companyId: config.companyId }) : null);
  const same = (a: HumanTarget, b: HumanTarget) => a.kind === b.kind && (a.kind !== 'company' || (b.kind === 'company' && a.companyId === b.companyId));
  function tool(name: string, description: string, schema: z.AnyZodObject, execute: (input: any) => Promise<unknown>): ToolDefinition {
    return { name, description, schema, annotations: { readOnlyHint: !['human_prepare', 'human_confirm'].includes(name), destructiveHint: name === 'human_confirm', openWorldHint: false }, execute: async raw => {
      try {
        const input = schema.parse(raw);
        const result = await execute(input);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(error instanceof HumanBridgeRefusal ? error.result : { error: 'Human operation refused. Verify the named connection, selected target, discovered schema, and current action status.' }) }] };
      }
    } };
  }
  async function selectedRequest(action: 'discover' | 'read' | 'prepare' | 'confirm', input: {target: HumanTarget}) {
    if (!selected || !same(selected, input.target)) throw new Error('Explicit target selection required');
    await verifyHumanConnection(config);
    return request(config, action, input);
  }
  return [
    tool('human_identity', 'Verify the named human and list authorized explicit target choices.', z.object({}).strict(), () => verifyHumanConnection(config)),
    tool('human_select_target', 'Explicitly select an authorized company, self, instance or public target. Existing action handles remain pinned.', z.object({ target: humanTargetSchema }).strict(), async ({ target }) => {
      const identity = await verifyHumanConnection(config);
      if (!identity.targets.some(allowed => same(allowed, target))) throw new Error('Target is not authorized');
      selected = target;
      return { selectedTarget: target };
    }),
    tool('human_discover', 'Discover finite versioned operations and exact input/output contracts for the selected target.', humanDiscoverRequestSchema, input => selectedRequest('discover', input)),
    tool('human_read', 'Read a discovered operation with its original complete authorized content.', humanOperationRequestSchema, input => selectedRequest('read', input)),
    tool('human_prepare', 'Prepare an exact mutation readback. No domain action occurs until the human consents and confirms.', humanOperationRequestSchema, input => selectedRequest('prepare', input)),
    tool('human_confirm', 'Execute only after obtaining human consent to the prepared readback. personSaid is context, not proof. Never blindly retry recovery_required.', humanConfirmRequestSchema, input => selectedRequest('confirm', input)),
  ];
}
