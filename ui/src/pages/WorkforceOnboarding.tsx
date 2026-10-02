import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, WorkforceBrief, WorkforceEnrollment } from '@paperclipai/shared';
import { supportsWorkforcePrompt } from '@paperclipai/shared';
import { Link } from '@/lib/router';
import { useCompany } from '@/context/CompanyContext';
import { workforceApi, workforceKeys } from '@/api/workforce';
import { agentsApi } from '@/api/agents';
import { accessApi } from '@/api/access';
import { goalsApi } from '@/api/goals';
import { stewardshipsApi } from '@/api/stewardships';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { WorkforceRoleSelect, WorkforceTemplatePreview } from '@/components/WorkforceTemplatePreview';
import { accountableLabel } from '@/components/AgentKindBadge';
import { WorkforceQuestions } from '@/components/WorkforceQuestions';

export function WorkforceError({ error }: { error: unknown }) { return error ? <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</p> : null; }

function BriefEditor({ companyId, brief }: { companyId: string; brief: WorkforceBrief }) {
  const client = useQueryClient();
  const [sources, setSources] = useState(brief.sources);
  const [facts, setFacts] = useState(brief.facts);
  const [consent, setConsent] = useState(false);
  const save = useMutation({ mutationFn: () => workforceApi.saveBrief(companyId, { expectedRevision: brief.revision, sources, facts }), onSuccess: () => { void client.invalidateQueries({ queryKey: workforceKeys.all(companyId) }); } });
  return <section id="company-brief" className="space-y-4 rounded-xl border p-5">
    <div>
      <h2 className="text-lg font-semibold">Company knowledge</h2>
      <p className="text-sm text-muted-foreground">Revision {brief.revision}. Share only information approved for everyone in this company. Task answers stay with their task unless explicitly shared.</p>
    </div>
    <div className="space-y-3">{sources.map((source, i) => <fieldset key={i} className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <legend className="px-1 text-sm font-medium">Shared source {i + 1}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label={`Source ID ${i + 1}`} placeholder="Reference ID" value={source.id} onChange={e => setSources(sources.map((s, n) => n === i ? { ...s, id: e.target.value } : s))} />
        <Input aria-label={`Source label ${i + 1}`} placeholder="Source label" value={source.label} onChange={e => setSources(sources.map((s, n) => n === i ? { ...s, label: e.target.value } : s))} />
      </div>
      <Textarea aria-label={`Source content ${i + 1}`} placeholder="Paste approved company information" value={source.content} onChange={e => setSources(sources.map((s, n) => n === i ? { ...s, content: e.target.value } : s))} />
      <Button variant="ghost" size="sm" onClick={() => setSources(sources.filter((_, n) => n !== i))}>Remove source {i + 1}</Button>
    </fieldset>)}<Button variant="outline" disabled={sources.length >= 12} onClick={() => setSources([...sources, { id: '', label: '', content: '' }])}>Add shared source</Button>
    </div>
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Human-confirmed facts</h3>{facts.map((fact, i) => <div key={i} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-3">
        <Input aria-label={`Fact key ${i + 1}`} placeholder="Fact key, e.g. offer" value={fact.key} onChange={e => setFacts(facts.map((f, n) => n === i ? { ...f, key: e.target.value } : f))} />
        <Textarea aria-label={`Fact value ${i + 1}`} placeholder="Confirmed value" value={fact.value} onChange={e => setFacts(facts.map((f, n) => n === i ? { ...f, value: e.target.value } : f))} />
        <Input aria-label={`Fact source ${i + 1}`} placeholder="Source reference" value={fact.sourceReference} onChange={e => setFacts(facts.map((f, n) => n === i ? { ...f, sourceReference: e.target.value } : f))} />
        <Button variant="ghost" size="sm" onClick={() => setFacts(facts.filter((_, n) => n !== i))}>Remove fact {i + 1}</Button>
      </div>)}<Button variant="outline" disabled={facts.length >= 40} onClick={() => setFacts([...facts, { key: '', value: '', sourceReference: '' }])}>Add confirmed fact</Button>
    </div>
    <label className="flex items-start gap-2 text-sm max-sm:min-h-11 max-sm:items-center">
      <input type="checkbox" className="mt-1 max-sm:mt-0" aria-label="Share this brief company-wide" checked={consent} onChange={e => setConsent(e.target.checked)} />I confirm these facts and explicitly share these sources company-wide.</label>
    <WorkforceError error={save.error} />
    <div className="flex gap-2">
      <Button data-testid="save-brief" disabled={!consent || save.isPending} onClick={() => save.mutate()}>Publish company brief</Button>{save.isError && <Button variant="outline" onClick={() => { void client.invalidateQueries({ queryKey: workforceKeys.brief(companyId) }); }}>Reload current revision</Button>}</div>
  </section>;
}
function ProposalReview({ companyId, revision }: { companyId: string; revision: number }) {
  const client = useQueryClient();
  const proposals = useQuery({ queryKey: [...workforceKeys.all(companyId), 'proposals'], queryFn: () => workforceApi.proposals(companyId), retry: false });
  const review = useMutation({ mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) => workforceApi.review(companyId, id, decision, revision), onSuccess: () => { void client.invalidateQueries({ queryKey: workforceKeys.all(companyId) }); } });
  return <section className="space-y-3 rounded-xl border p-5">
    <h2 className="text-lg font-semibold">Proposed company facts</h2>
    <p className="text-sm text-muted-foreground">Review exact facts and their shared sources before publishing. Approval makes these facts available company-wide.</p>
    <WorkforceError error={proposals.error || review.error} />{proposals.data?.length === 0 && <p className="text-sm text-muted-foreground">No proposals to review.</p>}{proposals.data?.map(p => <article key={p.id} className="space-y-2 rounded-lg border p-3 text-sm">
      <p>Proposed by {p.agentId} · brief revision {p.briefRevision} · {p.status}</p>{p.facts.map(f => <p key={f.key}>
        <strong>{f.key}:</strong> {f.value} <span className="text-muted-foreground">(source: {f.sourceReference})</span>
      </p>)}{p.sources?.map(s => <details key={s.id}>
        <summary>{s.label} ({s.id})</summary>
        <p className="whitespace-pre-wrap">{s.content}</p>
      </details>)}{p.status === 'proposed' && <div className="flex gap-2">
        <Button disabled={review.isPending || p.briefRevision !== revision} onClick={() => review.mutate({ id: p.id, decision: 'approve' })}>Approve facts company-wide</Button>
        <Button variant="outline" disabled={review.isPending} onClick={() => review.mutate({ id: p.id, decision: 'reject' })}>Reject proposal</Button>
      </div>}{p.status === 'proposed' && p.briefRevision !== revision && <p role="alert">Sources have changed. Ask the agent to propose these facts again before approval.</p>}</article>)}</section>;
}
function DepartmentTargets({ companyId, enrollment }: { companyId: string; enrollment: WorkforceEnrollment }) {
  const client = useQueryClient();
  const [objective, setObjective] = useState(enrollment.objective ?? '');
  const [metrics, setMetrics] = useState(enrollment.metrics.join('\n'));
  const [goalId, setGoalId] = useState(enrollment.goalId ?? '');
  const goals = useQuery({ queryKey: queryKeys.goals.list(companyId), queryFn: () => goalsApi.list(companyId) });
  const save = useMutation({ mutationFn: () => workforceApi.updateTargets(companyId, enrollment.agentId, { ...(objective.trim() ? { objective } : {}), metrics: metrics.split('\n').map(s => s.trim()).filter(Boolean), goalId: goalId || null }), onSuccess: () => { void client.invalidateQueries({ queryKey: workforceKeys.all(companyId) }); } });
  return <div className="space-y-3">
    <h3 className="font-medium">Department targets</h3>
    <label className="block text-sm">Objective<Input aria-label="Department objective" value={objective} onChange={e => setObjective(e.target.value)} /><span className="text-xs text-muted-foreground">Leave blank to keep the current objective.</span>
    </label>
    <label className="block text-sm">Declared metrics, one per line<Textarea aria-label="Declared metrics" value={metrics} onChange={e => setMetrics(e.target.value)} />
    </label>
    <label className="block text-sm">Company goal<select aria-label="Company goal" className="w-full rounded-md border bg-background p-2" value={goalId} onChange={e => setGoalId(e.target.value)}>
      <option value="">No linked goal</option>{goals.data?.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select>
    </label>
    <p className="text-sm text-muted-foreground">Outcome measurements: Unknown. These are declared targets. The first job keeps its original goal and review criteria; edit that issue to change them.</p>
    <WorkforceError error={save.error || goals.error} />
    <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>Save department targets</Button>
  </div>;
}
export function WorkforceAccountability({ companyId, agent }: { companyId: string; agent: Agent }) {
  const client = useQueryClient();
  const [person, setPerson] = useState('');
  const members = useQuery({ queryKey: ['workforce-members', companyId], queryFn: () => accessApi.listMembers(companyId) });
  const choices = members.data?.members.filter(m => m.status === 'active' && m.principalType === 'user') ?? [];
  const activeOwner = !!agent.accountable && choices.some(m => m.principalId === agent.accountable!.userId);
  const assign = useMutation({ mutationFn: async () => { await (agent.autonomy === 'autonomous' ? agentsApi.update(agent.id, { accountableUserId: person }, companyId) : agent.accountable?.via === 'steward' ? stewardshipsApi.transfer(companyId, agent.id, { userId: person, transferReason: 'Explicit workforce accountability reassignment' }) : stewardshipsApi.assign(companyId, { agentId: agent.id, userId: person })); }, onSuccess: async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
      // AgentDetail may be keyed by UUID, urlKey, or a derived short key plus
      // company. Match the resolved record, not only the mutation's UUID.
      client.invalidateQueries({ queryKey: ['agents', 'detail'], predicate: query => {
        const detail = query.state.data as Agent | undefined;
        return detail?.id === agent.id && detail.companyId === companyId;
      } }),
      client.invalidateQueries({ queryKey: workforceKeys.all(companyId) }),
    ]);
  } });
  return <div id="workforce-accountability" className="space-y-2 rounded-lg border p-3 text-sm">
    <p>
      <strong>Accountable human:</strong> {accountableLabel(agent) ?? 'Unassigned'}{members.data && !activeOwner ? ' — active assignment required' : ''}</p>
    <p className="text-muted-foreground">Questions require an active named human. Assignment does not answer existing questions. {agent.autonomy !== 'autonomous' && 'Stewardship pairs one person with one agent.'}</p>
    <WorkforceError error={members.error || assign.error} />
    <div className="flex flex-wrap gap-2">
      <select aria-label="Accountable human" className="min-w-0 rounded-md border bg-background p-2" value={person} onChange={e => setPerson(e.target.value)}>
        <option value="">Choose a person explicitly</option>{choices.map(m => <option key={m.principalId} value={m.principalId}>{m.user?.name || m.user?.email || m.principalId}</option>)}</select>
      <Button variant="outline" disabled={!person || assign.isPending} onClick={() => assign.mutate()}>Assign accountable human</Button>
    </div>
  </div>;
}
export function WorkforceAgentPanel({ companyId, agent }: { companyId: string; agent: Agent }) {
  const client = useQueryClient();
  const [templateId, setTemplateId] = useState('marketing-content');
  const enrollment = useQuery({ queryKey: workforceKeys.enrollment(companyId, agent.id), queryFn: () => workforceApi.enrollment(companyId, agent.id) });
  const readiness = useQuery({ queryKey: workforceKeys.readiness(companyId, agent.id), queryFn: () => workforceApi.readiness(companyId, agent.id) });
  const action = useMutation({ mutationFn: async (kind: 'enroll' | 'start' | 'retry') => { await (kind === 'enroll' ? workforceApi.enroll(companyId, agent.id, templateId) : kind === 'retry' ? workforceApi.retrySkills(companyId, agent.id) : workforceApi.start(companyId, agent.id)); }, onSuccess: () => { void client.invalidateQueries({ queryKey: workforceKeys.all(companyId) }); void client.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) }); } });
  const members = useQuery({ queryKey: ['workforce-members', companyId], queryFn: () => accessApi.listMembers(companyId) });
  const ownerActive = !!agent.accountable && members.data?.members.some(m => m.status === 'active' && m.principalId === agent.accountable!.userId);
  const e = enrollment.data;
  const r = readiness.data;
  const phaseLabels = { learning: 'Learning company context', needs_input: 'Needs human input', working: 'Working on first job', awaiting_review: 'Awaiting review', ready: 'Ready for work', refresh_needed: 'Company context needs refresh' };
  return <section className="space-y-4 rounded-xl border p-5">
    <div>
      <h2 className="text-lg font-semibold">{agent.name} · role readiness</h2>
      <p className="text-sm text-muted-foreground">Model and harness connectivity are separate from delivering accepted work.</p>
    </div>
    <WorkforceError error={enrollment.error || readiness.error || action.error} />
    <WorkforceAccountability companyId={companyId} agent={agent} />
    {!e && <>
      <WorkforceRoleSelect value={templateId} onChange={setTemplateId} />
      <WorkforceTemplatePreview templateId={templateId} />{!supportsWorkforcePrompt(agent.adapterType) && <p role="alert">Choose a supported native runtime in agent settings before enrolling.</p>}<Button disabled={!templateId || !supportsWorkforcePrompt(agent.adapterType) || enrollment.isPending || action.isPending} onClick={() => action.mutate('enroll')}>Enroll role</Button>
    </>}
    {e && <>
      <WorkforceTemplatePreview templateId={e.templateId} />
      <DepartmentTargets key={`${e.id}:${e.updatedAt}`} companyId={companyId} enrollment={e} />{r && <div className="space-y-2 rounded-lg bg-muted/40 p-3">
        <h3 className="font-semibold">{phaseLabels[r.phase]}</h3>
        <p className="text-sm">{r.reason}</p>{r.missingFactKeys.length > 0 && <p className="text-sm">Missing facts: {r.missingFactKeys.join(', ')}</p>}<p className="text-sm">{r.acceptedVerdictId ? 'Neutral review accepted' : 'First-job acceptance not yet established'}</p>{r.firstJobIssueId && <Link disableIssueQuicklook to={`/issues/${r.firstJobIssueId}`} className="text-sm underline">Open first job, artifacts and review</Link>}</div>}{e.skillInstallError && <WorkforceError error={e.skillInstallError} />}<div className="flex flex-wrap gap-2">
        {r?.phase !== 'ready' && <Button disabled={action.isPending || !ownerActive} onClick={() => action.mutate('start')}>{e.firstJobIssueId ? 'Resume first job' : 'Start first job'}</Button>}
        <Button variant="outline" disabled={action.isPending} onClick={() => action.mutate('retry')}>Retry skill installation</Button>
      </div>{!ownerActive && <a className="text-sm underline" href="#workforce-accountability">Assign an active human before starting a job that needs input</a>}{r?.firstJobIssueId && <WorkforceQuestions companyId={companyId} issueId={r.firstJobIssueId} agent={agent} requiredIds={r.pendingQuestionIds} />}</>}
  </section>;
}
export function WorkforceWorkspace({ companyId }: { companyId: string }) {
  const [agentId, setAgentId] = useState('');
  const brief = useQuery({ queryKey: workforceKeys.brief(companyId), queryFn: () => workforceApi.brief(companyId) });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const selected = agents.data?.find(a => a.id === agentId) ?? agents.data?.[0];
  return <div className="mx-auto max-w-4xl space-y-6 py-6">
    <header className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workforce setup</p>
      <h1 className="text-2xl font-semibold">Give your team the context to do good work</h1>
      <p className="text-muted-foreground">Share what your team should know, give each team member a role, and review a real first deliverable.</p>
      <Link to="/agents/new" className="text-sm underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">Hire a new agent</Link>
    </header>
    <WorkforceError error={brief.error || agents.error} />{brief.isPending && <p>Loading company knowledge…</p>}{brief.data && <BriefEditor key={`${companyId}:${brief.data.revision}`} companyId={companyId} brief={brief.data} />}{brief.data && <ProposalReview companyId={companyId} revision={brief.data.revision} />}
    {agents.data?.length ? <>
      <label className="block text-sm">Team member<select aria-label="Team member" className="mt-1 w-full rounded-md border bg-background p-2" value={selected?.id ?? ''} onChange={e => setAgentId(e.target.value)}>{agents.data.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      </label>{selected && <WorkforceAgentPanel key={`${companyId}:${selected.id}`} companyId={companyId} agent={selected} />}</> : <p className="rounded-xl border p-5 text-sm">Hire a team member to choose its role and start a first job.</p>}
  </div>;
}
export function WorkforceOnboarding() { const { selectedCompanyId } = useCompany(); return selectedCompanyId ? <WorkforceWorkspace key={selectedCompanyId} companyId={selectedCompanyId} /> : <p>Select a company first.</p>; }
