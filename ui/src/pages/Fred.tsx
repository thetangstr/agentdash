// AgentDash: the built-in FDE uses native work threads, not a second chat engine.
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Compass, ArrowUpRight } from "lucide-react";
import type { FredAdoptionBrief, FredBriefContent, FredSetupInput, FredWorkspace as Workspace } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { fredApi, fredKeys } from "@/api/fred";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const SECTION = "space-y-4 rounded-xl border bg-card p-5";
const CHECKBOX_ROW = "flex min-h-11 items-start gap-3 text-sm";
const RUNTIME_LABELS: Record<string, string> = { claude_local: "Claude Code", codex_local: "Codex", hermes_local: "Hermes" };
const EMPTY_BRIEF: FredBriefContent = { goal: "", firstJob: "", successCriteria: [], baseline: "", target: "", outcomeWindow: "", boundaries: "" };

function errorText(error: unknown) { return error instanceof Error ? error.message : "The request could not be completed. Reload the saved state before trying again."; }
function ErrorNotice({ error }: { error: unknown }) { return error ? <p role="alert" className="break-words text-sm text-destructive">{errorText(error)}</p> : null; }
function amount(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function BriefFields(brief: FredAdoptionBrief | null): FredBriefContent {
  if (!brief) return { ...EMPTY_BRIEF, successCriteria: [] };
  const { revision: _revision, documentRevisionId: _document, ...content } = brief;
  return content;
}
function agentLabel(status: string) {
  return ({ idle: "Available", running: "Running", active: "Active", paused: "Paused", terminated: "Terminated", pending_approval: "Awaiting approval", error: "Needs attention" } as Record<string, string>)[status] ?? status.replaceAll("_", " ");
}
function runLabel(status: string) {
  return ({ queued: "Queued", running: "Running", succeeded: "Run finished", failed: "Run failed", cancelled: "Cancelled", timed_out: "Timed out" } as Record<string, string>)[status] ?? status.replaceAll("_", " ");
}

function FredSetup({ companyId, workspace }: { companyId: string; workspace: Workspace }) {
  const client = useQueryClient();
  const [adapterType, setAdapterType] = useState<FredSetupInput["adapterType"]>(
    workspace.agent && workspace.agent.adapterType in RUNTIME_LABELS ? workspace.agent.adapterType as FredSetupInput["adapterType"] : "claude_local",
  );
  const [budget, setBudget] = useState(String((workspace.agent?.budgetMonthlyCents ?? 1000) / 100));
  const [share, setShare] = useState(false);
  const setup = useMutation({
    mutationFn: () => fredApi.setup(companyId, { adapterType, budgetMonthlyCents: Math.round(Number(budget) * 100), shareWithCompany: true }),
    onSuccess: data => client.setQueryData(fredKeys.workspace(companyId), data),
  });
  const cents = Math.round(Number(budget) * 100);
  const validBudget = /^\d+(\.\d{1,2})?$/.test(budget) && Number.isSafeInteger(cents) && cents > 0 && cents <= 100_000_000;
  const repairing = workspace.registration?.state === "repair_needed" || workspace.registration?.state === "materializing";
  return <section className={SECTION} data-testid="fred-setup">
    <div>
      <h2 className="text-lg font-semibold">{repairing ? "Repair Fred’s setup" : "Set up your guide"}</h2>
      <p className="mt-1 text-sm text-muted-foreground">Choose the installed agent runtime and a monthly model budget. Setup creates no model job and enables no recurring checks.</p>
    </div>
    <form className="space-y-4" onSubmit={(event: FormEvent) => { event.preventDefault(); if (share && validBudget && !setup.isPending) setup.mutate(); }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm font-medium">Agent runtime
          <select aria-label="Fred runtime" className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm" value={adapterType} onChange={event => setAdapterType(event.target.value as FredSetupInput["adapterType"])}>
            {Object.entries(RUNTIME_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm font-medium">Monthly model budget (USD)
          <Input aria-label="Monthly model budget in dollars" type="number" min="0.01" max="1000000" step="0.01" inputMode="decimal" className="min-h-11" value={budget} onChange={event => setBudget(event.target.value)} />
        </label>
      </div>
      <p className="text-sm text-muted-foreground">A budget limits future usage; it does not purchase model credits. Fred’s model usage counts toward your normal limits and costs.</p>
      <label className={CHECKBOX_ROW}>
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" aria-label="Share Fred’s brief and discovery thread with this company" checked={share} onChange={event => setShare(event.target.checked)} />
        <span>I agree that Fred’s adoption brief and discovery thread are company-shared. I will include only information approved for this company.</span>
      </label>
      <ErrorNotice error={setup.error} />
      <Button type="submit" className="min-h-11" disabled={!share || !validBudget || setup.isPending}>{setup.isPending ? "Preparing Fred…" : repairing ? "Repair Fred’s setup" : "Set up Fred"}</Button>
    </form>
    {repairing && <p className="text-sm text-muted-foreground">Repair uses Fred’s existing registration and work thread. It does not hire another agent or start discovery.</p>}
  </section>;
}

function AdoptionBrief({ companyId, workspace, onDirty }: { companyId: string; workspace: Workspace; onDirty: (dirty: boolean) => void }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(() => BriefFields(workspace.brief));
  const [criteria, setCriteria] = useState(() => workspace.brief?.successCriteria.join("\n") ?? "");
  const [baseRevision, setBaseRevision] = useState(workspace.brief?.revision ?? 0);
  const [base, setBase] = useState(() => JSON.stringify(BriefFields(workspace.brief)));
  const [share, setShare] = useState(false);
  const content = { ...draft, successCriteria: criteria.split("\n").map(line => line.trim()).filter(Boolean) };
  const dirty = JSON.stringify(content) !== base;
  const stale = (workspace.brief?.revision ?? 0) !== baseRevision;
  const loadSaved = () => {
    const current = BriefFields(workspace.brief);
    setDraft(current); setCriteria(current.successCriteria.join("\n"));
    setBaseRevision(workspace.brief?.revision ?? 0); setBase(JSON.stringify(current)); setShare(false);
  };
  const save = useMutation({
    mutationFn: () => fredApi.saveBrief(companyId, { ...content, expectedRevision: baseRevision, shareWithCompany: true }),
    onSuccess: data => {
      const saved = BriefFields(data.brief);
      client.setQueryData(fredKeys.workspace(companyId), data);
      setDraft(saved); setCriteria(saved.successCriteria.join("\n"));
      setBaseRevision(data.brief?.revision ?? 0); setBase(JSON.stringify(saved)); setShare(false);
    },
  });
  useEffect(() => { onDirty(dirty || stale || save.isPending); }, [dirty, stale, save.isPending, onDirty]);
  const valid = Boolean(content.goal.trim() && content.firstJob.trim() && content.successCriteria.length > 0 && content.successCriteria.length <= 12);
  const update = (key: keyof Omit<FredBriefContent, "successCriteria">, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const fields: Array<{ key: keyof Omit<FredBriefContent, "successCriteria">; label: string; help?: string; max: number }> = [
    { key: "goal", label: "Customer goal", help: "What useful change do you want for your company?", max: 4000 },
    { key: "firstJob", label: "First useful job", help: "Choose one bounded deliverable to start with.", max: 4000 },
    { key: "baseline", label: "Current baseline", help: "Record its source and date, or leave it unknown.", max: 4000 },
    { key: "target", label: "Desired outcome", help: "Use a measurable target where you have one.", max: 4000 },
    { key: "outcomeWindow", label: "When to check the outcome", help: "The business result may arrive after the task is accepted.", max: 2000 },
    { key: "boundaries", label: "Boundaries and approvals", help: "State permitted sources and actions. This brief cannot grant access.", max: 8000 },
  ];
  return <section className={SECTION} aria-labelledby="fred-brief-heading">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="fred-brief-heading" className="text-lg font-semibold">Adoption brief</h2>
      <span className="text-xs text-muted-foreground">{baseRevision ? `Saved revision ${baseRevision}` : "No brief saved yet"}</span>
    </div>
    <p className="text-sm text-muted-foreground">Agree on one useful job, its evidence and what success would mean. Unknown baselines and outcomes stay unknown.</p>
    <form className="space-y-4" onSubmit={(event: FormEvent) => { event.preventDefault(); if (workspace.canConfigure && valid && share && !stale && !save.isPending) save.mutate(); }}>
      <fieldset className="space-y-4" disabled={!workspace.canConfigure || save.isPending}>
        {fields.slice(0, 2).map(({ key, label, help, max }) => <label key={key} className="block space-y-1 text-sm font-medium">{label}
          <Textarea aria-label={label} value={draft[key]} maxLength={max} onChange={event => update(key, event.target.value)} />
          <span className="block text-xs font-normal text-muted-foreground">{help}</span>
        </label>)}
        <label className="block space-y-1 text-sm font-medium">Success criteria
          <Textarea aria-label="Success criteria" value={criteria} maxLength={24012} onChange={event => setCriteria(event.target.value)} />
          <span className="block text-xs font-normal text-muted-foreground">One criterion per line, up to 12. Specify observable proof; an agent saying “done” is not proof.</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">{fields.slice(2).map(({ key, label, help, max }) => <label key={key} className="block space-y-1 text-sm font-medium">{label}
          <Textarea aria-label={label} value={draft[key]} maxLength={max} onChange={event => update(key, event.target.value)} />
          <span className="block text-xs font-normal text-muted-foreground">{help}</span>
        </label>)}</div>
        {workspace.canConfigure && <label className={CHECKBOX_ROW}>
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" aria-label="Confirm this adoption brief is company-shared" checked={share} onChange={event => setShare(event.target.checked)} />
          <span>I confirm this brief is approved for company-wide sharing. Saving it does not authorize new access or start work.</span>
        </label>}
      </fieldset>
      {stale && <p role="status" className="text-sm">A newer brief is saved. Your draft is preserved; review the saved brief before making another change.</p>}
      <ErrorNotice error={save.error} />
      {workspace.canConfigure && <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11" disabled={!valid || !share || stale || save.isPending}>{save.isPending ? "Saving brief…" : "Save adoption brief"}</Button>
        {(stale || save.isError) && <Button type="button" variant="outline" className="min-h-11" onClick={async () => { await client.invalidateQueries({ queryKey: fredKeys.workspace(companyId) }); save.reset(); }}>Reload saved state</Button>}
        {stale && <Button type="button" variant="outline" className="min-h-11" onClick={loadSaved}>Use saved brief instead</Button>}
      </div>}
    </form>
  </section>;
}

export function FredWorkspace({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const [dirty, setDirty] = useState(false);
  const workspace = useQuery({
    queryKey: fredKeys.workspace(companyId),
    queryFn: () => fredApi.workspace(companyId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: query => query.state.data?.registration?.startedAt || query.state.data?.registration?.state === "materializing" ? 10_000 : false,
  });
  const start = useMutation({
    mutationFn: () => {
      const current = workspace.data!;
      return fredApi.start(companyId, { registrationId: current.registration!.id, expectedRevision: current.brief!.revision });
    },
    onSuccess: data => client.setQueryData(fredKeys.workspace(companyId), data),
  });
  const data = workspace.data;
  if (workspace.isPending) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading Fred…</p>;
  if (workspace.error) return <div className="mx-auto max-w-3xl space-y-4 p-6"><ErrorNotice error={workspace.error} /><Button variant="outline" onClick={() => { void workspace.refetch(); }}>Try again</Button></div>;
  if (!data || data.companyId !== companyId) return <p role="alert" className="p-6 text-sm">Fred’s workspace does not match this company. Reload this company before continuing.</p>;
  const registration = data.registration;
  const started = Boolean(registration?.startedAt);
  const agentAvailable = data.agent?.status === "idle" || data.agent?.status === "active";
  const ready = registration?.state === "ready" && Boolean(data.agent && data.issue && data.brief);
  const canStart = data.canConfigure && ready && agentAvailable && !started && !dirty && !data.startBlocker && !start.isPending && !start.isError;
  const title = !registration ? "Meet Fred" : registration.state === "repair_needed" ? "Fred’s setup needs repair" : registration.state === "materializing" ? "Preparing Fred" : data.latestRun?.status === "queued" ? "Discovery queued" : data.latestRun?.status === "running" ? "Discovery running" : data.latestRun?.status === "succeeded" ? "Discovery run finished" : started ? "Discovery requested" : "Ready for discovery";
  return <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-6">
    <header className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted"><Compass className="h-6 w-6" aria-hidden="true" /></span>
        <div><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Your AgentDash guide</p><h1 className="text-2xl font-semibold">{title}</h1></div>
      </div>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">Fred helps understand your company, prepare agent setup, and follow useful work through to evidence and outcomes. Your Chief of Staff and existing agents keep their roles.</p>
      <p className="inline-flex rounded-full border px-3 py-1 text-xs font-medium">Company-shared</p>
      <p className="text-sm text-muted-foreground">Share only approved company information. This is not a private conversation. Recurring monitoring is off; Fred asks for decisions when they are needed.</p>
    </header>

    {!data.canConfigure && <p role="status" className="rounded-xl border p-4 text-sm">An owner or admin sets up Fred and confirms the adoption brief. You can inspect the information you are allowed to see.</p>}
    {data.canConfigure && (!registration || registration.state === "repair_needed" || registration.state === "materializing") && <FredSetup key={registration?.id ?? "new"} companyId={companyId} workspace={data} />}
    {registration && <section className={SECTION} aria-label="Fred status">
      <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-muted-foreground">Fred</dt><dd className="mt-1 font-medium">{data.agent ? agentLabel(data.agent.status) : "Setup incomplete"}</dd></div>
        <div><dt className="text-muted-foreground">Agent runtime</dt><dd className="mt-1 font-medium">{data.agent ? RUNTIME_LABELS[data.agent.adapterType] ?? data.agent.adapterType : "Not configured"}</dd></div>
        <div><dt className="text-muted-foreground">Monthly budget</dt><dd className="mt-1 font-medium">{data.agent ? amount(data.agent.budgetMonthlyCents) : "Not configured"}</dd></div>
        <div><dt className="text-muted-foreground">Accountable person</dt><dd className="mt-1 font-medium">{data.agent ? <Link className="inline-flex min-h-11 items-center underline" to={`/agents/${data.agent.id}/profile`}>View the assigned person</Link> : "Setup incomplete"}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">The configured budget is a limit, not a cost measurement. Usage and charges are available in the native work and cost records; missing amounts are not zero.</p>
      {!started && <p className="text-sm">No work has started. Setup and saving a brief do not run a model.</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-3 text-sm">
        {data.agent && <Link className="inline-flex min-h-11 items-center gap-1 underline" to={`/agents/${data.agent.id}/profile`}>Fred’s profile and access <ArrowUpRight className="h-3 w-3" aria-hidden="true" /></Link>}
        <Link className="inline-flex min-h-11 items-center gap-1 underline" to="/workforce">Company knowledge and team setup <ArrowUpRight className="h-3 w-3" aria-hidden="true" /></Link>
      </div>
    </section>}
    {!registration && <p className="text-sm text-muted-foreground">No work has started. Set up Fred first, then agree on the brief and explicitly start discovery.</p>}
    {registration?.state === "ready" && <AdoptionBrief key={`${companyId}:${registration.id}`} companyId={companyId} workspace={data} onDirty={setDirty} />}

    {registration && <section className={SECTION} aria-labelledby="fred-discovery-heading">
      <h2 id="fred-discovery-heading" className="text-lg font-semibold">One useful first job</h2>
      <p className="text-sm text-muted-foreground">Start discovery to read permitted company context, prepare a source-backed adoption recommendation, and identify the next decision. New access, hires and other guarded changes still need native approval.</p>
      {data.startBlocker && <p role="status" className="text-sm">{data.startBlocker}</p>}
      {dirty && <p role="status" className="text-sm">Save or review your changed brief before starting discovery.</p>}
      {!agentAvailable && data.agent && !started && <p role="status" className="text-sm">Fred is {agentLabel(data.agent.status).toLowerCase()}. Resolve that state in the agent controls before starting work.</p>}
      <ErrorNotice error={start.error} />
      {!started && data.canConfigure && <Button className="min-h-11" disabled={!canStart} onClick={() => start.mutate()}>{start.isPending ? "Requesting discovery…" : "Start discovery"}</Button>}
      {start.isError && <Button variant="outline" className="min-h-11" onClick={async () => { await workspace.refetch(); start.reset(); }}>Reload discovery state</Button>}
      {data.latestRun && <p className="text-sm"><span className="text-muted-foreground">Latest execution: </span><strong>{runLabel(data.latestRun.status)}</strong>{data.latestRun.error && <span className="block break-words text-muted-foreground">{data.latestRun.error}</span>}</p>}
      {started && !data.latestRun && <p className="text-sm">Discovery was requested, but no run receipt is available here yet. Inspect the work thread before retrying.</p>}
      {data.issue && <Link disableIssueQuicklook className="inline-flex min-h-11 items-center gap-1 text-sm font-medium underline" to={`/issues/${data.issue.id}`}>Open discovery work, questions and evidence <ArrowUpRight className="h-3 w-3" aria-hidden="true" /></Link>}
    </section>}
    <section className={SECTION}>
      <h2 className="text-lg font-semibold">Keep the result honest</h2>
      <p className="text-sm text-muted-foreground">Execution, accepted work and a business result are separate. A convincing completion claim can still be wrong; missing proof stays unverified. A legitimate approval block is waiting work.</p>
      <p className="text-sm">Acceptance is not recorded here. Review the delivered revision and criteria in the native work thread.</p>
      <p className="text-sm">Business outcome: not measured. Establish a baseline and observation window, and record real correction effort before claiming time saved or return on investment.</p>
      <Link className="inline-flex min-h-11 items-center gap-1 text-sm underline" to="/evaluation">Inspect evaluation records <ArrowUpRight className="h-3 w-3" aria-hidden="true" /></Link>
    </section>
  </main>;
}

export function FredPage() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: selectedCompany?.name ?? "Company", href: "/dashboard" }, { label: "Fred" }]); }, [selectedCompany?.name, setBreadcrumbs]);
  return selectedCompanyId ? <FredWorkspace key={selectedCompanyId} companyId={selectedCompanyId} /> : <p className="p-6 text-sm">Select a company to meet Fred.</p>;
}
