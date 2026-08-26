import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@/lib/router";
import { onboardingApi } from "@/api/onboarding";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";

export function MemberOnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery({
    queryKey: queryKeys.onboarding.memberSessions,
    queryFn: () => onboardingApi.listMemberSessions(),
    retry: false,
  });
  const session = sessionsQuery.data?.find((row) => row.status === "in_progress") ?? null;
  const completedSession = sessionsQuery.data?.find((row) => row.status === "completed") ?? null;

  const advance = useMutation({
    mutationFn: () =>
      onboardingApi.advanceMemberSession(session!.companyId, "workspace"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.onboarding.memberSessions }),
  });
  const complete = useMutation({
    mutationFn: () => onboardingApi.completeMemberSession(session!.companyId),
    onSuccess: () => {
      navigate(`/${session!.issuePrefix}/dashboard`, { replace: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.onboarding.memberSessions });
    },
  });

  if (sessionsQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading onboarding…</div>;
  }
  if (sessionsQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {sessionsQuery.error instanceof Error
          ? sessionsQuery.error.message
          : "Failed to load onboarding"}
      </div>
    );
  }
  if (!session) {
    return (
      <Navigate
        to={completedSession ? `/${completedSession.issuePrefix}/dashboard` : "/companies"}
        replace
      />
    );
  }

  const isWelcome = session.currentStep === "welcome";
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-2xl items-center px-6 py-12">
      <section className="w-full rounded-xl border border-border bg-card p-8 shadow-sm">
        <p className="text-sm font-medium text-primary">{session.companyName}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {isWelcome ? "Welcome to your workspace" : "Your workspace is ready"}
        </h1>
        <p className="mt-4 text-muted-foreground">
          {isWelcome
            ? "AgentDash keeps your team’s work, agent activity, and approvals in one place. Your existing company role and permissions stay unchanged."
            : "Open tasks show work that is not done or cancelled. You can leave at any time and this step will resume when you return."}
        </p>
        <div className="mt-8 flex items-center justify-between gap-4">
          <span className="text-xs text-muted-foreground">
            Step {isWelcome ? "1" : "2"} of 2
          </span>
          {isWelcome ? (
            <Button disabled={advance.isPending} onClick={() => advance.mutate()}>
              Continue
            </Button>
          ) : (
            <Button disabled={complete.isPending} onClick={() => complete.mutate()}>
              Open dashboard
            </Button>
          )}
        </div>
      </section>
    </main>
  );
}
