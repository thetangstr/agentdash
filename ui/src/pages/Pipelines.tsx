// AgentDash: Pipeline list page
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { pipelinesApi } from "../api/pipelines";
import { DagPreview } from "../components/DagPreview";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";
import { GitBranch, Plus, Play, Archive } from "lucide-react";

export function Pipelines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipelines" }]);
  }, [setBreadcrumbs]);

  const { data: pipelines, isLoading } = useQuery({
    queryKey: queryKeys.pipelines.list(selectedCompanyId!),
    queryFn: () => pipelinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const startRunMutation = useMutation({
    mutationFn: (pipelineId: string) =>
      pipelinesApi.startRun(selectedCompanyId!, pipelineId),
    onSuccess: (run) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pipelines.list(selectedCompanyId!),
      });
      navigate(`/pipeline-runs/${run.id}`);
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (pipelineId: string) =>
      pipelinesApi.update(selectedCompanyId!, pipelineId, { status: "archived" }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.pipelines.list(selectedCompanyId!),
      });
    },
  });

  if (!selectedCompanyId) {
    return (
      <p className="text-sm text-muted-foreground p-6">Select a company first.</p>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b">
        <GitBranch className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold flex-1">Pipelines</h1>
        <Button size="sm" asChild>
          <Link to="/pipelines/new">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Pipeline
          </Link>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {isLoading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-36 rounded-lg border bg-muted/30 animate-pulse" />
            ))}
          </div>
        ) : !pipelines || pipelines.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            message="No pipelines yet"
            action="New Pipeline"
            onAction={() => navigate("/pipelines/new")}
          />
        ) : (
          <div className="space-y-3">
            {pipelines.map((pipeline) => (
              <div
                key={pipeline.id}
                className="rounded-lg border bg-card hover:bg-accent/30 transition-colors cursor-pointer"
                onClick={() => navigate(`/pipelines/${pipeline.id}`)}
              >
                <div className="flex items-start gap-4 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium truncate">{pipeline.name}</span>
                      <StatusBadge status={pipeline.status} />
                    </div>
                    {pipeline.description && (
                      <p className="text-xs text-muted-foreground truncate mb-1">
                        {pipeline.description}
                      </p>
                    )}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{pipeline.stages.length} stage{pipeline.stages.length !== 1 ? "s" : ""}</span>
                      <span>{pipeline.executionMode}</span>
                      <span>Updated {relativeTime(pipeline.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {pipeline.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => startRunMutation.mutate(pipeline.id)}
                        disabled={startRunMutation.isPending && startRunMutation.variables === pipeline.id}
                      >
                        <Play className="h-3.5 w-3.5 mr-1.5" />
                        Start Run
                      </Button>
                    )}
                    {pipeline.status !== "archived" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => archiveMutation.mutate(pipeline.id)}
                        disabled={archiveMutation.isPending && archiveMutation.variables === pipeline.id}
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                {pipeline.stages.length > 0 && (
                  <div className="px-4 pb-3 overflow-x-auto">
                    <DagPreview
                      stages={pipeline.stages}
                      edges={pipeline.edges}
                      className="max-h-24"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default Pipelines;
