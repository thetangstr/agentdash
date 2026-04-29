import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { authApi } from "../../api/auth";
import { queryKeys } from "../../lib/queryKeys";
import { healthApi } from "../../api/health";
import { MarketingShell } from "../MarketingShell";

export function Landing() {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  if (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading)) return null;

  // local_trusted mode = no auth boundary; logged-in semantics apply.
  // authenticated mode + session = logged in.
  const loggedIn = !isAuthenticatedMode || Boolean(sessionQuery.data);
  if (loggedIn) return <Navigate to="/companies" replace />;

  return (
    <MarketingShell>
      <h1>Landing — placeholder</h1>
    </MarketingShell>
  );
}
