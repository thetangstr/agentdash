// AgentDash: ActionProposals page — CUJ-B governance queue
import { useEffect } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, CheckCircle2, XCircle } from "lucide-react";
import { actionProposalsApi, type ActionProposal } from "../api/action-proposals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "../lib/timeAgo";

const PROPOSAL_QUERY_STATUS = "pending";

function actionProposalsQueryKey(companyId: string, status: string) {
  return ["action-proposals", companyId, status] as const;
}

function proposalTitle(proposal: ActionProposal): string {
  const payload = proposal.payload ?? {};
  const label =
    (typeof payload.title === "string" && payload.title) ||
    (typeof payload.summary === "string" && payload.summary) ||
    null;
  const typeLabel = proposal.type
    .split("_")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
  return label ? `${typeLabel}: ${label}` : typeLabel;
}

export function ActionProposals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Action Proposals" }]);
  }, [setBreadcrumbs]);

  const queryKey = selectedCompanyId
    ? actionProposalsQueryKey(selectedCompanyId, PROPOSAL_QUERY_STATUS)
    : ["action-proposals", "_none_", PROPOSAL_QUERY_STATUS];

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => actionProposalsApi.list(selectedCompanyId!, PROPOSAL_QUERY_STATUS),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => actionProposalsApi.approve(selectedCompanyId!, id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ActionProposal[]>(queryKey);
      queryClient.setQueryData<ActionProposal[]>(queryKey, (old) =>
        (old ?? []).filter((p) => p.id !== id),
      );
      return { previous };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
      pushToast({
        title: "Failed to approve proposal",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => actionProposalsApi.reject(selectedCompanyId!, id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ActionProposal[]>(queryKey);
      queryClient.setQueryData<ActionProposal[]>(queryKey, (old) =>
        (old ?? []).filter((p) => p.id !== id),
      );
      return { previous };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
      pushToast({
        title: "Failed to reject proposal",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground p-6">Select a company first.</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Action Proposals</h1>
        <p className="text-sm text-muted-foreground">
          Review and decide on agent-requested actions awaiting your approval.
        </p>
      </div>

      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load proposals"}
        </p>
      )}

      {isLoading && (
        <div className="grid gap-3" data-testid="action-proposals-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      )}

      {!isLoading && data && data.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No proposals awaiting your review</p>
        </div>
      )}

      {!isLoading && data && data.length > 0 && (
        <div className="grid gap-3">
          {data.map((proposal) => {
            const pending = approveMutation.isPending || rejectMutation.isPending;
            return (
              <div
                key={proposal.id}
                className="border border-border rounded-lg p-4"
                data-testid={`action-proposal-${proposal.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{proposalTitle(proposal)}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      {proposal.requestedByAgent && (
                        <span>
                          requested by{" "}
                          <span className="text-foreground">
                            {proposal.requestedByAgent.name}
                          </span>
                        </span>
                      )}
                      <span>· {timeAgo(proposal.createdAt)}</span>
                    </div>
                    {proposal.linkedIssues.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Linked:</span>
                        {proposal.linkedIssues.map((issue) => (
                          <Link
                            key={issue.id}
                            to={`/issues/${issue.id}`}
                            className="text-primary hover:underline"
                          >
                            {issue.title}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex gap-2 pt-3 border-t border-border">
                  <Button
                    size="sm"
                    className="bg-green-700 hover:bg-green-600 text-white"
                    disabled={pending}
                    onClick={() => approveMutation.mutate(proposal.id)}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                    Approve
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pending}
                    onClick={() => rejectMutation.mutate(proposal.id)}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1.5" />
                    Reject
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
