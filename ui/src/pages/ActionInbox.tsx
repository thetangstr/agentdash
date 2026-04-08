// AgentDash: Unified Inbox page for action proposals (approve/reject agent actions)
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { inboxApi, type InboxItem } from "../api/inbox";
import { agentsApi } from "../api/agents";
import { Button } from "@/components/ui/button";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { relativeTime, cn } from "../lib/utils";
import { Inbox as InboxIcon, Check, X, Bot } from "lucide-react";

type FilterStatus = "all" | "pending" | "approved" | "rejected";

const STATUS_PILLS: { label: string; value: FilterStatus }[] = [
  { label: "All", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
  { label: "Rejected", value: "rejected" },
];

// AgentDash: ActionInbox is the unified inbox for agent action proposals
export function ActionInbox() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<FilterStatus>("pending");
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>();
  const [selectedItem, setSelectedItem] = useState<InboxItem | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }]);
  }, [setBreadcrumbs]);

  const { data: items, isLoading } = useQuery({
    queryKey: queryKeys.inbox.list(selectedCompanyId!, status),
    queryFn: () =>
      inboxApi.list(selectedCompanyId!, {
        status: status === "all" ? undefined : status,
        agentId: selectedAgentId,
      }),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (actionId: string) =>
      inboxApi.approve(selectedCompanyId!, actionId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.inbox.list(selectedCompanyId!, status),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.inbox.count(selectedCompanyId!),
      });
      setSelectedItem(null);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ actionId, reason }: { actionId: string; reason: string }) =>
      inboxApi.reject(selectedCompanyId!, actionId, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.inbox.list(selectedCompanyId!, status),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.inbox.count(selectedCompanyId!),
      });
      setSelectedItem(null);
    },
  });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }

  if (isLoading) return <PageSkeleton variant="inbox" />;

  return (
    <div className="flex h-full">
      {/* Main list */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Filter bar */}
        <div className="flex items-center gap-3 px-6 py-4 border-b">
          <InboxIcon className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Inbox</h1>
          <div className="flex items-center gap-1 ml-4">
            {STATUS_PILLS.map((pill) => (
              <button
                key={pill.value}
                onClick={() => setStatus(pill.value)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  status === pill.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {pill.label}
              </button>
            ))}
          </div>
          {agents && agents.length > 0 && (
            <select
              value={selectedAgentId ?? ""}
              onChange={(e) =>
                setSelectedAgentId(e.target.value || undefined)
              }
              className="ml-auto text-xs border rounded-md px-2 py-1"
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Items */}
        <div className="flex-1 overflow-y-auto">
          {!items || items.length === 0 ? (
            <EmptyState
              icon={InboxIcon}
              message={
                status === "pending"
                  ? "No pending actions to review"
                  : "No items match your filters"
              }
            />
          ) : (
            <div className="divide-y">
              {items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedItem(item)}
                  className={cn(
                    "w-full text-left px-6 py-4 hover:bg-accent/50 transition-colors flex items-start gap-3",
                    selectedItem?.id === item.id && "bg-accent/50",
                  )}
                >
                  <div className="shrink-0 mt-0.5">
                    <Bot className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {item.title}
                      </span>
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {item.agentName ?? "Unknown agent"} &middot;{" "}
                      {relativeTime(item.createdAt)}
                    </div>
                    {item.description && (
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        {item.description}
                      </p>
                    )}
                  </div>
                  {item.status === "pending" && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-50"
                        onClick={(e) => {
                          e.stopPropagation();
                          approveMutation.mutate(item.id);
                        }}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={(e) => {
                          e.stopPropagation();
                          rejectMutation.mutate({
                            actionId: item.id,
                            reason: "Rejected from inbox",
                          });
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selectedItem && (
        <div className="w-96 border-l bg-background flex flex-col">
          <div className="px-6 py-4 border-b">
            <h2 className="text-sm font-semibold">{selectedItem.title}</h2>
            <div className="flex items-center gap-2 mt-1">
              <StatusBadge status={selectedItem.status} />
              <span className="text-xs text-muted-foreground">
                {selectedItem.type}
              </span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Agent
              </h3>
              <p className="text-sm mt-1">
                {selectedItem.agentName ?? "Unknown"}
              </p>
            </div>
            {selectedItem.description && (
              <div>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Description
                </h3>
                <p className="text-sm mt-1">{selectedItem.description}</p>
              </div>
            )}
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Created
              </h3>
              <p className="text-sm mt-1">
                {new Date(selectedItem.createdAt).toLocaleString()}
              </p>
            </div>
            {selectedItem.decisionNote && (
              <div>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Decision Note
                </h3>
                <p className="text-sm mt-1">{selectedItem.decisionNote}</p>
              </div>
            )}
          </div>
          {selectedItem.status === "pending" && (
            <div className="px-6 py-4 border-t flex gap-2">
              <Button
                className="flex-1"
                onClick={() => approveMutation.mutate(selectedItem.id)}
                disabled={approveMutation.isPending}
              >
                <Check className="h-4 w-4 mr-1" />
                Approve
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={() =>
                  rejectMutation.mutate({
                    actionId: selectedItem.id,
                    reason: "Rejected from inbox",
                  })
                }
                disabled={rejectMutation.isPending}
              >
                <X className="h-4 w-4 mr-1" />
                Reject
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
