// AgentDash: Pipeline Run Detail page
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { pipelinesApi } from "../api/pipelines";
import type { StageExecution } from "../api/pipelines";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, XCircle, CheckCircle, Clock, AlertTriangle } from "lucide-react";

function stageStatusIcon(status: string) {
  switch (status) {
    case "completed":
      return <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />;
    case "failed":
    case "skipped":
      return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
    case "waiting_hitl":
      return <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />;
    default:
      // pending, running
      return <Clock className="h-4 w-4 text-muted-foreground shrink-0" />;
  }
}

export default function PipelineRunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const isActive = (status: string) => status === "running" || status === "paused";

  const { data: run, isLoading } = useQuery({
    queryKey: queryKeys.pipelines.runDetail(selectedCompanyId!, runId!),
    queryFn: () => pipelinesApi.getRun(selectedCompanyId!, runId!),
    enabled: !!selectedCompanyId && !!runId,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && isActive(data.status) ? 5000 : false;
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Playbooks", href: "/goals" },
      ...(run?.pipelineId
        ? [{ label: "Playbook", href: `/pipelines/${run.pipelineId}` }]
        : []),
      { label: "Run" },
    ]);
  }, [setBreadcrumbs, run?.pipelineId]);

  const cancelMutation = useMutation({
    mutationFn: () => pipelinesApi.cancelRun(selectedCompanyId!, runId!),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pipelines.runDetail(selectedCompanyId!, runId!),
      });
    },
  });

  const hitlMutation = useMutation({
    mutationFn: ({
      stageId,
      decision,
    }: {
      stageId: string;
      decision: "approved" | "rejected";
    }) => pipelinesApi.hitlDecide(selectedCompanyId!, runId!, stageId, decision),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pipelines.runDetail(selectedCompanyId!, runId!),
      });
    },
  });

  if (!selectedCompanyId) {
    return (
      <p className="text-sm text-muted-foreground p-6">Select a company first.</p>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 px-6 py-4 border-b">
          <div className="h-5 w-48 bg-muted/50 rounded animate-pulse" />
        </div>
        <div className="p-6 space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 rounded-lg border bg-muted/30 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Pipeline run not found.</p>
      </div>
    );
  }

  const cost = parseFloat(run.totalCostUsd);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b">
        <Link
          to={`/pipelines/${run.pipelineId}`}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold flex-1">Pipeline Run</h1>
        <StatusBadge status={run.status} />
        {cost > 0 && (
          <span className="text-sm text-muted-foreground shrink-0">
            ${cost.toFixed(4)}
          </span>
        )}
        <span className="text-xs text-muted-foreground shrink-0 bg-muted px-2 py-1 rounded">
          {run.executionMode}
        </span>
        {isActive(run.status) && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
          >
            <XCircle className="h-3.5 w-3.5 mr-1.5" />
            Cancel Run
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {/* Error Banner */}
        {run.errorMessage && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-sm text-red-700">{run.errorMessage}</p>
          </div>
        )}

        {/* Stage Executions */}
        <section>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Stage Executions
          </h2>
          {run.stages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No stages executed yet.</p>
          ) : (
            <div className="rounded-lg border bg-card divide-y">
              {run.stages.map((stage: StageExecution) => {
                const stageCost = parseFloat(stage.costUsd);
                return (
                  <div key={stage.id} className="px-4 py-3 space-y-2">
                    <div className="flex items-center gap-3">
                      {stageStatusIcon(stage.status)}
                      <span className="text-sm font-medium flex-1 truncate">
                        {stage.stageId}
                      </span>
                      <StatusBadge status={stage.status} />
                      {stageCost > 0 && (
                        <span className="text-xs text-muted-foreground shrink-0">
                          ${stageCost.toFixed(4)}
                        </span>
                      )}
                    </div>

                    {stage.selfHealAttempts > 0 && (
                      <p className="text-xs text-yellow-600 pl-7">
                        Self-heal attempts: {stage.selfHealAttempts}
                      </p>
                    )}

                    {stage.errorMessage && (
                      <p className="text-xs text-red-600 pl-7">{stage.errorMessage}</p>
                    )}

                    {stage.status === "waiting_hitl" && (
                      <div className="flex items-center gap-2 pl-7">
                        <Button
                          size="sm"
                          onClick={() =>
                            hitlMutation.mutate({
                              stageId: stage.stageId,
                              decision: "approved",
                            })
                          }
                          disabled={hitlMutation.isPending}
                        >
                          <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            hitlMutation.mutate({
                              stageId: stage.stageId,
                              decision: "rejected",
                            })
                          }
                          disabled={hitlMutation.isPending}
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1.5" />
                          Reject
                        </Button>
                      </div>
                    )}

                    {stage.outputState && (
                      <details className="pl-7">
                        <summary className="text-xs text-muted-foreground cursor-pointer select-none">
                          Output data
                        </summary>
                        <pre className="mt-1 text-xs bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                          {JSON.stringify(stage.outputState, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
