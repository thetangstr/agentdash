// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanyProvider } from '../context/CompanyContext';
import { WorkforceWorkspace } from './WorkforceOnboarding';
import { __liveUpdatesTestUtils } from '@/context/LiveUpdatesProvider';
import { WORKFORCE_TEMPLATES } from '@paperclipai/shared';
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let requests: { url: string; method: string; body: any }[];
let brief: any;
let enrollment: any;
let phase = 'awaiting_review';
let conflict = false;
let ownerActive = true;
let proposals: any[] = [];
const agent = { id: 'a', companyId: 'one', name: 'Mira', adapterType: 'codex_local', autonomy: 'autonomous', accountable: { userId: 'human', name: 'Dana', email: 'd@test', via: 'assignment' } };
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 20)); }); }
async function click(text: string) { const b = [...host.querySelectorAll('button')].find(b => b.textContent === text)!; expect(b, text).toBeTruthy(); await act(async () => b.click()); await flush(); }
async function field(label: string, value: string) { const el = host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement; expect(el).toBeTruthy(); await act(async () => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }
function render(companyId = 'one') {
  act(() => root.render(<QueryClientProvider client={client}>
    <MemoryRouter>
      <CompanyProvider>
        <WorkforceWorkspace key={companyId} companyId={companyId} />
      </CompanyProvider>
    </MemoryRouter>
  </QueryClientProvider>));
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); requests = []; conflict = false; ownerActive = true; proposals = []; phase = 'awaiting_review'; enrollment = null;
  brief = { revision: 1, sources: [{ id: 's', label: 'Company brief', content: 'Shared offer' }], facts: [{ key: 'offer', value: 'Consulting', sourceReference: 's' }], confirmedByUserId: 'human', updatedAt: null };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : null; requests.push({ url, method, body });
    let data: any = [];
    if (url.includes('/two/')) data = url.endsWith('/brief') ? { ...brief, revision: 0, sources: [], facts: [] } : [];
    else if (url.endsWith('/proposals')) data = proposals;
    else if (url.endsWith('/review')) { if (conflict) return new Response(JSON.stringify({ error: 'Company sources changed; request a new proposal' }), { status: 409 }); proposals = proposals.map(p => url.includes(p.id) ? { ...p, status: body.decision === 'approve' ? 'approved' : 'rejected' } : p); data = proposals[0]; }
    else if (url.endsWith('/templates')) data = WORKFORCE_TEMPLATES;
    else if (url.endsWith('/agents')) data = [agent];
    else if (url.endsWith('/members')) data = { members: [{ principalType: 'user', principalId: 'human', status: ownerActive ? 'active' : 'archived', user: { id: 'human', name: 'Dana' } }], access: { canManageMembers: true } };
    else if (url.endsWith('/brief')) { if (method === 'PUT') { if (conflict) return new Response(JSON.stringify({ error: 'Company brief revision changed' }), { status: 409 }); brief = { ...brief, ...body, revision: brief.revision + 1 }; } data = brief; }
    else if (url.endsWith('/enrollment')) { if (method === 'POST') enrollment = { id: 'e', companyId: 'one', agentId: 'a', ...body, templateVersion: 1, objective: null, metrics: [], goalId: null, learnedBriefRevision: null, firstJobIssueId: null, installedSkillKeys: [], skillInstallError: null }; if (method === 'PATCH') enrollment = { ...enrollment, ...body }; data = enrollment; }
    else if (url.endsWith('/readiness')) data = enrollment ? { phase, missingFactKeys: ['audience'], pendingQuestionIds: [], firstJobIssueId: 'job', acceptedVerdictId: phase === 'ready' ? 'verdict' : null, briefRevision: 1, learnedBriefRevision: 1, reason: 'Real evidence status' } : null;
    else if (url.endsWith('/first-job')) data = { id: 'job' };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });
it('requires explicit company-wide consent and preserves revision on conflict', async () => {
  render(); await flush(); await flush();
  expect((host.querySelector('[data-testid="save-brief"]') as HTMLButtonElement).disabled).toBe(true);
  await field('Source content 1', 'Updated shared offer');
  await act(async () => (host.querySelector('[aria-label="Share this brief company-wide"]') as HTMLInputElement).click());
  conflict = true; await click('Publish company brief');
  expect(host.textContent).toContain('Company brief revision changed');
  expect(requests.find(r => r.method === 'PUT')?.body).toMatchObject({ expectedRevision: 1, sources: [{ id: 's', content: 'Updated shared offer', label: 'Company brief' }] });
});
it('resets private drafts and selected worker on company switch', async () => {
  render(); await flush(); await flush(); await field('Source content 1', 'Unsaved secret');
  render('two'); await flush(); await flush(); expect(host.textContent).not.toContain('Mira'); expect(host.innerHTML).not.toContain('Unsaved secret');
});
it('enrolls the selected role, exposes owner and separates review from acceptance and targets', async () => {
  render(); await flush(); await flush(); await field('Workforce role', 'sales-support'); await click('Assign role');
  expect(requests.find(r => r.method === 'POST' && r.url.endsWith('/enrollment'))?.body).toEqual({ templateId: 'sales-support' });
  expect(host.textContent).toContain('Dana'); expect(host.textContent).toContain('Awaiting review'); expect(host.textContent).toContain('Outcome measurements: Unknown');
  await field('Department objective', 'Qualify 20 leads'); await click('Save department targets');
  expect(requests.find(r => r.method === 'PATCH')?.body.objective).toBe('Qualify 20 leads');
  await click('Start first job'); expect(requests.some(r => r.method === 'POST' && r.url.endsWith('/first-job'))).toBe(true);
  phase = 'ready'; await activity('issue', 'verdict_recorded', { outcome: 'passed', reviewerUserId: 'neutral-human' });
  expect(host.textContent).toContain('Neutral review accepted');
  expect([...host.querySelectorAll('button')].some(button => /^(Start|Resume) first job$/.test(button.textContent ?? ''))).toBe(false);
  expect(host.textContent).toContain('Open first job, artifacts and review');
});

it('does not start missing-input work for an inactive accountable person', async () => {
  ownerActive = false; enrollment = { id: 'e', companyId: 'one', agentId: 'a', templateId: 'sales-support', templateVersion: 1, objective: null, metrics: [], goalId: null, learnedBriefRevision: null, firstJobIssueId: null, installedSkillKeys: [], skillInstallError: null };
  render(); await flush(); await flush();
  expect(host.textContent).toContain('active assignment required');
  expect(([...host.querySelectorAll('button')].find(b => b.textContent === 'Start first job'))?.disabled).toBe(true);
});

it('exposes installation failure and retries independently from accepted evidence', async () => {
  enrollment = { id: 'e', companyId: 'one', agentId: 'a', templateId: 'sales-support', templateVersion: 1, objective: null, metrics: [], goalId: null, learnedBriefRevision: null, firstJobIssueId: null, installedSkillKeys: [], skillInstallError: 'Skill filesystem unavailable' };
  render(); await flush(); await flush(); expect(host.textContent).toContain('Skill filesystem unavailable');
  await click('Retry skill installation'); expect(requests.some(r => r.method === 'POST' && r.url.endsWith('/install-skills'))).toBe(true);
});

it('previews selected proposed facts and sources, and exposes review conflicts without publishing others', async () => {
  proposals = [{ id: 'proposal-one', agentId: 'a', status: 'proposed', briefRevision: 1, sources: brief.sources, facts: [{ key: 'audience', value: 'Local shops', sourceReference: 's' }] }];
  render(); await flush(); await flush(); expect(host.textContent).toContain('Local shops'); expect(host.textContent).toContain('Shared offer'); conflict = true; await click('Approve facts company-wide');
  expect(host.textContent).toContain('Company sources changed; request a new proposal');
  expect(requests.find(r => r.url.endsWith('/review'))).toMatchObject({ url: '/api/companies/one/workforce/proposals/proposal-one/review', body: { decision: 'approve', expectedRevision: 1 } });
  conflict = false; await click('Reject proposal'); expect(host.textContent).toContain('rejected'); expect(requests.filter(r => r.method === 'PUT')).toHaveLength(0);
});

async function activity(entityType: string, action: string, details: Record<string, unknown> | null = null) {
  await act(async () => { __liveUpdatesTestUtils.invalidateActivityQueries(client, 'one', { entityType, entityId: 'job', action, details }, { userId: null, agentId: null }); });
  await flush();
}
it('follows neutral pass then later failure through the production activity handler', async () => {
  enrollment = { id: 'e', companyId: 'one', agentId: 'a', templateId: 'marketing-content', templateVersion: 1, metrics: [], firstJobIssueId: 'job' };
  render(); await flush(); await flush(); expect(host.textContent).toContain('Awaiting review');
  phase = 'ready'; await activity('issue', 'verdict_recorded', { outcome: 'passed', reviewerUserId: 'neutral-human' });
  expect(host.textContent).toContain('Ready for work'); expect(host.textContent).toContain('Neutral review accepted');
  phase = 'awaiting_review'; await activity('issue', 'verdict_recorded', { outcome: 'failed', reviewerUserId: 'neutral-human' });
  expect(host.textContent).toContain('Awaiting review'); expect(host.textContent).not.toContain('Neutral review accepted');
});
it.each([
  ['workforce', 'workforce.brief_updated', 'refresh_needed', 'Company context needs refresh'],
  ['workforce', 'workforce.learning_acknowledged', 'ready', 'Ready for work'],
  ['issue', 'issue.document_updated', 'awaiting_review', 'Awaiting review'],
  ['issue', 'issue.work_product_deleted', 'working', 'Working on first job'],
  ['issue', 'issue.updated', 'needs_input', 'Needs input'],
])('refreshes mounted readiness for %s %s', async (entity, action, nextPhase, label) => {
  enrollment = { id: 'e', companyId: 'one', agentId: 'a', templateId: 'marketing-content', templateVersion: 1, metrics: [], firstJobIssueId: 'job' };
  phase = nextPhase === 'ready' ? 'learning' : 'ready';
  render(); await flush(); await flush();
  phase = nextPhase; await activity(entity, action);
  expect(host.textContent).toContain(label);
  if (nextPhase !== 'ready') expect(host.textContent).not.toContain('Neutral review accepted');
});
