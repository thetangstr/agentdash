import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, PerformanceManagerAgentRef, PerformanceManagerView } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { performanceManagerApi, performanceManagerQueryKeys } from "@/api/performance-manager";
import { PERFORMANCE_MANAGER_ADVISORY_TEXT } from "@/components/agent-performance/manager-shared";
import { apiErrorMessage } from "@/components/agent-performance/profile-shared";
import { Button } from "@/components/ui/button";
import { humanizeAgentRole } from "@/lib/agent-identity";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

// AgentDash: Agent Performance Management gate 4 (P4.2) — which agent is the
// company's performance manager (overview LLD §4.3). With no choice it is the
// Chief of Staff. Admins pick an agent or return to that default; members
// read the designation. Who may change it comes from the server's
// `viewer.canChange` (the PATCH route's own admin guard), and the server's
// refusals are shown as written. The manager only recommends and proposes:
// this control grants it no approval, application or access.

export const CHIEF_OF_STAFF_DEFAULT_LABEL = "Chief of Staff (default)";
export const PERFORMANCE_MANAGER_ROLE_TEXT =
  "The agent that reads agent cards and files recommendations and profile-change proposals for the people responsible for each agent.";
export const MEMBER_READ_ONLY_TEXT = "Only company admins can change this.";

/** The `<select>` value for "no designation" (the Chief of Staff default). */
const DEFAULT_VALUE = "";

function agentLine(agent: PerformanceManagerAgentRef): string {
  const role = humanizeAgentRole(agent.role);
  const paused = agent.status === "paused" ? " · paused" : "";
  return role ? `${agent.name} (${role})${paused}` : `${agent.name}${paused}`;
}

/** Plain words for who acts now and why. */
export function actingNowText(view: PerformanceManagerView): string {
  if (view.effective) {
    if (view.source === "designated") return `${agentLine(view.effective)}, chosen by an admin.`;
    const paused = view.effective.status === "paused" ? " · paused" : "";
    return `${view.effective.name}, the company's Chief of Staff (the default)${paused}.`;
  }
  if (view.designatedAgentId) {
    const name = view.designated?.name ?? "The chosen agent";
    return `No agent. ${name} was chosen but is terminated, so nobody acts as performance manager until an admin chooses another agent or returns to the default.`;
  }
  return "No agent. The company has no Chief of Staff, so nobody acts as performance manager until an admin chooses an agent.";
}

function changedText(view: PerformanceManagerView): string {
  if (view.designatedAgentId === null) {
    return view.effective
      ? `The performance manager is back to the default: ${view.effective.name}, the Chief of Staff.`
      : "The performance manager is back to the default. The company has no Chief of Staff, so nobody acts as performance manager.";
  }
  return `The performance manager is now ${view.effective?.name ?? view.designated?.name ?? "the chosen agent"}.`;
}

export function PerformanceManagerCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const selectId = `${baseId}-select`;
  const helpId = `${baseId}-help`;
  const [choice, setChoice] = useState<string>(DEFAULT_VALUE);
  const [announcement, setAnnouncement] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const viewQuery = useQuery({
    queryKey: performanceManagerQueryKeys.designation(companyId),
    queryFn: () => performanceManagerApi.get(companyId),
    retry: false,
    enabled: !!companyId,
  });
  const view = viewQuery.data ?? null;
  const canChange = view?.viewer.canChange ?? false;
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId && canChange,
  });

  const saved = view?.designatedAgentId ?? DEFAULT_VALUE;
  useEffect(() => {
    setChoice(saved);
  }, [saved]);

  const update = useMutation({
    mutationFn: (agentId: string | null) => performanceManagerApi.set(companyId, agentId),
    onSuccess: (result) => {
      setProblem(null);
      queryClient.setQueryData(performanceManagerQueryKeys.designation(companyId), result);
      setAnnouncement(result.changed ? changedText(result) : "Nothing changed: that was already the choice.");
    },
    onError: (error) => {
      setAnnouncement("");
      setProblem(`The performance manager was not changed: ${apiErrorMessage(error)}`);
    },
  });

  // A terminated agent can't be chosen (the server refuses it); a designated one stays listed so the choice reads true.
  const agents: Agent[] = (agentsQuery.data ?? [])
    .filter((agent) => agent.status !== "terminated" || agent.id === view?.designatedAgentId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const designatedMissing = !!view?.designatedAgentId && !agents.some((agent) => agent.id === view.designatedAgentId);

  return (
    <section aria-labelledby={headingId} className="space-y-2" data-testid="company-settings-performance-manager">
      <h3 id={headingId} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Performance manager
      </h3>
      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        <p className="text-sm text-muted-foreground">{PERFORMANCE_MANAGER_ROLE_TEXT}</p>
        <p className="text-sm text-foreground" data-testid="performance-manager-advisory">
          {PERFORMANCE_MANAGER_ADVISORY_TEXT}
        </p>
        {viewQuery.error ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn't read the performance manager: {apiErrorMessage(viewQuery.error)}
          </p>
        ) : !view ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the performance manager…
          </p>
        ) : (
          <>
            <p className="text-sm text-foreground" data-testid="performance-manager-acting">
              <span className="text-muted-foreground">Acting now:</span> {actingNowText(view)}
            </p>
            {view.effective ? (
              <p className="text-sm">
                <Link
                  className="text-accent-500 underline-offset-4 hover:underline"
                  to={`/agents/${view.effective.agentId}/manager-record`}
                  data-testid="performance-manager-record-link"
                >
                  Open the performance manager's record
                </Link>
              </p>
            ) : null}
            {canChange ? (
              <form
                className="space-y-2"
                aria-busy={update.isPending}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (update.isPending || choice === saved) return;
                  update.mutate(choice === DEFAULT_VALUE ? null : choice);
                }}
              >
                <label htmlFor={selectId} className="block text-sm font-medium text-foreground">
                  Choose the performance manager
                </label>
                <select
                  id={selectId}
                  value={choice}
                  aria-describedby={helpId}
                  onChange={(event) => setChoice(event.target.value)}
                  className="w-full max-w-md rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  data-testid="performance-manager-select"
                >
                  <option value={DEFAULT_VALUE}>{CHIEF_OF_STAFF_DEFAULT_LABEL}</option>
                  {designatedMissing && view.designatedAgentId ? (
                    <option value={view.designatedAgentId} disabled>
                      {view.designated ? `${view.designated.name} (terminated)` : "The chosen agent (not listed)"}
                    </option>
                  ) : null}
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id} disabled={agent.status === "terminated"}>
                      {`${agent.name}${agent.role ? ` — ${humanizeAgentRole(agent.role)}` : ""}${agent.status === "terminated" ? " (terminated)" : ""}`}
                    </option>
                  ))}
                </select>
                <p id={helpId} className="text-xs text-muted-foreground">
                  {CHIEF_OF_STAFF_DEFAULT_LABEL} follows the company's Chief of Staff. Choosing an agent gives it no new access and no
                  authority to decide anything.
                </p>
                {agentsQuery.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    Couldn't list the agents: {apiErrorMessage(agentsQuery.error)}
                  </p>
                ) : null}
                <Button type="submit" size="sm" disabled={update.isPending || choice === saved} data-testid="performance-manager-save">
                  {update.isPending ? "Saving…" : "Save"}
                </Button>
              </form>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="performance-manager-readonly">
                {MEMBER_READ_ONLY_TEXT}
              </p>
            )}
          </>
        )}
        <p role="status" aria-live="polite" className={announcement ? "text-sm text-foreground" : "sr-only"} data-testid="performance-manager-status">
          {announcement}
        </p>
        {problem ? (
          <p role="alert" className="text-sm text-destructive" data-testid="performance-manager-error">
            {problem}
          </p>
        ) : null}
      </div>
    </section>
  );
}
