// AgentDash: Pipeline detail page
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { pipelinesApi } from "../api/pipelines";
import { DagPreview } from "../components/DagPreview";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";
import { ArrowLeft, Play, CheckCircle2, GitBranch } from "lucide-react";

export default function PipelineDetail() {
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: pipeline, isLoading } = useQuery({
    queryKey: queryKeys.pipelines.detail(selectedCompanyId!, pipelineId!),
    queryFn: () => pipelinesApi.get(selectedCompanyId!, pipelineId!),
    enabled: !!selectedCompanyId && !!pipelineId,
  });

  const { data: runs, isLoading: runsLoading } = useQuery({
    queryKey: queryKeys.pipelines.runs(selectedCompanyId!, pipelineId!),
    queryFn: () => pipelinesApi.listRuns(selectedCompanyId!, pipelineId!),
    enabled: !!selectedCompanyId && !!pipelineId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline?.name ?? "Pipeline" },
    ]);
  }, [setBreadcrumbs, pipeline?.name]);

  const activateMutation = useMutation({
    mutationFn: () =>
      pipelinesApi.update(selectedCompanyId!, pipelineId!, { status: "active" }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pipelines.detail(selectedCompanyId!, pipelineId!),
      });
    },
  });

  const startRunMutation = useMutation({
    mutationFn: () => pipelinesApi.startRun(selectedCompanyId!, pipelineId!),
    onSuccess: (run) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pipelines.runs(selectedCompanyId!, pipelineId!),
      });
      navigate(`/pipeline-runs/${run.id}`);
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
            <div key={i} className="h-24 rounded-lg border bg-muted/30 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!pipeline) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Pipeline not found.</p>
      </div>
    );
  }

  const defaults = pipeline.defaults;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b">
        <Link
          to="/pipelines"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <GitBranch className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold flex-1 truncate">{pipeline.name}</h1>
        <StatusBadge status={pipeline.status} />
        <div className="flex items-center gap-2">
          {pipeline.status === "draft" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => activateMutation.mutate()}
              disabled={activateMutation.isPending}
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
              Activate
            </Button>
          )}
          {pipeline.status === "active" && (
            <Button
              size="sm"
              onClick={() => startRunMutation.mutate()}
              disabled={startRunMutation.isPending}
            >
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Start Run
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {/* Description */}
        {pipeline.description && (
          <p className="text-sm text-muted-foreground">{pipeline.description}</p>
        )}

        {/* DAG Preview */}
        <section>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Pipeline Graph
          </h2>
          <div className="rounded-lg border bg-card p-4 overflow-x-auto">
            {pipeline.stages.length > 0 ? (
              <DagPreview stages={pipeline.stages} edges={pipeline.edges} />
            ) : (
              <p className="text-sm text-muted-foreground">No stages defined.</p>
            )}
          </div>
        </section>

        {/* Configuration */}
        <section>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Configuration
          </h2>
          <div className="rounded-lg border bg-card divide-y">
            <ConfigRow label="Execution Mode" value={pipeline.executionMode} />
            {defaults?.stageTimeoutMinutes != null && (
              <ConfigRow
                label="Stage Timeout"
                value={`${defaults.stageTimeoutMinutes}m`}
              />
            )}
            {defaults?.hitlTimeoutHours != null && (
              <ConfigRow
                label="HITL Timeout"
                value={`${defaults.hitlTimeoutHours}h`}
              />
            )}
            {defaults?.maxSelfHealRetries != null && (
              <ConfigRow
                label="Max Self-Heal Retries"
                value={String(defaults.maxSelfHealRetries)}
              />
            )}
          </div>
        </section>

        {/* Run History */}
        <section>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Run History
          </h2>
          {runsLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 rounded-lg border bg-muted/30 animate-pulse" />
              ))}
            </div>
          ) : !runs || runs.length === 0 ? (
            <EmptyState icon={Play} message="No runs yet" />
          ) : (
            <div className="rounded-lg border bg-card divide-y">
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-accent/30 transition-colors cursor-pointer"
                  onClick={() => navigate(`/pipeline-runs/${run.id}`)}
                >
                  <StatusBadge status={run.status} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground">
                      {run.startedAt ? relativeTime(run.startedAt) : relativeTime(run.createdAt)}
                    </p>
                  </div>
                  {parseFloat(run.totalCostUsd) > 0 && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      ${parseFloat(run.totalCostUsd).toFixed(4)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}
