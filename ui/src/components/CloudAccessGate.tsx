import { useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { onboardingApi } from "@/api/onboarding";
import { queryKeys } from "@/lib/queryKeys";
import { FIRST_COMPANY_PATH } from "@/lib/onboarding-route";

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Instance setup required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "No instance admin exists yet. A bootstrap invite is already active. Check your AgentDash startup logs for the first admin invite URL, or run this command to rotate it:"
            : "No instance admin exists yet. Run this command in your AgentDash environment to generate the first admin invite URL:"}
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
          this AgentDash instance.
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

  const memberOnboardingQuery = useQuery({
    queryKey: queryKeys.onboarding.memberSessions,
    queryFn: () => onboardingApi.listMemberSessions(),
    enabled:
      isAuthenticatedMode &&
      !!sessionQuery.data &&
      (boardAccessQuery.data?.companyIds.length ?? 0) > 0,
    retry: false,
  });

  // AgentDash: a founder who just claimed a box or created the first company
  // can arrive here with board access cached from before the company existed
  // while health (which polls during bootstrap) already says a company exists.
  // That combination used to dead-end on "No company access" until a reload.
  // When board access is older than the session or health data it is judged
  // against, refetch it once before deciding the user has no access.
  const noBoardAccessCandidate =
    isAuthenticatedMode &&
    !!sessionQuery.data &&
    !!boardAccessQuery.data &&
    !boardAccessQuery.data.isInstanceAdmin &&
    boardAccessQuery.data.companyIds.length === 0 &&
    healthQuery.data?.instanceHasCompany === true;
  const accessJudgedAt = Math.max(sessionQuery.dataUpdatedAt, healthQuery.dataUpdatedAt);
  const boardAccessIsStale = noBoardAccessCandidate && boardAccessQuery.dataUpdatedAt < accessJudgedAt;
  const staleRefetchFor = useRef<number | null>(null);
  const staleRefetchPending = boardAccessIsStale && staleRefetchFor.current !== accessJudgedAt;
  const refetchBoardAccess = boardAccessQuery.refetch;
  useEffect(() => {
    if (!boardAccessIsStale || staleRefetchFor.current === accessJudgedAt) return;
    staleRefetchFor.current = accessJudgedAt;
    void refetchBoardAccess();
  }, [boardAccessIsStale, accessJudgedAt, refetchBoardAccess]);

  if (
    staleRefetchPending ||
    (noBoardAccessCandidate && boardAccessQuery.isFetching) ||
    healthQuery.isLoading ||
    (isAuthenticatedMode && sessionQuery.isLoading) ||
    (isAuthenticatedMode && !!sessionQuery.data && boardAccessQuery.isLoading) ||
    memberOnboardingQuery.isFetching
  ) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (healthQuery.error || boardAccessQuery.error || memberOnboardingQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error
          ? healthQuery.error.message
          : boardAccessQuery.error instanceof Error
            ? boardAccessQuery.error.message
            : memberOnboardingQuery.error instanceof Error
              ? memberOnboardingQuery.error.message
              : "Failed to load app state"}
      </div>
    );
  }

  // AgentDash: self-serve-bootstrap — when the env flag is on, a signed-in
  // first user on a fresh instance is routed to create the first company (and
  // is promoted to instance_admin server-side on company creation) instead of
  // the CLI bootstrap page. When the flag is off, the CLI BootstrapPendingPage
  // is shown as before.
  const selfServeBootstrap = healthQuery.data?.selfServeBootstrap === true;
  const instanceHasCompany = healthQuery.data?.instanceHasCompany === true;
  // AgentDash (GH #786, one onboarding path): every founder, hosted box or
  // self-hosted, names the workspace at /company-create and continues to the
  // /setup first run, then the Chief of Staff. The six-step wizard is no
  // longer where a new user is sent; a deep link to /onboarding still opens.
  // (A hosted box has no wizard at all: /onboarding is sent to /company-create.)
  const hostedBox = healthQuery.data?.hostedBox === true;
  const selfServeTarget = FIRST_COMPANY_PATH;
  const selfServePathAllowed =
    location.pathname === selfServeTarget || (!hostedBox && location.pathname === "/onboarding");

  if (isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
    if (selfServeBootstrap && sessionQuery.data) {
      if (selfServePathAllowed) return <Outlet />;
      return <Navigate to={selfServeTarget} replace />;
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
    // company yet) route the first user to name the workspace instead of a
    // dead-end. Once any company exists, keep invite-only "No company access".
    if (selfServeBootstrap && !instanceHasCompany) {
      if (selfServePathAllowed) return <Outlet />;
      return <Navigate to={selfServeTarget} replace />;
    }
    return <NoBoardAccessPage />;
  }

  const incompleteMemberSession = memberOnboardingQuery.data?.find(
    (session) => session.status === "in_progress",
  );
  if (incompleteMemberSession && location.pathname !== "/member-onboarding") {
    return <Navigate to="/member-onboarding" replace />;
  }

  return <Outlet />;
}
