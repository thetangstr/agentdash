import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

/**
 * AgentDash (c4-polish): after Accept / Request changes resolves, every
 * surface that counted the deliverable must read committed state. The
 * canary saw the "ready for review" chip and the Decisions badge stay stale
 * until reload — the Result block and badge poll independently, and the
 * decisions sources were never invalidated at all. `refetchQueries` forces
 * an immediate post-response fetch on the affected queries instead of
 * relying on staleness marks and poll intervals lining up after the write.
 */
export async function refetchAfterReviewDecision(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
): Promise<void> {
  await Promise.all([
    queryClient.refetchQueries({ queryKey: ["shipped", companyId] }),
    queryClient.refetchQueries({ queryKey: queryKeys.issues.workProducts(issueId) }),
    queryClient.refetchQueries({ queryKey: queryKeys.home.waitingOnYou(companyId) }),
    queryClient.invalidateQueries({ queryKey: ["decisions", "sources", companyId] }),
  ]);
}
