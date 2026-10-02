import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";

export type BoardSessionState = "pending" | "ready" | "signed_out";

/**
 * AgentDash (scan 4, lane O2): whether board-scoped API reads may run yet.
 *
 * A signed-out visitor on /auth used to fire GET /api/companies (43x) and
 * GET /api/adapters (15x), each answered 403, because the providers that
 * load them sit above the router and query unconditionally. They now wait
 * until the instance is known to let this browser in: local trusted mode
 * always does, authenticated mode once there is a session. Both questions
 * share CloudAccessGate's cache entries, so no extra requests are made.
 *
 * Fails open: if either check errors, the reads run as before and surface
 * their own errors.
 */
export function useBoardSessionState(): BoardSessionState {
  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const authenticatedMode = health.data?.deploymentMode === "authenticated";
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: authenticatedMode,
    retry: false,
  });

  if (health.isError) return "ready";
  if (!health.data) return "pending";
  if (!authenticatedMode) return "ready";
  if (session.isError || session.data != null) return "ready";
  return session.isPending ? "pending" : "signed_out";
}

export function useBoardSessionReady(): boolean {
  return useBoardSessionState() === "ready";
}
