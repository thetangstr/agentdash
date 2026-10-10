// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CompanyProvider } from '@/context/CompanyContext';
import { WorkforceAgentPanel } from '@/pages/WorkforceOnboarding';
import { TooltipProvider } from './ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient;
let requests: {url:string; method:string; body:unknown}[], lost = false, cancelled = false, answered = false;
let multiple = false, lostReplacement = false, secondCancelled = false;
let created: typeof owned[] = [];
const metadata = { issueId: 'job', interactionId: 'old', status: 'pending', updatedAt: '2026-09-29T00:00:00.000000Z', reason: 'original_owner_unavailable' };
const receipt = { issueId: 'job', interactionId: 'old', status: 'cancelled', replacementRequired: true };
const owned = { id: 'new', issueId: 'job', companyId: 'one', kind: 'ask_user_questions', status: 'pending', payload: { version: 1, answerOwnerUserId: 'bob', workforceAgentId: 'worker', replacesInteractionId: 'old', questions: [{ id: 'required', prompt: 'Your replacement question', required: true, selectionMode: 'text', options: [] }] }, result: null, createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z' };
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve,20)); }); }
async function click(text: string) { const b = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text); expect(b, text).toBeTruthy(); await act(async () => b!.click()); await flush(); }
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); requests = []; lost = false; cancelled = false; answered = false;
  sessionStorage.clear(); multiple = false; lostReplacement = false; secondCancelled = false; created = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : null; requests.push({ url, method, body });
    let data: unknown = [];
    if (url.endsWith('/enrollment')) data = { id:'enrollment', companyId:'one', agentId:'worker', templateId:'marketing-content', templateVersion:1, firstJobIssueId:'job', metrics:[], installedSkillKeys:[] };
    else if (url.endsWith('/readiness')) return Response.json({ error: 'Readiness is private' }, { status:404 });
    else if (url.endsWith('/members')) return Response.json({ error: 'Member directory denied' }, { status:403 });
    else if (url.includes('/auth/')) data = { user:{id:'bob'}, session:{userId:'bob'} };
    else if (url.endsWith('/question-recovery')) data = { items:[...(!cancelled ? [metadata] : []), ...(multiple && !secondCancelled ? [{...metadata,interactionId:'second'}] : [])], nextCursor:null };
    else if (url.includes('/question-recovery?')) data = { items:cancelled ? [receipt] : [metadata], nextCursor:null };
    else if (url.endsWith('/old/cancel')) { cancelled = true; if (lost) throw new TypeError('Lost response'); data = receipt; }
    else if (url.endsWith('/old/replace')) { created = [owned]; if (lostReplacement) throw new TypeError('Lost replacement response'); data = owned; }
    else if (url.endsWith('/new/cancel')) data = {...owned,status:'cancelled'};
    else if (url.endsWith('/new/replace')) data = {...owned,id:'newer',payload:{...owned.payload,replacesInteractionId:'new'}};
    else if (url.endsWith('/second/cancel')) { secondCancelled = true; data = {...receipt,interactionId:'second'}; }
    else if (url.endsWith('/new/respond')) { answered = true; data = { ...owned, status:'answered', result:{version:1,answers:(body as any).answers} }; }
    else if (url.endsWith('/interactions')) data = created.map(q => answered ? {...q,status:'answered'} : q);
    return Response.json(data);
  }));
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });
function mount() { act(() => root.render(<QueryClientProvider client={client}><MemoryRouter><CompanyProvider><TooltipProvider><WorkforceAgentPanel companyId="one" agent={{ id:'worker',companyId:'one',name:'Mira',adapterType:'codex_local',accountable:{userId:'bob',name:'Bob',via:'assignment'} } as any} /></TooltipProvider></CompanyProvider></MemoryRouter></QueryClientProvider>)); }
it('recovers independently of readiness404 or member-list403, confirms, then answers only the newly owned card', async () => {
  const existing = [{...owned,id:'existing'}];
  client.setQueryData(queryKeys.issues.interactions('job'),existing);
  mount(); await flush(); await flush();
  expect(host.textContent).toContain('Readiness is private');
  await click('Recover required question');
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  expect(document.body.textContent).toContain('Dependent work stays held');
  await click('Confirm cancellation');
  expect(requests.find(r => r.url.endsWith('/old/cancel'))?.body).toEqual({expectedUpdatedAt: metadata.updatedAt});
  expect(client.getQueryData(queryKeys.issues.interactions('job'))).toEqual(existing);
  expect(host.querySelector('[aria-label="Required question recovery"] textarea')).toBeNull();
  await click('Create replacement question');
  expect(requests.find(r => r.url.endsWith('/old/replace'))?.body).toEqual({});
  expect(host.textContent).toContain('Your replacement question');
  const textarea = host.querySelector('[aria-label="Required question recovery"] textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'My genuine answer'); textarea.dispatchEvent(new Event('input',{bubbles:true})); });
  await click('Submit answers');
  expect(answered).toBe(true);
  expect(requests.find(r => r.url.endsWith('/new/respond'))?.body).toMatchObject({answers:[{questionId:'required',optionIds:[],text:'My genuine answer'}],shareWithCompany:false});
  expect(requests.some(r => r.url.includes('/old/respond'))).toBe(false);
  expect(host.querySelector('[aria-label="Required question recovery"] textarea')).toBeNull();
});
it('shows uncertain cancellation and inspects safe state without replaying the mutation', async () => {
  lost = true; mount(); await flush(); await flush(); await click('Recover required question'); await click('Confirm cancellation');
  expect(host.textContent).toContain('Cancellation outcome is uncertain');
  expect(requests.filter(r => r.url.endsWith('/old/cancel'))).toHaveLength(1);
  await click('Inspect current recovery state');
  expect(requests.filter(r => r.url.endsWith('/old/cancel'))).toHaveLength(1);
  expect(host.textContent).toContain('Create replacement question');
});

async function reload() {
  act(() => root.unmount()); client.clear(); root = createRoot(host); mount(); await flush(); await flush();
}
async function answerReplacement() {
  const textarea = host.querySelector('[aria-label="Required question recovery"] textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Genuine answer'); textarea.dispatchEvent(new Event('input',{bubbles:true})); });
  await click('Submit answers');
}
it('restores a cancelled target after reload using fresh safe inspection, without another cancellation',async()=>{
  mount();await flush();await flush();await click('Recover required question');await click('Confirm cancellation');
  await reload();await click('Inspect current recovery state');
  expect(host.textContent).toContain('Create replacement question');
  expect(requests.filter(r=>r.url.endsWith('/old/cancel'))).toHaveLength(1);
  expect(JSON.stringify(sessionStorage)).not.toContain('Your replacement question');
});
it('restores an owned replacement after reload and answers it while readiness stays private',async()=>{
  mount();await flush();await flush();await click('Recover required question');await click('Confirm cancellation');await click('Create replacement question');
  await reload();await click('Inspect current recovery state');
  expect(host.textContent).toContain('Your replacement question');await answerReplacement();expect(answered).toBe(true);
  expect(requests.filter(r=>r.url.endsWith('/old/replace'))).toHaveLength(1);
});
it('inspects a lost replacement response without replay and without treating absence as noncommit',async()=>{
  lostReplacement=true;mount();await flush();await flush();await click('Recover required question');await click('Confirm cancellation');await click('Create replacement question');
  const saved=created;created=[];await click('Inspect current recovery state');
  expect(host.textContent).toContain('does not establish whether replacement committed');
  created=saved;await click('Inspect current recovery state');expect(host.textContent).toContain('Your replacement question');
  expect(requests.filter(r=>r.url.endsWith('/old/replace'))).toHaveLength(1);
});
it('continues to a second recoverable question after answering the first owned replacement',async()=>{
  multiple=true;mount();await flush();await flush();await click('Recover required question');await click('Confirm cancellation');await click('Create replacement question');await answerReplacement();
  await click('Recover another question');await click('Recover required question');await click('Confirm cancellation');
  expect(requests.filter(r=>r.url.endsWith('/old/cancel'))).toHaveLength(1);
  expect(requests.filter(r=>r.url.endsWith('/second/cancel'))).toHaveLength(1);
  expect(host.textContent).toContain('Create replacement question');
});

it('keeps an explicitly cancelled new owned card replaceable instead of leaving a stale answer form',async()=>{
  mount();await flush();await flush();await click('Recover required question');await click('Confirm cancellation');await click('Create replacement question');
  await click('Cancel question');
  expect(host.querySelector('[aria-label="Required question recovery"] textarea')).toBeNull();
  await click('Create replacement question');
  expect(requests.filter(r=>r.url.endsWith('/new/replace'))).toHaveLength(1);
  expect(host.querySelector('[aria-label="Required question recovery"] textarea')).not.toBeNull();
});
