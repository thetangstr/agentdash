import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { accessApi } from "../api/access";
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

/**
 * AgentDash (b2 polish): mirrors the server's hasBoardOrgAccess — board actor
 * AND (local implicit, instance admin, or ≥1 company membership). A session
 * alone is not enough: a signed-up founder on /company-create has a session
 * but no membership yet, and org-scoped reads (GET /api/adapters) answer 403.
 *
 * Reuses CloudAccessGate's currentBoardAccess cache entry, so the check adds
 * no request on gated routes. Local trusted mode always has org access via
 * local_implicit, so no /cli-auth/me call is made there.
 *
 * Fails open like useBoardSessionReady: on an access-check error the reads
 * run as before and surface their own errors.
 */
export function useBoardOrgAccess(): boolean {
  const sessionReady = useBoardSessionReady();
  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const authenticatedMode = health.data?.deploymentMode === "authenticated";
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: sessionReady && authenticatedMode,
    retry: false,
  });

  if (!sessionReady) return false;
  if (!authenticatedMode) return true;
  if (access.isError) return true;
  if (!access.data) return false;
  return access.data.isInstanceAdmin || access.data.companyIds.length > 0;
}

/**
 * AgentDash (c3 copy): whether this board session is an instance admin —
 * used to keep operator-only notices (e.g. the adapter alpha warning) off an
 * owner's screen. Local trusted mode is the admin by definition; a session
 * without the flag is not. Fails open like the other gates.
 */
export function useIsInstanceAdmin(): boolean {
  const sessionReady = useBoardSessionReady();
  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const authenticatedMode = health.data?.deploymentMode === "authenticated";
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: sessionReady && authenticatedMode,
    retry: false,
  });

  if (!sessionReady) return false;
  if (!authenticatedMode) return true;
  if (access.isError) return true;
  if (!access.data) return false;
  return access.data.isInstanceAdmin;
}
