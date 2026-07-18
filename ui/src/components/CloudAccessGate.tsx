import { Navigate, Outlet, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Instance setup required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "No instance admin exists yet. A bootstrap invite is already active. Check your Paperclip startup logs for the first admin invite URL, or run this command to rotate it:"
            : "No instance admin exists yet. Run this command in your Paperclip environment to generate the first admin invite URL:"}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm paperclipai auth bootstrap-ceo`}
        </pre>
      </div>
    </div>
  );
}

function NoBoardAccessPage() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">No company access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is signed in, but it does not have an active company membership or instance-admin access on
          this Paperclip instance.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Use a company invite or sign in with an account that already belongs to this org.
        </p>
      </div>
    </div>
  );
}

export function CloudAccessGate() {
  const location = useLocation();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: isAuthenticatedMode && !!sessionQuery.data,
    retry: false,
  });

  if (
    healthQuery.isLoading ||
    (isAuthenticatedMode && sessionQuery.isLoading) ||
    (isAuthenticatedMode && !!sessionQuery.data && boardAccessQuery.isLoading)
  ) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (healthQuery.error || boardAccessQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error
          ? healthQuery.error.message
          : boardAccessQuery.error instanceof Error
            ? boardAccessQuery.error.message
            : "Failed to load app state"}
      </div>
    );
  }

  // AgentDash: self-serve-bootstrap — when the env flag is on, a signed-in
  // first user on a fresh instance is routed to the onboarding wizard to
  // create the first company (and is promoted to instance_admin server-side
  // on company creation) instead of the CLI bootstrap page. When the flag is
  // off, the CLI BootstrapPendingPage is shown as before.
  const selfServeBootstrap = healthQuery.data?.selfServeBootstrap === true;
  const instanceHasCompany = healthQuery.data?.instanceHasCompany === true;

  if (isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
    if (selfServeBootstrap && sessionQuery.data) {
      return <Navigate to="/onboarding" replace />;
    }
    return <BootstrapPendingPage hasActiveInvite={healthQuery.data.bootstrapInviteActive} />;
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  if (
    isAuthenticatedMode &&
    sessionQuery.data &&
    !boardAccessQuery.data?.isInstanceAdmin &&
    (boardAccessQuery.data?.companyIds.length ?? 0) === 0
  ) {
    // AgentDash (Test Drive, Slice 4): a just-signed-up user has no company
    // membership YET — the trial claim handoff is exactly what creates it.
    // Let an authenticated session through to /trial/claim (auth is still
    // enforced above) so it can bind the trial workspace, instead of bouncing
    // to the dead-end "No company access" page.
    if (location.pathname === "/trial/claim") {
      return <Outlet />;
    }
    // AgentDash: self-serve-bootstrap — on a fresh instance (flag on, no
    // company yet) route the first user to the onboarding wizard instead of a
    // dead-end. Once any company exists, keep invite-only "No company access".
    if (selfServeBootstrap && !instanceHasCompany) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoBoardAccessPage />;
  }

  return <Outlet />;
}
