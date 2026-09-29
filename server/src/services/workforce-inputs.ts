// AgentDash: persisted input shared by readiness, completion and dispatch gates.
import { and, asc, eq } from 'drizzle-orm';
import { companyContext, issues, issueThreadInteractions, workforceEnrollments, type Db } from '@paperclipai/db';
import { askUserQuestionsPayloadSchema, askUserQuestionsResultSchema, resolveWorkforceTemplate, type WorkforceBrief, type WorkforceRuntimeContext } from '@paperclipai/shared';

export async function workforceIssueInputs(db: Db, companyId: string, agentId: string | null, issueId: string) {
  const empty = { pendingQuestionIds: [] as string[], missingFactKeys: [] as string[], taskFacts: [] as WorkforceRuntimeContext['taskFacts'] };
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  if (!issue) return empty;
  const [enrollment] = agentId && issue.assigneeAgentId === agentId ? await db.select().from(workforceEnrollments).where(and(eq(workforceEnrollments.companyId, companyId), eq(workforceEnrollments.agentId, agentId))) : [];
  const template = enrollment && resolveWorkforceTemplate(enrollment.templateId, enrollment.templateVersion);
  const rows = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId), eq(issueThreadInteractions.kind, 'ask_user_questions'))).orderBy(asc(issueThreadInteractions.createdAt));
  const questions = rows.map(row => ({ row, payload: askUserQuestionsPayloadSchema.parse(row.payload) })).filter(({ payload }) => payload.workforceAgentId && payload.workforceEnrollmentId && resolveWorkforceTemplate(payload.workforceTemplateId ?? '', payload.workforceTemplateVersion));
  if (!template && !questions.length) return empty;
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
        taskFacts.set(q.companyFactKey ? `fact:${q.companyFactKey}` : `${row.id}:${q.id}`, { ...(q.companyFactKey ? { companyFactKey: q.companyFactKey } : {}), key: q.companyFactKey ?? q.id, value, issueId, sourceReference: `interaction:${row.id}/question:${q.id}` });
      }
    }
    if (sufficient) {
      answered.add(row.id);
      let previousId = payload.replacesInteractionId;
      while (previousId && !answered.has(previousId)) {
        answered.add(previousId);
        previousId = questions.find(q => q.row.id === previousId)?.payload.replacesInteractionId;
      }
    }
  }
  const sufficientFact = (key: string) => approvedFacts.some(f => f.key === key && f.value.trim()) || taskFacts.has(`fact:${key}`);
  const pendingQuestionIds = questions.filter(({ row, payload }) => !answered.has(row.id) && payload.questions.some(q => q.required && (!q.companyFactKey || !sufficientFact(q.companyFactKey)))).map(({ row }) => row.id);
  return {
    pendingQuestionIds: issue.status === 'cancelled' ? [] : pendingQuestionIds,
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
