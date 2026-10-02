/**
 * AgentDash: the front-door pages (/start, /start/verify, /start/progress,
 * /find) belong to www.agentdash.cloud. They call /api/cloud/*, which exists
 * only on www's control plane, so on a hosted box they fail with "API route
 * not found". The SPA bundle is the same on both, so a box (health.hostedBox)
 * sends these paths to its own sign-in instead; once signed in, /auth carries
 * the user on to the app.
 *
 * www's signup funnel must never wait on /api/health (on www it is proxied to
 * another service and can be slow, gone or not JSON). So the page renders
 * immediately, and only a health answer that positively says hostedBox
 * redirects. Loading, an error, a 410, non-JSON or a hung request all leave
 * the www page in place.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";

/** Where a box sends a visitor who lands on a www-only page: its own sign-in, then home. */
export const BOX_SIGN_IN_PATH = "/auth?next=%2F";

export function WwwOnlyRoute({ children }: { children: ReactNode }) {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  if (healthQuery.data?.hostedBox === true) return <Navigate to={BOX_SIGN_IN_PATH} replace />;
  return <>{children}</>;
}
