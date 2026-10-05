// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanyProvider, useCompany } from '@/context/CompanyContext';
import { BreadcrumbProvider } from '@/context/BreadcrumbContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Decisions, decisionsListLength } from './Decisions';
import { Home } from './Home';
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let status: string;
const empty = { decisions: [], total: 0, shown: 0, tasksAssignedToYou: [], tasksAssignedToYouTotal: 0, otherTasksAssignedToYou: [], otherTasksAssignedToYouTotal: 0, pendingQuestions: [], pendingQuestionsTotal: 0 };
const item = { interactionId: 'q', issueId: 'job', identifier: 'ONE-1', issueTitle: 'Draft campaign', title: 'Audience', questionSummary: 'Who is the audience?', waitingSince: '2026-09-29T00:00:00Z', answerOwnerUserId: 'dana', answerOwnerName: 'Dana' };
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 25)); }); }
function Switcher() { const c = useCompany(); return <button onClick={() => c.setSelectedCompanyId('two')}>Switch company</button>; }
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); status = 'pending'; host = document.createElement('div'); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    let data: any = [];
    if (url === '/api/companies') data = [{ id: 'one', issuePrefix: 'ONE', name: 'Acme', productProfile: 'default', status: 'active' }, { id: 'two', issuePrefix: 'TWO', name: 'Beta', productProfile: 'default', status: 'active' }];
    else if (url.endsWith('/pending-decisions')) data = url.includes('/one/') && status === 'pending' ? { ...empty, pendingQuestions: [item], pendingQuestionsTotal: 1 } : empty;
    else if (url.endsWith('/interactions')) data = [{ id: 'q', issueId: 'job', companyId: 'one', kind: 'ask_user_questions', status, createdAt: '2026-09-29T00:00:00Z', createdByAgentId: 'a', payload: { version: 1, answerOwnerUserId: 'dana', title: 'Audience', questions: [{ id: 'audience', prompt: 'Who is the audience?', selectionMode: 'text', required: true, options: [] }] }, result: null }];
    else if (url.endsWith('/cancel')) { status = 'cancelled'; data = {}; }
    else if (url.endsWith('/dashboard')) data = { companyId: 'one', agents: { active: 1, running: 0, paused: 0, error: 0 }, tasks: { open: 1, inProgress: 0, blocked: 0, done: 0 }, costs: { monthSpendCents: 0, monthTokens: 0, monthRuns: 0, monthChatTurns: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 }, pendingApprovals: 0, budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 } };
    else if (url.includes('/working-now') || url.includes('/shipped')) data = { items: [], total: 0 };
    else if (url.includes('/first-run')) data = { applies: false, showHomeNudge: false };
    else if (url.includes('/auth/')) data = null;
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });
function render(home = false) {
  act(() => root.render(<QueryClientProvider client={client}>
    <MemoryRouter>
      <CompanyProvider>
        <BreadcrumbProvider>
          <TooltipProvider>
            <Switcher />{home ? <Home /> : <Decisions />}</TooltipProvider>
        </BreadcrumbProvider>
      </CompanyProvider>
    </MemoryRouter>
  </QueryClientProvider>));
}
it('shows agent-assigned input in default Decisions and removes a cancelled question from attention', async () => { render(); await flush(); await flush(); expect(host.textContent).toContain('Answer owner: Dana'); expect(host.querySelector('[data-testid="decisions-count"]')?.textContent).toBe('1'); await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Cancel question')!.click()); await flush(); expect(host.querySelector('[data-testid="decisions-count"]')?.textContent).toBe('0'); expect(host.textContent).not.toContain('Who is the audience?'); });
it('shows named questions on Home and discards the old company attention on switch', async () => { render(true); await flush(); await flush(); expect(host.textContent).toContain('Draft campaign'); expect(host.textContent).toContain('Answer owner: Dana'); await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Switch company')!.click()); await flush(); await flush(); expect(host.textContent).not.toContain('Who is the audience?'); expect(host.textContent).not.toContain('Dana'); });
it('uses uncapped question totals in the shared badge without counting machine tasks', () => { expect(decisionsListLength({ ...empty, total: 3, tasksAssignedToYouTotal: 2, pendingQuestionsTotal: 7, otherTasksAssignedToYouTotal: 20 })).toBe(12); });
