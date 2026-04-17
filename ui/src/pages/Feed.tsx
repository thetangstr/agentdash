// AgentDash: Feed page — unified activity timeline
import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Activity,
  Coins,
  DollarSign,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { feedApi, type FeedEvent, type FeedPage } from "../api/feed";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "../lib/timeAgo";

function feedQueryKey(companyId: string) {
  return ["feed", companyId] as const;
}

function FeedEventIcon({ type }: { type: string }) {
  const iconMap: Record<string, LucideIcon> = {
    approval_decision: ShieldCheck,
    cost_event: Coins,
    finance: DollarSign,
    kill_switch: ShieldAlert,
    skill_use: Sparkles,
    heartbeat: Zap,
  };
  const Icon: LucideIcon = iconMap[type] ?? Activity;
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
    </span>
  );
}

export function Feed() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Feed" }]);
  }, [setBreadcrumbs]);

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<FeedPage>({
    queryKey: selectedCompanyId
      ? feedQueryKey(selectedCompanyId)
      : ["feed", "_none_"],
    queryFn: ({ pageParam }) =>
      feedApi.list(selectedCompanyId!, { cursor: pageParam as string | null }),
    enabled: !!selectedCompanyId,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground p-6">Select a company first.</p>;
  }

  const events: FeedEvent[] = (data?.pages ?? []).flatMap((p) => p.events);
  const lastPage = data?.pages?.[data.pages.length - 1];
  const showLoadMore = !!lastPage?.nextCursor || hasNextPage;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Feed</h1>
        <p className="text-sm text-muted-foreground">
          Unified activity across approvals, costs, skills, and runs.
        </p>
      </div>

      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load feed"}
        </p>
      )}

      {isLoading && (
        <div className="space-y-2" data-testid="feed-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {!isLoading && events.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Activity className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No activity yet</p>
        </div>
      )}

      {events.length > 0 && (
        <ol className="divide-y divide-border border border-border rounded-lg overflow-hidden">
          {events.map((event) => (
            <li
              key={`${event.type}:${event.id}`}
              className="flex items-center gap-3 px-3 py-2 hover:bg-accent/30"
              data-testid={`feed-event-${event.id}`}
            >
              <FeedEventIcon type={event.type} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{event.title}</p>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {timeAgo(event.at)}
              </span>
            </li>
          ))}
        </ol>
      )}

      {events.length > 0 && showLoadMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
