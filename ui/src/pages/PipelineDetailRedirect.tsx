// AgentDash (AGE-42): Redirect /pipelines/:pipelineId into the owning goal hub.
//
// Pipelines are no longer a top-level concept; they are "Playbooks" that roll
// up under a business Goal. When someone hits a legacy pipeline deep-link we
// look up the pipeline's goalId and forward them to the Goal detail page.
// If the pipeline has no linked goal we fall back to the legacy detail page
// as a dev-only debug surface (matches the /pipelines/_debug route).
import { useEffect } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { pipelinesApi } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import PipelineDetail from "./PipelineDetail";

/**
 * Resolve the destination for a legacy `/pipelines/:pipelineId` deep-link.
 * Exported for unit testing — keeps the branching logic independent of React.
 */
export function resolvePipelineRedirectTarget(
  pipeline: { goalId: string | null } | null | undefined,
): { kind: "goal"; goalId: string } | { kind: "fallback" } | { kind: "wait" } {
  if (!pipeline) return { kind: "wait" };
  if (pipeline.goalId) return { kind: "goal", goalId: pipeline.goalId };
  return { kind: "fallback" };
}

export function PipelineDetailRedirect() {
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const { data: pipeline, isLoading, error } = useQuery({
    queryKey: queryKeys.pipelines.detail(selectedCompanyId!, pipelineId!),
    queryFn: () => pipelinesApi.get(selectedCompanyId!, pipelineId!),
    enabled: !!selectedCompanyId && !!pipelineId,
  });

  useEffect(() => {
    if (!pipeline) return;
    const target = resolvePipelineRedirectTarget(pipeline);
    if (target.kind === "goal") {
      navigate(`/goals/${target.goalId}`, { replace: true });
    }
  }, [pipeline, navigate]);

  if (!selectedCompanyId) {
    return (
      <p className="text-sm text-muted-foreground p-6" data-testid="pipeline-redirect-no-company">
        Select a company first.
      </p>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive p-6" role="alert" data-testid="pipeline-redirect-error">
        Failed to load pipeline: {(error as Error).message}
      </p>
    );
  }

  if (isLoading || !pipeline) {
    return (
      <p className="text-sm text-muted-foreground p-6" data-testid="pipeline-redirect-loading">
        Redirecting to goal…
      </p>
    );
  }

  // No goal linked — fall back to the legacy detail view so pipelines created
  // before the goal-driven workflow still have a usable surface.
  return <PipelineDetail />;
}

export default PipelineDetailRedirect;
