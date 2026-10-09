import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { useStewardedRoutingNotice } from "../hooks/useStewardedRoutingNotice";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { createIssueDetailLocationState, createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import {
  WorkViewTabs,
  filterIssuesForWorkView,
  parseWorkView,
  workViewFilters,
} from "../components/WorkViewTabs";
import { CircleDot } from "lucide-react";
import type { Issue } from "@paperclipai/shared";

const WORKSPACE_FILTER_ISSUE_LIMIT = 1000;
const ISSUES_PAGE_SIZE = 500;

export function getNextIssuesPageOffset(
  loadedPageSize: number,
  currentOffset: number,
  pageSize: number = ISSUES_PAGE_SIZE,
): number | undefined {
  return loadedPageSize >= pageSize ? currentOffset + pageSize : undefined;
}

export function mergeIssuePagesStable(pages: Issue[][]): Issue[] {
  const seenIssueIds = new Set<string>();
  const merged: Issue[] = [];

  for (const page of pages) {
    for (const issue of page) {
      if (seenIssueIds.has(issue.id)) continue;
      seenIssueIds.add(issue.id);
      merged.push(issue);
    }
  }

  return merged;
}

export function buildIssuesSearchUrl(currentHref: string, search: string): string | null {
  const url = new URL(currentHref);
  const currentSearch = url.searchParams.get("q") ?? "";
  if (currentSearch === search) return null;

  if (search.length > 0) {
    url.searchParams.set("q", search);
  } else {
    url.searchParams.delete("q");
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

/** AgentDash (review #1003, round 2): the toast a failed issue update shows
 * on the list/board. A document_revision_required refusal links to the issue
 * page, where the documents can actually be read before accepting. */
export function issueUpdateErrorToast(err: unknown, issueId: string, identifier?: string | null) {
  const code =
    err instanceof ApiError
      ? (err.body as { details?: { code?: unknown } } | null | undefined)?.details?.code
      : undefined;
  // AgentDash (c3 copy): a document_revision_required refusal is a guard doing
  // its job, not a failure — it reads as a step ("review, then done"), in
  // neutral styling with a link to where the document can be read.
  if (code === "document_revision_required") {
    return {
      title: `Review ${identifier ?? "the issue"} before marking it done`,
      body: "Open the issue to review the latest document.",
      tone: "info" as const,
      action: { label: "Open the issue", href: createIssueDetailPath(issueId) },
    };
  }
  return {
    title: "Issue update failed",
    body: err instanceof Error ? err.message : "Unable to save issue changes",
    tone: "error" as const,
  };
}

export function Issues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const fetchNextPageInFlightRef = useRef(false);

  const urlSearch = searchParams.get("q") ?? "";
  const [searchOverride, setSearchOverride] = useState<{ search: string; locationSearch: string } | null>(null);
  const syncedSearch = useMemo(() => {
    if (typeof window !== "undefined" && searchOverride?.locationSearch === window.location.search) {
      return searchOverride.search;
    }
    return urlSearch;
  }, [searchOverride, urlSearch, location.search]);
  const participantAgentId = searchParams.get("participantAgentId") ?? undefined;
  // AgentDash (one UX): "Touched by me" / "Unread", the Inbox views MK kept.
  const workView = parseWorkView(searchParams.get("view"));
  const initialWorkspaces = searchParams.getAll("workspace").filter((workspaceId) => workspaceId.length > 0);
  const workspaceIdFilter = initialWorkspaces.length === 1 ? initialWorkspaces[0] : undefined;
  const handleSearchChange = useCallback((search: string) => {
    const nextUrl = buildIssuesSearchUrl(window.location.href, search);
    if (!nextUrl) {
      setSearchOverride(null);
      return;
    }
    window.history.replaceState(window.history.state, "", nextUrl);
    setSearchOverride({ search, locationSearch: window.location.search });
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Work",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Work" }]);
  }, [setBreadcrumbs]);

  const issuePageSize = workspaceIdFilter ? WORKSPACE_FILTER_ISSUE_LIMIT : ISSUES_PAGE_SIZE;

  const {
    data: issuePages,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "participant-agent",
      participantAgentId ?? "__all__",
      "workspace",
      workspaceIdFilter ?? "__all__",
      "with-routine-executions",
      "view",
      workView,
      "infinite",
      issuePageSize,
    ],
    queryFn: ({ pageParam }) => issuesApi.list(selectedCompanyId!, {
      participantAgentId,
      workspaceId: workspaceIdFilter,
      ...workViewFilters(workView),
      includeRoutineExecutions: true,
      limit: issuePageSize,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      getNextIssuesPageOffset(lastPage.length, lastPageParam, issuePageSize),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData) => previousData,
  });

  const issues = useMemo(
    () => filterIssuesForWorkView(mergeIssuePagesStable(issuePages?.pages ?? []), workView),
    [issuePages, workView],
  );
  const hasMoreServerIssues = syncedSearch.trim().length === 0
    && hasNextPage === true;
  const loadMoreServerIssues = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage || fetchNextPageInFlightRef.current) return;
    fetchNextPageInFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => {
      fetchNextPageInFlightRef.current = false;
    });
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const announceRouting = useStewardedRoutingNotice(selectedCompanyId);
  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: (response) => {
      announceRouting(response);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
    onError: (err, variables) => {
      const identifier = issues.find((issue) => issue.id === variables.id)?.identifier;
      pushToast(issueUpdateErrorToast(err, variables.id, identifier));
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view issues." />;
  }

  return (
    <div className="space-y-3">
      <WorkViewTabs view={workView} />
      <IssuesList
        issues={issues ?? []}
        isLoading={isLoading}
        isLoadingMoreIssues={isFetchingNextPage}
        error={error as Error | null}
        agents={agents}
        projects={projects}
        liveIssueIds={liveIssueIds}
        viewStateKey="paperclip:issues-view"
        issueLinkState={issueLinkState}
        showAskEmptyState
        initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
        initialWorkspaces={initialWorkspaces.length > 0 ? initialWorkspaces : undefined}
        initialSearch={syncedSearch}
        onSearchChange={handleSearchChange}
        enableRoutineVisibilityFilter
        hasMoreIssues={hasMoreServerIssues}
        onLoadMoreIssues={loadMoreServerIssues}
        onUpdateIssue={(id, data) => {
          // AgentDash (review #1003): moving to done accepts the issue's
          // deliverables — the server needs the document revisions the person
          // saw as the baseline. The list/board shows no documents, so only a
          // cached set (rendered on the issue page earlier) counts; with none,
          // no baseline is sent and the server refuses with
          // document_revision_required — the error toast then links to the
          // issue page, where the documents can be read before accepting.
          const documents = data.status === "done"
            ? queryClient.getQueryData<Awaited<ReturnType<typeof issuesApi.listDocuments>>>(queryKeys.issues.documents(id))
            : undefined;
          const acceptedDocumentRevisions = documents?.length
            ? Object.fromEntries(documents.map((doc) => [doc.key, doc.latestRevisionNumber]))
            : undefined;
          updateIssue.mutate({ id, data: { ...data, acceptedDocumentRevisions } });
        }}
        searchFilters={
          participantAgentId || workspaceIdFilter || workView !== "all"
            ? { participantAgentId, workspaceId: workspaceIdFilter, ...workViewFilters(workView) }
            : undefined
        }
      />
    </div>
  );
}
