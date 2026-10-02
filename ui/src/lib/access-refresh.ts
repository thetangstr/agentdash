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

/** The longest a caller waits for the refetch before navigating anyway. */
export const ACCESS_REFRESH_TIMEOUT_MS = 5_000;

/**
 * Mark the access queries stale and refetch them now, including the inactive
 * ones (the gate is not mounted on /claim or /auth), so the gate's first render
 * after navigation sees fresh data. Never throws and never waits longer than
 * `timeoutMs`: a stuck fetch must not leave the founder on a spinning form.
 * The queries stay invalidated, so the gate still refetches what was missed
 * and shows its own error state.
 */
export async function refreshAccessQueries(
  queryClient: QueryClient,
  timeoutMs: number = ACCESS_REFRESH_TIMEOUT_MS,
): Promise<void> {
  const refetches = Promise.all(
    ACCESS_QUERY_KEYS.map((queryKey) =>
      Promise.resolve(queryClient.invalidateQueries({ queryKey, refetchType: "all" })).catch(() => undefined),
    ),
  ).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([refetches, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
