import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { evaluationTypedPredicate, type AgentProfileResponsibility } from "@paperclipai/shared";
import { agentPerformanceApi, agentPerformanceQueryKeys } from "@/api/agent-performance";
import { agentProfilesApi, issueResponsibilityApi } from "@/api/agent-profiles";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Link } from "@/lib/router";
import { SELECT_CLASS } from "./ProfileDraftEditor";

function readFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return "You do not have permission to view this responsibility information.";
  if (error instanceof ApiError && error.status === 404) return "This task or agent is unavailable in your current scope.";
  return "Responsibility information could not be loaded. Retry when the connection is available.";
}

function Criteria({ responsibility }: { responsibility: AgentProfileResponsibility | undefined }) {
  if (!responsibility) return <p className="text-sm text-text-secondary">This responsibility is absent from this revision.</p>;
  return <div className="space-y-2">
    <p className="text-sm font-medium">{responsibility.title}</p>
    {responsibility.performance.criteria.length === 0 ? <p className="text-sm text-text-secondary">No criteria defined. Acceptance remains pending.</p> : (
      <ul className="space-y-2 text-sm">{responsibility.performance.criteria.map((criterion) => {
        const predicate = evaluationTypedPredicate(criterion.check);
        return <li key={criterion.id} className="break-words">
          <p>{criterion.text}</p>
          <p className="text-xs text-text-secondary">Criterion {criterion.id} · {predicate.kind === "none" ? "Unmeasurable" : predicate.kind === "unknown" || predicate.kind === "metric" ? "Unsupported proof — undecidable" : predicate.kind.replaceAll("_", " ")}</p>
        </li>;
      })}</ul>
    )}
  </div>;
}

// AgentDash: mapping is a versioned link to an applied responsibility. This
// panel neither copies criteria to task DoD nor records acceptance evidence.
export function IssueResponsibilitySection({ companyId, issueId, assigneeAgentId }: {
  companyId: string;
  issueId: string;
  assigneeAgentId: string | null;
}) {
  const client = useQueryClient();
  const selectId = useId();
  const [selectedKey, setSelectedKey] = useState("");
  const mappingKey = ["issue-responsibility", companyId, issueId, assigneeAgentId] as const;
  const mapping = useQuery({ queryKey: mappingKey, queryFn: () => issueResponsibilityApi.get(companyId, issueId), retry: false });
  const current = mapping.data?.current;
  // A successful scoped read is required before fetching any profile choices.
  const targetAgentId = mapping.data?.viewer ? mapping.data.viewer.assigneeAgentId : assigneeAgentId;
  const profile = useQuery({
    queryKey: agentPerformanceQueryKeys.profile(companyId, targetAgentId ?? ""),
    queryFn: () => agentPerformanceApi.profile(companyId, targetAgentId!),
    enabled: mapping.isSuccess && !mapping.isError && !!targetAgentId,
    retry: false,
  });
  const recorded = useQuery({
    queryKey: ["issue-responsibility-revision", companyId, current?.agentId, current?.profileRevisionId],
    queryFn: () => agentProfilesApi.revision(companyId, current!.agentId, current!.profileRevisionId!),
    enabled: mapping.isSuccess && !mapping.isError && !!current?.profileRevisionId,
    retry: false,
  });
  const active = profile.isError ? null : profile.data?.active;
  const selected = active?.body.responsibilities.find((item) => item.key === selectedKey);
  const canMap = mapping.data?.viewer?.canMapAssignee === true && !mapping.isError && !profile.isError;
  const map = useMutation({
    mutationFn: () => issueResponsibilityApi.map(companyId, issueId, { agentId: targetAgentId!, responsibilityKey: selectedKey }),
    onSuccess: (result) => {
      client.setQueryData(mappingKey, (previous: Awaited<ReturnType<typeof issueResponsibilityApi.get>> | undefined) => previous ? { ...previous, current: result } : previous);
      void client.invalidateQueries({ queryKey: mappingKey });
      void client.invalidateQueries({ queryKey: agentPerformanceQueryKeys.profile(companyId, targetAgentId!) });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: mappingKey });
      if (targetAgentId) void client.invalidateQueries({ queryKey: agentPerformanceQueryKeys.profile(companyId, targetAgentId) });
    },
  });
  return <section className="space-y-4 rounded-lg border border-border-soft p-4" aria-label="Responsibility binding" data-testid="issue-responsibility-section">
    <h3 className="text-sm font-semibold">Responsibility binding</h3>
    <p className="text-sm text-text-secondary">A successful run records execution. Task acceptance requires separate evidence against its criteria. Task completion, project progress and business outcomes each have their own records.</p>
    {mapping.isPending ? <p role="status">Loading responsibility mapping…</p> : null}
    {mapping.isError ? <p role="alert">{readFailure(mapping.error)}</p> : null}
    {!mapping.isError && mapping.isSuccess ? <>
      {current ? <div className="space-y-2" data-testid="issue-recorded-responsibility">
        <p className="text-sm">Mapped responsibility <strong>{current.responsibilityKey}</strong></p>
        <p className="break-all text-xs text-text-secondary">Recorded mapping revision {current.profileRevisionId ?? "not recorded"}</p>
        {recorded.isPending && current.profileRevisionId ? <p role="status">Loading recorded criteria…</p> : null}
        {recorded.isError ? <p role="alert">{readFailure(recorded.error)}</p> : null}
        {recorded.data && !recorded.isError ? <Criteria responsibility={recorded.data.body.responsibilities.find((item) => item.key === current.responsibilityKey)} /> : null}
        {active && (current.agentId !== targetAgentId || current.profileRevisionId !== active.id) ? <p className="text-sm text-text-secondary">This mapping refers to a different agent or an earlier revision. Current criteria apply prospectively. Mapping the same agent and key again retains the recorded revision.</p> : null}
        <Link className="text-sm underline" to={`/agents/${current.agentId}/profile`}>Mapped agent Profile</Link>
      </div> : <p className="text-sm">Unmapped. Choose which applied responsibility this work belongs to.</p>}
      <details data-testid="issue-responsibility-history">
        <summary className="cursor-pointer text-sm font-medium">Mapping history</summary>
        {mapping.data.history.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No recorded mappings.</p> : (
          <ol className="mt-2 space-y-2 text-xs text-text-secondary">
            {mapping.data.history.map((entry) => (
              <li key={entry.id} className="break-all">
                <p>{entry.responsibilityKey} · Revision {entry.profileRevisionId ?? "not recorded"}</p>
                <p><time dateTime={entry.validFrom}>{entry.validFrom}</time> — {entry.validTo ? <time dateTime={entry.validTo}>{entry.validTo}</time> : "Current interval"}</p>
              </li>
            ))}
          </ol>
        )}
      </details>
      {!targetAgentId ? <p className="text-sm">Assign an agent to this task before mapping its responsibility.</p> : <>
        <div className="flex flex-wrap gap-4 text-sm"><Link className="underline" to={`/agents/${targetAgentId}/profile`}>Profile</Link><Link className="underline" to={`/agents/${targetAgentId}/performance`}>Performance</Link></div>
        <p className="text-xs text-text-secondary">To change criteria, edit a profile draft, request approval, then apply the approved revision. Performance access is checked separately.</p>
        {profile.isPending ? <p role="status">Loading active profile…</p> : null}
        {profile.isError ? <p role="alert">{readFailure(profile.error)}</p> : null}
        {profile.isSuccess && !active ? <p className="text-sm">No active operating profile. An approved revision must be applied before this task can be mapped.</p> : null}
        {active ? <div className="space-y-3" data-testid="issue-active-responsibility">
          <p className="break-all text-sm">Current active revision {active.revisionNumber} · {active.id}</p>
          {!canMap ? <p className="text-sm text-text-secondary">You do not have permission to map this task to the assigned agent. A steward, accountable person or company administrator can map it.</p> : <>
            <Label htmlFor={selectId}>Active responsibility</Label>
            <select id={selectId} className={SELECT_CLASS} value={selectedKey} onChange={(event) => { setSelectedKey(event.target.value); map.reset(); }}>
              <option value="">Choose a responsibility</option>
              {active.body.responsibilities.map((item) => <option key={item.key} value={item.key}>{item.title || item.key}</option>)}
            </select>
            {selectedKey && !selected ? <p role="alert">The selected responsibility is absent from the current active profile. Choose a current responsibility.</p> : null}
            {selected ? <Criteria responsibility={selected} /> : null}
            <p className="text-xs text-text-secondary">The server resolves the active profile when mapping. The saved mapping records its own revision. Acceptance requires separate evidence.</p>
            <Button type="button" variant="outline" size="sm" disabled={!selected || map.isPending} onClick={() => map.mutate()}>Map responsibility</Button>
          </>}
        </div> : null}
      </>}
    </> : null}
    {map.isSuccess ? <p role="status">Responsibility mapped. Acceptance requires separate evidence.</p> : null}
    {map.isError ? <p role="alert">{map.error instanceof ApiError && map.error.status === 403 ? "Your permission to map this task was refused. The mapping was not changed." : map.error instanceof ApiError && (map.error.status === 422 || map.error.status === 409) ? "The active responsibility changed or is unavailable. Review the refreshed profile and choose again." : "The responsibility could not be mapped. Review the current mapping before retrying."}</p> : null}
  </section>;
}
