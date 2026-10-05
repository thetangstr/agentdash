// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentsApi } from '@/api/agents';
import { queryKeys } from '@/lib/queryKeys';
import { CompanyProvider } from '@/context/CompanyContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkforceAgentPanel } from './WorkforceOnboarding';

const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let agent: any;
let requests: { url: string; method: string; body: any }[];
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }

// The mounted AgentDetail consumer uses this exact company-qualified key and
// real API lookup. Keep the prop query-backed so a list-only invalidation fails.
function DetailConsumer({ routeRef }: { routeRef: string }) {
  const detail = useQuery({ queryKey: [...queryKeys.agents.detail(routeRef), 'one'], queryFn: () => agentsApi.get(routeRef, 'one') });
  return detail.data ? <WorkforceAgentPanel companyId="one" agent={detail.data} /> : null;
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  requests = [];
  agent = { id: agentId, companyId: 'one', urlKey: 'mira', name: 'Mira', adapterType: 'codex_local', autonomy: 'autonomous', accountable: null };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(init.body as string) : null;
    requests.push({ url, method, body });
    let data: any = [];
    if (method === 'PATCH' || (method === 'POST' && (url.endsWith('/agent-stewardships') || url.endsWith('/stewardship/transfer')))) {
      agent = { ...agent, accountable: { userId: 'active-human', name: 'Nora', email: 'nora@example.test', via: agent.autonomy === 'autonomous' ? 'assignment' : 'steward' } }; data = agent;
    } else if (url.startsWith('/api/agents/')) data = agent;
    else if (url.endsWith('/members')) data = { members: [{ principalId: 'active-human', principalType: 'user', status: 'active', user: { name: 'Nora' } }], access: {} };
    else if (url.endsWith('/enrollment')) data = { id: 'enrollment', companyId: 'one', agentId, templateId: 'marketing-content', templateVersion: 1, metrics: [], firstJobIssueId: 'job', installedSkillKeys: [], objective: null, goalId: null };
    else if (url.endsWith('/readiness')) data = { phase: 'needs_input', firstJobIssueId: 'job', missingFactKeys: ['audience'], pendingQuestionIds: ['question'], acceptedVerdictId: null, reason: 'Required audience' };
    else if (url.endsWith('/interactions')) data = [{ id: 'question', companyId: 'one', issueId: 'job', kind: 'ask_user_questions', status: 'cancelled', createdAt: '2026-09-29T00:00:00Z', payload: { version: 1, title: 'Audience', answerOwnerUserId: 'revoked-human', workforceAgentId: agentId, questions: [{ id: 'audience', prompt: 'Who is the audience?', required: true, selectionMode: 'text', options: [], companyFactKey: 'audience' }] } }];
    else if (url.includes('/auth/')) data = null;
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });

it.each([
  ['autonomous', 'mira', false], ['autonomous', agentId, false],
  ['stewarded', 'mira', false], ['stewarded', agentId, false],
  ['stewarded', 'mira', true], ['stewarded', agentId, true],
] as const)('refreshes %s detail at %s after assignment (transfer=%s) without reload', async (autonomy, routeRef, transfer) => {
  agent = { ...agent, autonomy, accountable: transfer ? { userId: 'revoked-human', name: 'Former owner', via: 'steward' } : null };
  const otherKey = [...queryKeys.agents.detail(routeRef), 'two'];
  const siblingKey = [...queryKeys.agents.detail('other-agent'), 'one'];
  client.setQueryData(otherKey, { ...agent, companyId: 'two' });
  client.setQueryData(siblingKey, { ...agent, id: 'other-agent' });
  act(() => root.render(<QueryClientProvider client={client}><MemoryRouter><CompanyProvider><TooltipProvider><DetailConsumer routeRef={routeRef} /></TooltipProvider></CompanyProvider></MemoryRouter></QueryClientProvider>));
  await flush(); await flush();
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text);
  expect(button('Resume first job')?.disabled).toBe(true);
  expect(button('Replace question for current accountable person')).toBeUndefined();
  const select = host.querySelector('[aria-label="Accountable person"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'active-human'); select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Assign accountable person')!.click());
  await flush(); await flush();
  expect(host.querySelector('#workforce-accountability p')?.textContent).toContain('Nora');
  expect(button('Resume first job')?.disabled).toBe(false);
  expect(button('Replace question for current accountable person')?.disabled).toBe(false);
  const mutation = requests.find(request => request.method !== 'GET');
  expect(mutation).toMatchObject(autonomy === 'autonomous'
    ? { url: `/api/agents/${agentId}?companyId=one`, method: 'PATCH', body: { accountableUserId: 'active-human' } }
    : transfer ? { url: `/api/companies/one/agents/${agentId}/stewardship/transfer`, method: 'POST', body: { userId: 'active-human' } }
    : { url: '/api/companies/one/agent-stewardships', method: 'POST', body: { agentId, userId: 'active-human' } });
  expect(mutation?.body.autonomy).toBeUndefined();
  expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
  expect(client.getQueryState(siblingKey)?.isInvalidated).toBe(false);
});
