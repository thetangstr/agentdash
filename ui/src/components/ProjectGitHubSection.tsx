// AgentDash (GH #782): the GitHub connection of one project, in its
// Configuration tab. Same section for every company (one UX).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { githubConnectionsApi } from "@/api/githubConnections";
import { queryKeys } from "@/lib/queryKeys";
import { GitHubConnectStep } from "./onboarding/GitHubConnectStep";

export function ProjectGitHubSection({ companyId, projectId }: { companyId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.githubConnections.list(companyId),
    queryFn: () => githubConnectionsApi.list(companyId),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading GitHub connection…</p>;
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Could not load the GitHub connection."}
      </p>
    );
  }

  const connection = data?.connections.find((candidate) => candidate.projectId === projectId) ?? null;
  return (
    <div data-testid="project-github-section">
      <GitHubConnectStep
        key={connection?.id ?? "none"}
        variant="section"
        companyId={companyId}
        projectId={projectId}
        connection={connection}
        canManage={data?.canManage ?? false}
        onConnected={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.githubConnections.list(companyId) });
          // The project's codebase now points at the repo; its detail is keyed by
          // id or URL key, so refresh every project query.
          void queryClient.invalidateQueries({ queryKey: ["projects"] });
        }}
      />
    </div>
  );
}
