// AgentDash: the queries CloudAccessGate decides on (session, board access,
// health) are cached from before a sign-up or the first company existed. A
// founder who claims a box, signs up, or creates the first workspace must not
// be judged on that stale cache, or the gate shows "No company access" until a
// reload. Every path that can sign someone up or create the first company
// calls this before it navigates.
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

export const ACCESS_QUERY_KEYS: readonly QueryKey[] = [
  queryKeys.auth.session,
  queryKeys.access.currentBoardAccess,
  queryKeys.health,
  queryKeys.companies.all,
];

/**
 * Mark the access queries stale and refetch them now, including the inactive
 * ones (the gate is not mounted on /claim or /auth), so the gate's first render
 * after navigation sees fresh data. A failed refetch is not thrown: the gate
 * shows its own error state.
 */
export async function refreshAccessQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    ACCESS_QUERY_KEYS.map((queryKey) =>
      Promise.resolve(queryClient.invalidateQueries({ queryKey, refetchType: "all" })).catch(() => undefined),
    ),
  );
}
