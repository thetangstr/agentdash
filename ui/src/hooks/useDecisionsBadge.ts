import { useQuery } from "@tanstack/react-query";
import type { WaitingOnYou } from "@paperclipai/shared";
import { dashboardApi } from "../api/dashboard";
import { queryKeys } from "../lib/queryKeys";

/**
 * AgentDash: UX-7 (GH #788) — the Decisions page's main-list length: every
 * waiting approval plus every issue assigned to the person that a human
 * filed. Machine-generated rows (non-`manual` originKind) group under
 * "Other activity" on the page and do not count here, so the sidebar badge,
 * the mobile badge, and the page's own count are all this one number.
 */
export function decisionsListLength(data: WaitingOnYou | undefined): number {
  if (!data) return 0;
  const manualTasks = data.tasksAssignedToYou.filter(
    (task) => (task.originKind ?? "manual") === "manual",
  );
  return data.decisions.length + manualTasks.length;
}

/**
 * The shared waiting-on-you query, read as a badge count. `enabled` is the
 * profile gate — the agentdash_mk profile keeps its own Inbox badge and
 * never asks this question.
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
