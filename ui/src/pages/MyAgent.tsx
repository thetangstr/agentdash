import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { agentGovernanceApi } from "../api/agent-governance";
import { stewardshipsApi } from "../api/stewardships";
import { AgentGovernancePanel } from "../components/agent/AgentGovernancePanel";
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

      <section aria-labelledby="my-agent-inbox-heading" className="rounded-lg border p-4">
        <h2 id="my-agent-inbox-heading" className="text-sm font-semibold">
          Awaiting your decision
        </h2>
        {items.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">Nothing is waiting on you.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.approvalId} className="text-xs">
                <Link to={`/approvals/${item.approvalId}`} className="underline">
                  {item.type.replace(/_/g, " ")}
                </Link>
                <span className="text-muted-foreground">
                  {" "}· requested by {item.requestingAgent.name} · revision {item.revision}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
