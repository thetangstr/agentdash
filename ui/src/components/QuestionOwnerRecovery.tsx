import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AskUserQuestionsInteraction, QuestionRecoveryMetadata, QuestionRecoveryReceipt } from '@paperclipai/shared';
import { questionRecoveryApi, questionRecoveryKeys } from '@/api/workforce';
import { issuesApi } from '@/api/issues';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog';
import { QuestionCard, useQuestionActions } from './WorkforceQuestions';

// Only IDs and the attempted action survive a reload. Every resumed view must
// obtain fresh authorized data; storage is neither a receipt nor authority.
type RecoveryAttempt = { interactionId: string; phase: 'cancel' | 'replace' };
function savedAttempt(key: string): RecoveryAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return value && typeof value.interactionId === 'string' && ['cancel', 'replace'].includes(value.phase) ? value : null;
  } catch { return null; }
}
export function QuestionOwnerRecovery(props: { companyId: string; issueId: string }) {
  return <RecoveryForIssue key={`${props.companyId}:${props.issueId}`} {...props} />;
}
function RecoveryForIssue({ companyId, issueId }: { companyId: string; issueId: string }) {
  const client = useQueryClient();
  const refreshQuestions = useQuestionActions(companyId, issueId);
  const [cursor, setCursor] = useState<string>();
  const metadata = useQuery({ queryKey: questionRecoveryKeys.list(companyId, issueId, cursor), queryFn: () => questionRecoveryApi.list(issueId, { cursor }), retry: false });
  const [confirm, setConfirm] = useState<QuestionRecoveryMetadata | null>(null);
  const [receipt, setReceipt] = useState<QuestionRecoveryReceipt | null>(null);
  const storageKey = `question-recovery:${companyId}:${issueId}`;
  const [uncertain, setUncertain] = useState<RecoveryAttempt | null>(() => savedAttempt(storageKey));
  const [replacement, setReplacement] = useState<AskUserQuestionsInteraction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  function remember(attempt: RecoveryAttempt | null) {
    try {
      if (attempt) sessionStorage.setItem(storageKey, JSON.stringify(attempt));
      else sessionStorage.removeItem(storageKey);
    } catch { /* The current view remains usable when browser storage is disabled. */ }
  }
  function showOwnedQuestion(value: AskUserQuestionsInteraction) {
    if (value.status === 'cancelled') {
      setReplacement(null);
      setReceipt({ issueId, interactionId: value.id, status: 'cancelled', replacementRequired: true });
      remember({ interactionId: value.id, phase: 'cancel' });
    } else {
      setReplacement(value);
      if (value.status === 'answered') remember(null);
    }
  }
  async function refresh() {
    await Promise.all([refreshQuestions(), client.invalidateQueries({ queryKey: questionRecoveryKeys.all(companyId, issueId) })]);
  }
  async function cancel() {
    if (!confirm || busy) return;
    const selected = confirm;
    setConfirm(null); setBusy(true); setError(null);
    const attempt: RecoveryAttempt = { interactionId: selected.interactionId, phase: 'cancel' };
    remember(attempt);
    try { setReceipt(await questionRecoveryApi.cancel(issueId, selected.interactionId, selected.updatedAt)); await refresh(); }
    catch { setUncertain(attempt); }
    finally { setBusy(false); }
  }
  async function inspect() {
    if (!uncertain || busy) return;
    setBusy(true); setError(null);
    try {
      if (uncertain.phase === 'replace') {
        const rows = await issuesApi.listInteractions(issueId);
        const owned = rows.find(value => value.kind === 'ask_user_questions' && value.payload.replacesInteractionId === uncertain.interactionId);
        if (owned?.kind === 'ask_user_questions') {
          showOwnedQuestion(owned); setUncertain(null);
          await refresh();
        } else setError('No authorized replacement is visible. This does not establish whether replacement committed. Keep inspecting; do not repeat the uncertain action.');
      } else {
        const state = await questionRecoveryApi.list(issueId, { interactionId: uncertain.interactionId });
        const current = state.items.find(value => value.interactionId === uncertain.interactionId);
        if (current?.status === 'cancelled') { setReceipt(current); setUncertain(null); await refresh(); }
        else setError('Cancellation is not confirmed. Keep inspecting current state; do not repeat the uncertain action.');
      }
    } catch { setError('Current recovery state is unavailable. This does not establish whether the attempted action committed.'); }
    finally { setBusy(false); }
  }
  async function replace() {
    if (!receipt || busy) return;
    setBusy(true); setError(null);
    const attempt: RecoveryAttempt = { interactionId: receipt.interactionId, phase: 'replace' };
    remember(attempt);
    try { setReplacement(await questionRecoveryApi.replace(issueId, receipt.interactionId)); await refresh(); }
    catch { setUncertain(attempt); }
    finally { setBusy(false); }
  }
  const pending = metadata.data?.items.filter((value): value is QuestionRecoveryMetadata => value.status === 'pending') ?? [];
  if (!pending.length && !receipt && !replacement && !uncertain && !metadata.error && !cursor) return null;
  return <section className="space-y-3 rounded-lg border p-3" aria-label="Required question recovery">
    <h3 className="font-medium">Required question recovery</h3>
    <p className="text-sm text-muted-foreground">An unavailable original owner can leave required input unresolved. Cancelling supplies no answer.</p>
    {metadata.error && <p role="alert">Recovery metadata is unavailable: {metadata.error.message}</p>}
    {error && <p role="alert">{error}</p>}
    {!uncertain && !receipt && !replacement && pending.map(value => <div key={value.interactionId}><Button variant="outline" disabled={busy} onClick={() => setConfirm(value)}>Recover required question</Button></div>)}
    {!receipt && !replacement && !uncertain && metadata.data?.nextCursor && <Button variant="outline" onClick={() => setCursor(metadata.data!.nextCursor!)}>More recoverable questions</Button>}
    {cursor && <Button variant="outline" onClick={() => setCursor(undefined)}>First recovery page</Button>}
    {uncertain && <div className="space-y-2"><p role="alert">{uncertain.phase === 'cancel' ? 'Cancellation' : 'Replacement'} outcome is uncertain. It may have committed. Do not repeat it.</p><Button disabled={busy} onClick={() => void inspect()}>Inspect current recovery state</Button></div>}
    {receipt && !replacement && !uncertain && <div className="space-y-2"><p>Question cancelled. Dependent work stays held until a replacement receives a genuine answer.</p><Button disabled={busy || Boolean(error)} onClick={() => void replace()}>Create replacement question</Button></div>}
    {replacement && <QuestionCard companyId={companyId} question={replacement} onUpdated={showOwnedQuestion} />}
    {replacement && replacement.status !== 'pending' && pending.length > 0 && <Button variant="outline" onClick={() => { setReceipt(null); setReplacement(null); setError(null); setCursor(undefined); remember(null); }}>Recover another question</Button>}
    <Dialog open={Boolean(confirm)} onOpenChange={open => { if (!open) setConfirm(null); }}><DialogContent><DialogTitle>Cancel unanswered question?</DialogTitle><DialogDescription>Dependent work stays held. A separate replacement and your genuine answer are still required.</DialogDescription><DialogFooter><Button variant="outline" onClick={() => setConfirm(null)}>Go back</Button><Button disabled={busy} onClick={() => void cancel()}>Confirm cancellation</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
