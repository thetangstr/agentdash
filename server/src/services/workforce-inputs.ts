// AgentDash: persisted input shared by readiness, completion and dispatch gates.
import { and, asc, eq } from 'drizzle-orm';
import { companyContext, issues, issueThreadInteractions, workforceEnrollments, type Db } from '@paperclipai/db';
import { askUserQuestionsPayloadSchema, askUserQuestionsResultSchema, resolveWorkforceTemplate, type WorkforceBrief, type WorkforceRuntimeContext } from '@paperclipai/shared';

// AgentDash: server-private identities, never part of runtime/API results or a grant.
export type WorkforceQuestionSource = {
  kind: 'interaction';
  companyId: string;
  issueId: string;
  interactionId: string;
  status: string;
  answerOwnerUserId: string | null;
  resolvedByUserId: string | null;
  resolvedByAgentId: string | null;
  replacesInteractionId: string | null;
  workforceAgentId: string;
  workforceEnrollmentId: string;
  workforceTemplateId: string;
  workforceTemplateVersion: number;
} | {
  // Absent from the native eligible-question lookup, not a fabricated DB row.
  kind: 'missing_replacement';
  companyId: string;
  issueId: string;
  interactionId: string;
};
export type WorkforceSourceRole = 'required_question' | 'sufficient_answer' | 'task_fact' | 'replacement_target' | 'replacement_path';
export type WorkforceQuestionDependency = WorkforceQuestionSource & { roles: WorkforceSourceRole[] };
export interface WorkforceTaskFactSource {
  mapKey: string;
  questionId: string;
  companyFactKey?: string;
  sourceReference: string;
  source: WorkforceQuestionSource;
}
export interface WorkforceAnswerCause {
  interactionId: string;
  answeringInteractionId: string;
  path: WorkforceQuestionSource[];
}
export interface WorkforceInputObservation {
  pendingSources: WorkforceQuestionDependency[];
  taskFactSources: WorkforceTaskFactSource[];
  answerCauses: WorkforceAnswerCause[];
}

export async function workforceIssueInputs(db: Db, companyId: string, agentId: string | null, issueId: string, options?: { observeSources: (observation: WorkforceInputObservation) => void }) {
  const pendingSources = new Map<string, WorkforceQuestionDependency>();
  const taskFactSources = new Map<string, WorkforceTaskFactSource>();
  const answerCauses = new Map<string, WorkforceAnswerCause>();
  const observe = () => options?.observeSources({ pendingSources: [...pendingSources.values()], taskFactSources: [...taskFactSources.values()], answerCauses: [...answerCauses.values()] });
  const dependOn = (source: WorkforceQuestionSource, role: WorkforceSourceRole) => {
    const existing = pendingSources.get(source.interactionId);
    if (!existing) pendingSources.set(source.interactionId, { ...source, roles: [role] });
    else if (!existing.roles.includes(role)) existing.roles.push(role);
  };
  const empty = { pendingQuestionIds: [] as string[], missingFactKeys: [] as string[], taskFacts: [] as WorkforceRuntimeContext['taskFacts'] };
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  if (!issue) { observe(); return empty; }
  const [enrollment] = agentId && issue.assigneeAgentId === agentId ? await db.select().from(workforceEnrollments).where(and(eq(workforceEnrollments.companyId, companyId), eq(workforceEnrollments.agentId, agentId))) : [];
  const template = enrollment && resolveWorkforceTemplate(enrollment.templateId, enrollment.templateVersion);
  const rows = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId), eq(issueThreadInteractions.kind, 'ask_user_questions'))).orderBy(asc(issueThreadInteractions.createdAt));
  const questions = rows.map(row => ({ row, payload: askUserQuestionsPayloadSchema.parse(row.payload) })).filter(({ payload }) => payload.workforceAgentId && payload.workforceEnrollmentId && resolveWorkforceTemplate(payload.workforceTemplateId ?? '', payload.workforceTemplateVersion));
  if (!template && !questions.length) { observe(); return empty; }
  const questionSource = ({ row, payload }: typeof questions[number]): WorkforceQuestionSource => ({
    kind: 'interaction', companyId: row.companyId, issueId: row.issueId, interactionId: row.id,
    status: row.status, answerOwnerUserId: payload.answerOwnerUserId ?? null,
    resolvedByUserId: row.resolvedByUserId, resolvedByAgentId: row.resolvedByAgentId,
    replacesInteractionId: payload.replacesInteractionId ?? null,
    workforceAgentId: payload.workforceAgentId!, workforceEnrollmentId: payload.workforceEnrollmentId!,
    workforceTemplateId: payload.workforceTemplateId!, workforceTemplateVersion: payload.workforceTemplateVersion ?? 1,
  });
  const [storedBrief] = await db.select().from(companyContext).where(and(eq(companyContext.companyId, companyId), eq(companyContext.contextType, 'workforce_brief'), eq(companyContext.key, 'current')));
  const approvedFacts = storedBrief ? (JSON.parse(storedBrief.value) as WorkforceBrief).facts : [];
  const taskFacts = new Map<string, WorkforceRuntimeContext['taskFacts'][number]>();
  const answered = new Set<string>();
  for (const { row, payload } of questions) {
    if (row.status !== 'answered' || !row.resolvedByUserId || row.resolvedByAgentId || payload.answerOwnerUserId !== row.resolvedByUserId) continue;
    const origin = resolveWorkforceTemplate(payload.workforceTemplateId!, payload.workforceTemplateVersion)!;
    const result = askUserQuestionsResultSchema.parse(row.result);
    let sufficient = true;
    for (const q of payload.questions) {
      const answer = result.answers.find(a => a.questionId === q.id);
      const value = q.selectionMode === 'text' ? (answer?.optionIds.length === 0 ? answer.text?.trim() : '') : answer?.optionIds.map(id => q.options.find(o => o.id === id)?.label ?? '').filter(Boolean).join('; ');
      if (q.required && !value) sufficient = false;
      if (value && (!q.companyFactKey || origin.requiredFactKeys.includes(q.companyFactKey))) {
        const mapKey = q.companyFactKey ? `fact:${q.companyFactKey}` : `${row.id}:${q.id}`;
        const sourceReference = `interaction:${row.id}/question:${q.id}`;
        taskFacts.set(mapKey, { ...(q.companyFactKey ? { companyFactKey: q.companyFactKey } : {}), key: q.companyFactKey ?? q.id, value, issueId, sourceReference });
        if (options) taskFactSources.set(mapKey, { mapKey, questionId: q.id, ...(q.companyFactKey ? { companyFactKey: q.companyFactKey } : {}), sourceReference, source: questionSource({ row, payload }) });
      }
    }
    if (sufficient) {
      answered.add(row.id);
      let path = options ? [questionSource({ row, payload })] : [];
      if (options) answerCauses.set(row.id, { interactionId: row.id, answeringInteractionId: row.id, path });
      let previousId = payload.replacesInteractionId;
      while (previousId && !answered.has(previousId)) {
        answered.add(previousId);
        const previous = questions.find(q => q.row.id === previousId);
        if (options) {
          path = [...path, previous ? questionSource(previous) : { kind: 'missing_replacement', companyId, issueId, interactionId: previousId }];
          answerCauses.set(previousId, { interactionId: previousId, answeringInteractionId: row.id, path });
        }
        previousId = previous?.payload.replacesInteractionId;
      }
    }
  }
  const sufficientFact = (key: string) => approvedFacts.some(f => f.key === key && f.value.trim()) || taskFacts.has(`fact:${key}`);
  const pendingQuestionIds: string[] = [];
  for (const question of questions) {
    const { row, payload } = question;
    const required = payload.questions.filter(q => q.required).map(q => ({
      question: q,
      approved: Boolean(q.companyFactKey && approvedFacts.some(f => f.key === q.companyFactKey && f.value.trim())),
    }));
    // Select one sufficient proof: approved brief, then native answer, then facts.
    // Optional-only rows and approved-only answers need no private question source.
    if (required.every(q => q.approved)) continue;
    if (answered.has(row.id)) {
      if (options) {
        const path = answerCauses.get(row.id)!.path;
        for (const [index, source] of path.entries()) {
          dependOn(source, index === 0 ? 'sufficient_answer' : index === path.length - 1 ? 'replacement_target' : 'replacement_path');
        }
      }
      continue;
    }
    const factProofs: WorkforceQuestionSource[] = [];
    let pending = false;
    for (const { question: q, approved } of required) {
      if (approved) continue;
      if (!q.companyFactKey || !taskFacts.has(`fact:${q.companyFactKey}`)) {
        pending = true;
        break;
      }
      if (options) factProofs.push(taskFactSources.get(`fact:${q.companyFactKey}`)!.source);
    }
    if (pending) pendingQuestionIds.push(row.id);
    if (options) {
      dependOn(questionSource(question), 'required_question');
      // Earlier positive facts do not establish the final pending=true result.
      if (!pending) for (const source of factProofs) dependOn(source, 'task_fact');
    }
  }
  observe();
  return {
    // Cancellation stops work but does not supply an answer. Completion may
    // transition directly from cancelled to done, so retain unresolved input.
    pendingQuestionIds,
    missingFactKeys: template?.requiredFactKeys.filter(key => !sufficientFact(key)) ?? [],
    taskFacts: issue.assigneeAgentId === agentId ? [...taskFacts.values()] : [],
  };
}

/** Unscoped timer/manual wakes must not spend runs rediscovering an input hold.
 * Leave initial learning and any independent open assignment runnable.
 */
export async function workforceDispatchHold(db: Db, companyId: string, agentId: string, issueId?: string | null): Promise<string | null> {
  if (issueId) return (await workforceIssueInputs(db, companyId, agentId, issueId)).pendingQuestionIds.length ? issueId : null;
  const jobs = await db.select({ id: issues.id, status: issues.status }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentId)));
  const active = jobs.filter(job => ['todo', 'in_progress', 'blocked', 'in_review'].includes(job.status));
  if (!active.length) return null;
  for (const job of active) {
    if (!(await workforceIssueInputs(db, companyId, agentId, job.id)).pendingQuestionIds.length) return null;
  }
  return active[0].id;
}
