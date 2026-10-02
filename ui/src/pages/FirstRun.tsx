// AgentDash (GH #786, UX-5): the first run at /setup.
//
//   model key → connect GitHub → first issue → Home         (hosted box)
//   runtime check → Chief of Staff; GitHub and first issue later (self-hosted)
//
// One path for every install (one UX): /company-create → /setup → /cos. On a
// hosted box the first step is the model key; elsewhere the server reports no
// model key is needed, and a workspace that was just named sees the runtime
// step instead (Claude Code, Codex or Hermes, checked on this machine).
//
// The step shown is the first incomplete one according to the server
// (GET /companies/:id/first-run), so leaving mid-flow and coming back resumes
// where the founder stopped. The CoS interview is not a step: Home offers
// "Plan with your Chief of Staff". Whether this flow applies to a company is
// the server's answer (`applies`); when it does not, the page goes to /cos.
// The page itself never reads the company's profile (one UX).
import { useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { firstRunApi, type FirstRunStep } from "@/api/firstRun";
import { onboardingApi } from "@/api/onboarding";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { FirstIssueStep } from "@/components/onboarding/FirstIssueStep";
import { GitHubConnectStep } from "@/components/onboarding/GitHubConnectStep";
import { HermesProviderStep } from "@/components/onboarding/HermesProviderStep";
import { ProviderKeyBlocked } from "@/components/onboarding/ProviderKeyBlocked";
import { RuntimeStep } from "@/components/onboarding/RuntimeStep";

const STEP_LABELS: Array<{ step: Exclude<FirstRunStep, "done">; label: string }> = [
  { step: "model", label: "Your model" },
  { step: "repo", label: "Your repo" },
  { step: "first_issue", label: "First issue" },
];

function StepIndicator({
  current,
  showModel,
  modelLabel,
}: {
  current: FirstRunStep;
  showModel: boolean;
  modelLabel?: string;
}) {
  const steps = STEP_LABELS.filter((entry) => showModel || entry.step !== "model").map((entry) =>
    entry.step === "model" && modelLabel ? { ...entry, label: modelLabel } : entry,
  );
  const currentIndex = steps.findIndex((entry) => entry.step === current);
  return (
    <ol className="mx-auto mt-10 flex max-w-lg gap-4 px-6 text-xs" aria-label="Setup progress" data-testid="first-run-progress">
      {steps.map((entry, index) => {
        const state = current === "done" || index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
        return (
          <li
            key={entry.step}
            aria-current={state === "current" ? "step" : undefined}
            className={
              state === "current"
                ? "font-semibold text-foreground"
                : state === "done"
                  ? "text-muted-foreground line-through"
                  : "text-muted-foreground"
            }
          >
            {index + 1}. {entry.label}
          </li>
        );
      })}
    </ol>
  );
}

export function FirstRunPage() {
  const { companies, selectedCompany, selectedCompanyId, setSelectedCompanyId, loading } = useCompany();
  const [searchParams] = useSearchParams();
  // /company-create passes the new workspace explicitly: the company list may
  // not include it yet, and the previously selected workspace must not be
  // mistaken for it.
  const requestedCompanyId = searchParams.get("companyId");
  const company = requestedCompanyId
    ? companies.find((candidate) => candidate.id === requestedCompanyId) ?? null
    : selectedCompany;
  const companyId = company?.id ?? null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!requestedCompanyId || loading) return;
    if (!company) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      return;
    }
    if (selectedCompanyId !== company.id) setSelectedCompanyId(company.id);
  }, [requestedCompanyId, loading, company, selectedCompanyId, setSelectedCompanyId, queryClient]);

  const statusQuery = useQuery({
    queryKey: queryKeys.firstRun(companyId ?? ""),
    queryFn: () => firstRunApi.status(companyId!),
    enabled: Boolean(companyId),
  });
  const status = statusQuery.data;
  const adapterQuery = useQuery({
    queryKey: ["onboarding-adapter-status"],
    queryFn: () => onboardingApi.adapterStatus(),
    enabled: status?.nextStep === "model",
    retry: false,
  });

  const home = company ? `/${company.issuePrefix}/dashboard` : "/";
  useEffect(() => {
    if (status?.applies && status.nextStep === "done") navigate(home, { replace: true });
  }, [status?.applies, status?.nextStep, home, navigate]);

  if (loading) return <div role="status" className="p-8 text-center text-sm text-muted-foreground">Loading…</div>;
  if (!company) {
    if (companies.length === 0 && !requestedCompanyId) return <Navigate to="/company-create" replace />;
    return <div role="status" className="p-8 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (statusQuery.error) {
    return (
      <div role="alert" className="p-8 text-center text-sm text-destructive">
        {statusQuery.error instanceof Error ? statusQuery.error.message : "Could not load setup."}
      </div>
    );
  }
  if (!status) return <div role="status" className="p-8 text-center text-sm text-muted-foreground">Loading…</div>;
  if (!status.applies) return <Navigate to="/cos" replace />;

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.firstRun(company.id) });

  if (!status.canManage) {
    return (
      <div className="mx-auto max-w-lg px-6 py-12 text-sm" data-testid="first-run-waiting">
        <h1 className="mb-2 text-lg font-semibold">Your workspace is still being set up</h1>
        <p className="text-muted-foreground">
          The workspace owner is connecting a model and a repository. You can look around in the meantime.
        </p>
        <Link className="mt-4 inline-block underline" to={home}>
          Go to Home
        </Link>
      </div>
    );
  }

  // Self-hosted: the hop from /company-create (it passes ?companyId=) shows the
  // runtime step before anything else. Whether a model key is required is the
  // server's answer, so a hosted box never sees this.
  const showRuntime =
    !status.model.required && Boolean(requestedCompanyId) && !status.repo.done && !status.firstIssue.done;

  let body: ReactNode = null;
  if (showRuntime) {
    body = <RuntimeStep companyId={company.id} onContinue={() => navigate("/cos", { replace: true })} />;
  } else if (status.nextStep === "model") {
    const provider = adapterQuery.data?.hermesProvider;
    body = !status.canConfigureModel ? (
      // #794: a company admin who is not the instance admin cannot set the key.
      <div className="mx-auto max-w-lg px-6 py-12 text-sm" data-testid="first-run-model-waiting">
        <h1 className="mb-2 text-lg font-semibold">Waiting for a model provider</h1>
        <p className="text-muted-foreground">
          Your agents need a model provider key before they can work, and only the instance administrator can add
          it. You can look around in the meantime.
        </p>
        <ProviderKeyBlocked companyId={company.id} homeHref={home} />
      </div>
    ) : provider ? (
      <HermesProviderStep
        companyId={company.id}
        options={provider.options}
        canConfigure={provider.canConfigure}
        onConfigured={() => {
          void queryClient.invalidateQueries({ queryKey: ["onboarding-adapter-status"] });
          void refresh();
          // AgentDash (first-session test, Lane A item 3): with a model key the
          // CoS can reply, so the founder goes straight to the conversation.
          // GitHub and the first issue stay reachable from Home's nudge.
          navigate("/cos", { replace: true });
        }}
      />
    ) : (
      <div role="status" className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
    );
  } else if (status.nextStep === "repo") {
    body = (
      <GitHubConnectStep
        companyId={company.id}
        connection={null}
        canManage={status.canManage}
        onConnected={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.githubConnections.list(company.id) });
          void queryClient.invalidateQueries({ queryKey: ["projects"] });
          void refresh();
        }}
      />
    );
  } else if (status.nextStep === "first_issue") {
    body = (
      <FirstIssueStep
        companyId={company.id}
        repo={status.repo.repo}
        suggestions={status.suggestions}
        onCreated={async () => {
          await refresh();
          void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(company.id) });
          navigate(home, { replace: true });
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-surface-page" data-testid="first-run">
      <StepIndicator
        current={showRuntime ? "model" : status.nextStep}
        showModel={status.model.required || showRuntime}
        modelLabel={showRuntime ? "Your runtime" : undefined}
      />
      {!showRuntime && (status.nextStep === 'repo' || status.nextStep === 'first_issue') && <div className="mx-auto mt-6 max-w-lg rounded-lg border p-4 text-sm"><p>Marketing and sales roles can start without a repository.</p><Link className="underline" to={`/${company.issuePrefix}/workforce`}>Set up a marketing or sales role</Link></div>}
      {body}
    </div>
  );
}
