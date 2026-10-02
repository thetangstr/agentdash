import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WaitingOnYou } from "@paperclipai/shared";
import { dashboardApi } from "../api/dashboard";
import { queryKeys } from "../lib/queryKeys";
import { useDecisionsOtherSources } from "./useDecisionsSources";

/**
 * AgentDash: UX-7 (GH #788) — the Decisions page's main-list length: every
 * waiting approval plus every manual-origin issue assigned to the person.
 * Both totals are computed server-side before the item caps, so this number
 * is never limited by how many rows the payload happened to carry.
 * Machine-generated rows are reported separately in `otherTasksAssignedToYou`
 * and never count here.
 */
export function decisionsListLength(data: WaitingOnYou | undefined): number {
  if (!data) return 0;
  return (
    (data.total ?? 0) +
    (data.tasksAssignedToYouTotal ?? 0) +
    (data.pendingQuestionsTotal ?? 0) +
    // AgentDash (MVP launch lane B): deliverables waiting for the person's review.
    (data.reviewsWaitingTotal ?? 0)
  );
}

/**
 * Everything Decisions shows, counted the way the page counts it: the main
 * list plus every other section (steward approvals, fact requests, outside
 * writes to confirm, join requests, override items, failed runs), with the
 * approvals the main list already shows dropped from the other sections.
 *
 * One definition for the sidebar badge, the mobile badge, Home's Waiting on
 * you and the page header — they all call this, and it reads the same query
 * keys as the page, so each source is fetched once however many surfaces
 * show the number.
 */
export function useDecisionsCount(companyId: string | null | undefined, enabled = true) {
  const { data: waiting, isLoading, isError, error } = useQuery({
    queryKey: queryKeys.home.waitingOnYou(companyId ?? ""),
    queryFn: () => dashboardApi.waitingOnYou(companyId!),
    enabled: !!companyId && enabled,
    refetchInterval: 30_000,
  });
  const shownApprovalIds = useMemo(
    () => new Set((waiting?.decisions ?? []).map((decision) => decision.approvalId)),
    [waiting],
  );
  const sources = useDecisionsOtherSources(companyId, shownApprovalIds, enabled);
  const main = decisionsListLength(waiting);
  return {
    waiting,
    isLoading,
    isError,
    error,
    sources,
    /** The main list: approvals + manual issues assigned to the person. */
    main,
    /** Everything the page shows — the one number every surface displays. */
    total: main + sources.total,
  };
}

/** The Decisions count, read as a badge. */
export function useDecisionsBadge(companyId: string | null | undefined, enabled = true): number {
  return useDecisionsCount(companyId, enabled).total;
}
