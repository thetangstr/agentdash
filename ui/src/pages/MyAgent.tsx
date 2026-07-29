import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { activityApi } from "../api/activity";
import { agentGovernanceApi } from "../api/agent-governance";
import { issuesApi } from "../api/issues";
import { stewardshipsApi } from "../api/stewardships";
import { AgentGovernancePanel } from "../components/agent/AgentGovernancePanel";
import { AgentMandateEditor } from "../components/agent/AgentMandateEditor";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

export default function MyAgent() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const isProfileCompany = selectedCompany?.productProfile === "agentdash_mk";

  const myAgent = useQuery({
    queryKey: queryKeys.myAgent.detail(selectedCompanyId ?? ""),
    queryFn: () => stewardshipsApi.getMyAgent(selectedCompanyId!),
    enabled: !!selectedCompanyId && isProfileCompany,
  });

  const agentId = myAgent.data?.agent?.id ?? null;

  const inbox = useQuery({
    queryKey: queryKeys.myAgent.inbox(selectedCompanyId ?? ""),
    queryFn: () => stewardshipsApi.getMyInbox(selectedCompanyId!),
    enabled: !!selectedCompanyId && isProfileCompany,
  });

  const governance = useQuery({
    queryKey: queryKeys.myAgent.governance(selectedCompanyId ?? "", agentId ?? ""),
    queryFn: () => agentGovernanceApi.get(selectedCompanyId!, agentId!),
    enabled: !!selectedCompanyId && !!agentId && isProfileCompany,
  });

  // Design 8.1: the steward needs to see what their agent is actually doing and
  // what it has recently done, not just what it is permitted to do.
  const currentWork = useQuery({
    queryKey: queryKeys.myAgent.currentWork(selectedCompanyId ?? "", agentId ?? ""),
    queryFn: () => issuesApi.list(selectedCompanyId!, { assigneeAgentId: agentId! }),
    enabled: !!selectedCompanyId && !!agentId && isProfileCompany,
  });

  const activity = useQuery({
    queryKey: queryKeys.myAgent.activity(selectedCompanyId ?? "", agentId ?? ""),
    queryFn: () => activityApi.list(selectedCompanyId!, { agentId: agentId!, limit: 10 }),
    enabled: !!selectedCompanyId && !!agentId && isProfileCompany,
  });

  if (!isProfileCompany) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">My Agent</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This workspace does not use the AgentDash-MK profile.
        </p>
      </div>
    );
  }

  if (myAgent.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading your agent…</div>;
  }

  if (myAgent.error) {
    return (
      <div className="p-6" role="alert">
        <h1 className="text-lg font-semibold">My Agent</h1>
        <p className="mt-2 text-sm text-destructive">
          {myAgent.error instanceof Error ? myAgent.error.message : "Failed to load your agent"}
        </p>
      </div>
    );
  }

  const agent = myAgent.data?.agent ?? null;

  // Unassigned is an explicit state, not an empty page: ordinary users must not
  // be offered a way to self-claim an agent.
  if (!agent) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">My Agent</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No agent assigned. A company owner or administrator assigns your agent.
        </p>
      </div>
    );
  }

  const items = inbox.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4 p-6">
      <header>
        <h1 className="text-lg font-semibold">My Agent</h1>
        <p className="mt-1 text-sm">
          <span className="font-medium">{agent.name}</span>
          <span className="text-muted-foreground"> · {agent.role} · {agent.status}</span>
        </p>
      </header>

      {governance.data ? (
        <AgentGovernancePanel policy={governance.data.policy} />
      ) : governance.error ? (
        <p className="text-sm text-destructive" role="alert">
          {governance.error instanceof Error
            ? governance.error.message
            : "Failed to load authority"}
        </p>
      ) : null}

      <AgentMandateEditor agentId={agent.id} companyId={selectedCompanyId!} />

      <section aria-labelledby="my-agent-work-heading" className="rounded-lg border p-4">
        <h2 id="my-agent-work-heading" className="text-sm font-semibold">
          Current work
        </h2>
        {currentWork.isLoading ? (
          <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
        ) : currentWork.error ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {currentWork.error instanceof Error
              ? currentWork.error.message
              : "Failed to load current work"}
          </p>
        ) : (currentWork.data ?? []).length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No issues assigned.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {(currentWork.data ?? []).slice(0, 10).map((issue) => (
              <li key={issue.id} className="text-xs">
                <Link to={`/issues/${issue.id}`} className="underline">
                  {issue.identifier}
                </Link>
                <span className="text-muted-foreground"> · {issue.title} · {issue.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="my-agent-inbox-heading" className="rounded-lg border p-4">
        <h2 id="my-agent-inbox-heading" className="text-sm font-semibold">
          Awaiting your decision
        </h2>
        {inbox.isLoading ? (
          <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
        ) : inbox.error ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {inbox.error instanceof Error ? inbox.error.message : "Failed to load your inbox"}
          </p>
        ) : items.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">Nothing is waiting on you.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.approvalId} className="text-xs">
                <Link to={`/approvals/${item.approvalId}`} className="underline">
                  {item.type.replace(/_/g, " ")}
                </Link>
                <span className="text-muted-foreground">
                  {item.requestingAgent ? ` · requested by ${item.requestingAgent.name}` : ""}
                  {" "}· revision {item.revision} · risk {item.risk?.level ?? "unknown"}
                </span>
                {item.sourceIssues?.length ? (
                  <span className="text-muted-foreground">
                    {" "}· {item.sourceIssues.map((issue) => issue.identifier).join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="my-agent-activity-heading" className="rounded-lg border p-4">
        <h2 id="my-agent-activity-heading" className="text-sm font-semibold">
          Recent activity
        </h2>
        {activity.error ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {activity.error instanceof Error ? activity.error.message : "Failed to load activity"}
          </p>
        ) : (activity.data ?? []).length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No recent activity.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {(activity.data ?? []).map((event) => (
              <li key={event.id} className="text-xs text-muted-foreground">
                {event.action.replace(/[._]/g, " ")}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
