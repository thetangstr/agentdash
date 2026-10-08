// AgentDash: explicit human transport targets are request boundaries, not grants.
export type HumanTarget =
  | { kind: 'company'; companyId: string }
  | { kind: 'self' }
  | { kind: 'instance' }
  | { kind: 'public' };

export const HUMAN_OPERATION_IDS = [
  'workforce.templates.list', 'workforce.brief.read', 'workforce.brief.publish',
  'workforce.proposals.list', 'workforce.proposals.review',
  'workforce.enrollment.read', 'workforce.enrollment.create', 'workforce.enrollment.update',
  'workforce.readiness.read', 'workforce.learning.acknowledge',
  'workforce.skills.retry', 'workforce.first_job.start',
  'human_questions.pending.list', 'human_questions.read', 'human_questions.respond',
  'human_questions.cancel', 'human_questions.replace',
  'human_questions.recovery.list', 'human_questions.recovery.cancel',
  'human_questions.owner.assign', 'human_questions.stewardship.assign', 'human_questions.stewardship.transfer',
  'task_recovery.exhausted.read', 'task_recovery.remediate',
] as const;
export type HumanOperationId = typeof HUMAN_OPERATION_IDS[number];
export interface HumanOperationDescriptor {
  operationId: HumanOperationId;
  version: 1;
  pageId: 'workforce' | 'inbox';
  actionId: string;
  targetKind: HumanTarget['kind'];
  behavior: 'read' | 'prepare_confirm';
  authority: 'company_access' | 'company_direction' | 'exact_question_owner' | 'current_accountable_human' | 'agent_management';
  confirmation: 'none' | 'human_readback';
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  content: { fullText: true; pagination: 'none' | 'cursor' | 'offset' };
}
