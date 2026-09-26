// AgentDash: UX-2 (#783) — the Shipped page: every work product across the
// company, newest first, with the issue it belongs to, the agent, when, and the
// metered usage of the runs on that issue.
import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { PackageCheck } from "lucide-react";
import type { ShippedFeed } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatShippedUsage } from "../lib/shipped";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageSkeleton } from "../components/PageSkeleton";
import { ShippedWorkProductRow } from "../components/ShippedWorkProductRow";

export const SHIPPED_PAGE_SIZE = 50;
export const SHIPPED_EMPTY_TEXT =
  "Pull requests and results land here with what they cost. Your first one usually takes 20 to 30 minutes.";
const ALL = "__all__";

function monthLabel(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}

export function Shipped() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [projectId, setProjectId] = useState(ALL);
  const [agentId, setAgentId] = useState(ALL);

  useEffect(() => {
    setBreadcrumbs([{ label: "Shipped" }]);
  }, [setBreadcrumbs]);

  const filters = {
    projectId: projectId === ALL ? undefined : projectId,
    agentId: agentId === ALL ? undefined : agentId,
  };

  const feed = useInfiniteQuery({
    queryKey: queryKeys.shipped(selectedCompanyId ?? "", filters),
    queryFn: ({ pageParam }) =>
      issuesApi.listShipped(selectedCompanyId!, {
        ...filters,
        limit: SHIPPED_PAGE_SIZE,
        before: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ShippedFeed) => last.nextCursor,
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId || feed.isLoading) return <PageSkeleton variant="list" />;

  const pages = feed.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const month = pages[0]?.monthTotal;
  const filtered = projectId !== ALL || agentId !== ALL;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Shipped</h1>
          {month ? (
            <p className="text-sm text-muted-foreground" data-testid="shipped-month-total">
              {monthLabel(month.since)}: {month.count} shipped
              {month.pullRequests > 0 ? ` (${month.pullRequests} pull ${month.pullRequests === 1 ? "request" : "requests"})` : ""}
              {" · "}
              {formatShippedUsage(month.usage)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Filter by project">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All projects</SelectItem>
              {(projects ?? []).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Filter by agent">
              <SelectValue placeholder="All agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All agents</SelectItem>
              {(agents ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {feed.error ? <p className="text-sm text-destructive">{(feed.error as Error).message}</p> : null}

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center" data-testid="shipped-empty">
          <div className="mb-4 bg-muted/50 p-4">
            <PackageCheck className="h-10 w-10 text-muted-foreground/50" />
          </div>
          <p className="mb-4 max-w-md text-sm text-muted-foreground">
            {filtered ? "Nothing shipped for this filter yet." : SHIPPED_EMPTY_TEXT}
          </p>
          {!filtered ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/dashboard">See what's running</Link>
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {items.map((product) => (
            <ShippedWorkProductRow key={product.id} product={product} />
          ))}
        </div>
      )}

      {feed.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void feed.fetchNextPage()}
            disabled={feed.isFetchingNextPage}
          >
            {feed.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
