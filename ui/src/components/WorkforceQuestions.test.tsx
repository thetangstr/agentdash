// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanyProvider } from '@/context/CompanyContext';
import { PendingQuestionRow, WorkforceQuestions } from './WorkforceQuestions';
import { TooltipProvider } from './ui/tooltip';
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let failAnswer = false;
let requests: any[];
let question: any;
const row = { interactionId: 'question', issueId: 'job', identifier: 'AC-1', issueTitle: 'First campaign', title: 'Audience', questionSummary: 'Who is the audience?', waitingSince: '2026-09-29T00:00:00Z', answerOwnerUserId: 'human', answerOwnerName: 'Dana' };
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 20)); }); }
async function click(text: string) { const b = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!; expect(b).toBeTruthy(); await act(async () => b.click()); await flush(); }
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); failAnswer = false; requests = [];
  question = { id: 'question', companyId: 'one', issueId: 'job', kind: 'ask_user_questions', status: 'pending', payload: { version: 1, answerOwnerUserId: 'human', workforceAgentId: 'a', title: 'Audience', questions: [{ id: 'audience', prompt: 'Who is the audience?', selectionMode: 'text', companyFactKey: 'audience', required: true, options: [] }] }, result: null, createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', createdByAgentId: 'a' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : null; requests.push({ url, body });
    let data: any = [];
    if (url.endsWith('/interactions') && init?.method === 'POST') { question = { ...question, id: 'replacement', status: 'pending', payload: { ...body.payload, answerOwnerUserId: 'new-human' } }; data = question; }
    else if (url.endsWith('/interactions')) data = [question];
    else if (url.endsWith('/respond')) { if (failAnswer) return new Response(JSON.stringify({ error: 'Answer rejected; member changed' }), { status: 409 }); question = { ...question, status: 'answered', result: { answers: body.answers } }; data = question; }
    else if (url.endsWith('/cancel')) { question = { ...question, status: 'cancelled' }; data = question; }
    else if (url.endsWith('/members')) data = { members: [{ principalId: 'new-human', status: 'active' }], access: {} };
    else if (url.includes('/auth/')) data = null;
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });
function render(recovery = false) {
  act(() => root.render(<QueryClientProvider client={client}>
    <MemoryRouter>
      <CompanyProvider>
        <TooltipProvider>{recovery ? <WorkforceQuestions companyId="one" issueId="job" requiredIds={['question']} agent={{ id: 'a', accountable: { userId: 'new-human', name: 'Nora', via: 'assignment' } } as any} /> : <ul>
          <PendingQuestionRow companyId="one" question={row} />
        </ul>}</TooltipProvider>
      </CompanyProvider>
    </MemoryRouter>
  </QueryClientProvider>));
}
async function answer() { const field = host.querySelector('textarea')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Small businesses'); field.dispatchEvent(new Event('input', { bubbles: true })); }); await click('Submit answers'); }
it('answers the real card with explicit task scope and refreshes attention', async () => { render(); await flush(); await flush(); expect(host.textContent).toContain('Answer owner: Dana'); expect(host.textContent).toContain('First campaign'); await answer(); expect(requests.find(r => r.url.endsWith('/respond')).body).toMatchObject({ shareWithCompany: false, answers: [{ questionId: 'audience', text: 'Small businesses', optionIds: [] }] }); expect(host.querySelector('textarea')).toBeNull(); });
it('shows a respond failure and retains the typed answer for recovery', async () => { failAnswer = true; render(); await flush(); await flush(); await answer(); expect(host.textContent).toContain('Answer rejected; member changed'); expect(host.querySelector('textarea')?.value).toBe('Small businesses'); });
it('replaces cancelled revoked-owner input explicitly with the same required question', async () => { question.status = 'cancelled'; render(true); await flush(); await flush(); expect(host.textContent).toContain('Cancelling a required question does not release work'); await click('Replace question for current accountable person'); expect(requests.find(r => r.body?.payload?.replacesInteractionId).body).toMatchObject({ kind: 'ask_user_questions', payload: { replacesInteractionId: 'question', questions: [{ id: 'audience', companyFactKey: 'audience', required: true, prompt: 'Who is the audience?' }] } }); expect(requests.some(r => r.url.includes('/respond'))).toBe(false); act(() => root.render(<QueryClientProvider client={client}><MemoryRouter><CompanyProvider><TooltipProvider><ul><PendingQuestionRow companyId="one" question={{ ...row, interactionId: 'replacement', answerOwnerUserId: 'new-human', answerOwnerName: 'Nora' }}/></ul></TooltipProvider></CompanyProvider></MemoryRouter></QueryClientProvider>)); await flush(); expect(host.textContent).toContain('Answer owner: Nora'); await answer(); expect(requests.find(r => r.url.endsWith('/replacement/respond'))?.body.shareWithCompany).toBe(false); });
it('discovers inactive-owner recovery without a readable private question and requires a separate confirmation', async () => {
  const recoveryRows = [{ issueId: 'job', interactionId: 'question', status: 'pending', resolvedByUserId: null, resolvedAt: null }];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : null; requests.push({ url, body });
    let data: any = [];
    if (url.endsWith('/question-recovery')) data = { questions: recoveryRows };
    else if (url.endsWith('/question-recovery/preview')) data = { preconditions: { interactionUpdatedAt: 'pinned' }, readback: { context: { effects: ['Required input continues holding the same task.'] } } };
    else if (url.endsWith('/question-recovery/confirm')) { recoveryRows[0].status = 'cancelled'; data = { status: 'completed' }; }
    else if (url.endsWith('/members')) data = { members: [{ principalId: 'new-human', status: 'active' }], access: {} };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  render(true); await flush(); await flush();
  expect(host.textContent).not.toContain('Who is the audience?');
  await click('Review inactive-owner cancellation');
  expect(requests.some(r => r.url.endsWith('/confirm'))).toBe(false);
  expect(host.textContent).toContain('Required input continues holding the same task.');
  await click('Confirm cancellation');
  expect(requests.find(r => r.url.endsWith('/confirm')).body).toEqual({ interactionId: 'question', action: 'cancel', preconditions: { interactionUpdatedAt: 'pinned' } });
  expect(host.textContent).toContain('Review replacement');
  expect(requests.some(r => r.url.endsWith('/respond'))).toBe(false);
});
it('clears an uncertain cancellation and reads its durable state instead of replaying', async () => {
  let status = 'pending';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : null; requests.push({ url, body });
    let data: any = [];
    if (url.endsWith('/question-recovery')) data = { questions: [{ issueId: 'job', interactionId: 'question', status, resolvedByUserId: null, resolvedAt: null }] };
    else if (url.endsWith('/question-recovery/preview')) data = { preconditions: { interactionUpdatedAt: 'pinned' }, readback: { context: { effects: ['Required input stays held.'] } } };
    else if (url.endsWith('/question-recovery/confirm')) { status = 'cancelled'; throw new Error('Acknowledgment lost'); }
    else if (url.endsWith('/members')) data = { members: [], access: {} };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  render(true); await flush(); await flush();
  await click('Review inactive-owner cancellation'); await click('Confirm cancellation');
  expect(host.textContent).toContain('Acknowledgment lost');
  expect(host.textContent).toContain('Review replacement');
  expect(host.textContent).not.toContain('Confirm cancellation');
  expect(requests.filter(r => r.url.endsWith('/confirm'))).toHaveLength(1);
});
