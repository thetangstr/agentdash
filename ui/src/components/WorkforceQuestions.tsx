import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { Agent, WaitingOnYouQuestion } from '@paperclipai/shared';
import { Link } from '@/lib/router';
import { issuesApi, type QuestionRecoveryPreview } from '@/api/issues';
import { authApi } from '@/api/auth';
import { accessApi } from '@/api/access';
import { queryKeys } from '@/lib/queryKeys';
import { workforceKeys } from '@/api/workforce';
import { IssueThreadInteractionCard } from './IssueThreadInteractionCard';
import { Button } from './ui/button';
import type { AskUserQuestionsInteraction } from '@/lib/issue-thread-interactions';

function useQuestionActions(companyId: string, issueId: string) {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.issues.interactions(issueId) }),
      client.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) }),
      client.invalidateQueries({ queryKey: queryKeys.home.waitingOnYou(companyId) }),
      client.invalidateQueries({ queryKey: workforceKeys.all(companyId) }),
    ]);
  };
}
function QuestionCard({ companyId, question }: { companyId: string; question: AskUserQuestionsInteraction }) {
  const refresh = useQuestionActions(companyId, question.issueId);
  const [error, setError] = useState<string | null>(null);
  async function perform(action: () => Promise<unknown>) { setError(null); try { await action(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Question update failed"); } }
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  return <div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<IssueThreadInteractionCard interaction={question} currentUserId={session.data?.user?.id ?? session.data?.session?.userId ?? null}
    onSubmitInteractionAnswers={(q, answers, shareWithCompany) => perform(() => issuesApi.respondToInteraction(q.issueId, q.id, { answers, shareWithCompany }))}
    onCancelInteraction={q => perform(() => issuesApi.cancelInteraction(q.issueId, q.id, 'Explicit human cancellation; required input remains unresolved'))} />
  </div>;
}
export function PendingQuestionRow({ companyId, question }: { companyId: string; question: WaitingOnYouQuestion }) {
  const interactions = useQuery({ queryKey: queryKeys.issues.interactions(question.issueId), queryFn: () => issuesApi.listInteractions(question.issueId) });
  const interaction = interactions.data?.find(q => q.id === question.interactionId && q.kind === 'ask_user_questions');
  return <li className="space-y-3 p-4" data-testid="pending-question-row">
    <div className="text-sm">
      <Link disableIssueQuicklook className="font-medium underline" to={`/issues/${question.identifier ?? question.issueId}#interaction-${question.interactionId}`}>{question.identifier} {question.issueTitle}</Link>
      <p className="text-muted-foreground">Answer owner: {question.answerOwnerName} · {question.questionSummary}</p>
    </div>{interactions.error && <p role="alert" className="text-sm text-destructive">{interactions.error.message}</p>}{interaction?.kind === 'ask_user_questions' && interaction.status === 'pending' && <QuestionCard key={interaction.id} companyId={companyId} question={interaction} />}</li>;
}
function QuestionRecovery({ companyId, issueId }: { companyId: string; issueId: string }) {
  const refresh = useQuestionActions(companyId, issueId);
  const recovery = useQuery({ queryKey: ['question-recovery', companyId, issueId], queryFn: () => issuesApi.questionRecovery(issueId) });
  const [review, setReview] = useState<{ interactionId: string; action: 'cancel' | 'replace'; preview: QuestionRecoveryPreview } | null>(null);
  const prepare = useMutation({ mutationFn: async ({ interactionId, action }: { interactionId: string; action: 'cancel' | 'replace' }) => {
    setReview(null);
    const preview = await issuesApi.previewQuestionRecovery(issueId, interactionId, action);
    setReview({ interactionId, action, preview });
  } });
  const confirm = useMutation({ retry: false, mutationFn: async () => {
    if (!review) return;
    // Clear the reviewed action before sending. An unknown acknowledgment must
    // require reading current state, never a second click/replayed mutation.
    const current = review; setReview(null);
    try { await issuesApi.confirmQuestionRecovery(issueId, current.interactionId, current.action, current.preview.preconditions); }
    finally { await recovery.refetch(); await refresh(); }
  } });
  return <div className="space-y-2">
    {(recovery.error || prepare.error || confirm.error) && <p role="alert" className="text-sm text-destructive">{(recovery.error || prepare.error || confirm.error)?.message} Read current question state before trying another action.</p>}
    {recovery.data?.questions?.map(q => <div key={q.interactionId} className="space-y-2 rounded border p-3">
      <p className="text-sm">{q.status === 'pending' ? 'A required question belongs to someone who is no longer active.' : 'The inactive-owner question was cancelled. Required input still holds this task.'}</p>
      <Button variant="outline" disabled={prepare.isPending || confirm.isPending} onClick={() => prepare.mutate({ interactionId: q.interactionId, action: q.status === 'pending' ? 'cancel' : 'replace' })}>{q.status === 'pending' ? 'Review inactive-owner cancellation' : 'Review replacement'}</Button>
    </div>)}
    {review && <div className="space-y-2 rounded border p-3" role="group" aria-label="Review question recovery">
      {review.preview.readback.context.effects?.map(effect => <p key={effect} className="text-sm">{effect}</p>)}
      {review.preview.readback.context.replacement?.payload.questions.map(q => <p key={q.id} className="text-sm">{q.prompt}</p>)}
      <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>{review.action === 'cancel' ? 'Confirm cancellation' : 'Confirm replacement'}</Button>
      <Button variant="ghost" onClick={() => setReview(null)}>Dismiss</Button>
    </div>}
  </div>;
}
export function WorkforceQuestions({ companyId, issueId, agent, requiredIds }: { companyId: string; issueId: string; agent: Agent; requiredIds: string[] }) {
  const refresh = useQuestionActions(companyId, issueId);
  const interactions = useQuery({ queryKey: queryKeys.issues.interactions(issueId), queryFn: () => issuesApi.listInteractions(issueId) });
  const members = useQuery({ queryKey: ['workforce-members', companyId], queryFn: () => accessApi.listMembers(companyId) });
  const activeIds = new Set(members.data?.members.filter(m => m.status === 'active').map(m => m.principalId));
  const replace = useMutation({
    mutationFn: async (q: AskUserQuestionsInteraction) => {
      // Preserve question IDs, prompts, required keys and origin. The server resolves
      // the current accountable person and verifies every ownership boundary.
      await issuesApi.createInteraction(issueId, { kind: 'ask_user_questions', payload: { ...q.payload, answerOwnerUserId: undefined, replacesInteractionId: q.id }, idempotencyKey: `workforce-replace:${q.id}` });
      await refresh();
    }
  });
  return <div className="space-y-3">
    <h3 className="font-medium">Questions holding this job</h3>
    <QuestionRecovery companyId={companyId} issueId={issueId} />
    <p className="text-sm text-muted-foreground">Cancelling a required question does not release work. Replace it explicitly after assigning an active accountable person.</p>{(interactions.error || members.error || replace.error) && <p role="alert" className="text-sm text-destructive">{(interactions.error || members.error || replace.error)?.message}</p>}{interactions.data?.filter(q => requiredIds.includes(q.id) && q.kind === 'ask_user_questions').map(q => q.kind === 'ask_user_questions' && <div key={q.id} className="space-y-2">
      <QuestionCard companyId={companyId} question={q} />{q.payload.answerOwnerUserId && members.data && !activeIds.has(q.payload.answerOwnerUserId) && <p role="alert" className="text-sm">This question's original owner is no longer active. Cancel it, then replace it for the current accountable person.</p>}{q.status === 'cancelled' && (agent.accountable && activeIds.has(agent.accountable.userId) ? <Button variant="outline" disabled={replace.isPending} onClick={() => replace.mutate(q)}>Replace question for current accountable person</Button> : <a className="text-sm underline" href="#workforce-accountability">Assign an active accountable person to replace this question</a>)}</div>)}</div>;
}
