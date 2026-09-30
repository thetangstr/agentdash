import { useQuery } from "@tanstack/react-query";
import type { WaitingOnYou } from "@paperclipai/shared";
import { dashboardApi } from "../api/dashboard";
import { queryKeys } from "../lib/queryKeys";

/**
 * AgentDash: UX-7 (GH #788) — the Decisions page's main-list length: every
 * waiting approval plus every manual-origin issue assigned to the person.
 * Both totals are computed server-side before the item caps, so this number
 * is never limited by how many rows the payload happened to carry — the
 * sidebar badge, the mobile badge, Home's count and the page's own count
 * are all this one number. Machine-generated rows are reported separately
 * in `otherTasksAssignedToYou` and never count here.
 */
export function decisionsListLength(data: WaitingOnYou | undefined): number {
  if (!data) return 0;
  return (data.total ?? 0) + (data.tasksAssignedToYouTotal ?? 0);
}

/**
 * The shared waiting-on-you query, read as a badge count — the one badge
 * every company's sidebar and mobile nav show (doc/plans/2026-09-30-one-ux.md).
 */
export function useDecisionsBadge(companyId: string | null | undefined, enabled = true): number {
  const { data } = useQuery({
    queryKey: queryKeys.home.waitingOnYou(companyId ?? ""),
    queryFn: () => dashboardApi.waitingOnYou(companyId!),
    enabled: !!companyId && enabled,
    refetchInterval: 30_000,
  });
  return decisionsListLength(data);
}
