// AgentDash: Agent Readiness Assessment — top-of-page mode chooser
// (Entire company / Specific project) wrapping the existing CompanyWizard
// and the new ProjectWizard. Both wizards share the marketing surface chrome
// and the wizard chrome extracted into ./assess/wizard-chrome.tsx.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { assessApi, type ProjectAssessmentSummary } from "../api/assess";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { onboardingApi } from "../api/onboarding";
import { queryKeys } from "../lib/queryKeys";
import { MarketingShell } from "../marketing/MarketingShell";
import { SectionContainer } from "../marketing/components/SectionContainer";
import { Eyebrow } from "../marketing/components/Eyebrow";
import { Button } from "../marketing/components/Button";
import { CompanyWizard } from "./assess/CompanyWizard";
import { ProjectWizard } from "./assess/ProjectWizard";
import { ModeChooser, type AssessmentMode } from "./assess/ModeChooser";
import { ProjectStoredList } from "./assess/ProjectStoredCard";
import { AssessLocalStyles } from "./assess/wizard-chrome";

export function AssessPage() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // AgentDash (Phase F): `?onboarding=1` means the user just landed here
  // from /company-create as part of the post-signup chain. Skip the mode
  // chooser, jump straight into the company wizard, and on the deep-interview
  // ready marker call /api/onboarding/finalize-assessment to crystallize the
  // spec + flip the CoS phase, then redirect to /cos.
  const onboardingFlow = useMemo(
    () => searchParams.get("onboarding") === "1",
    [searchParams],
  );
  const [mode, setMode] = useState<AssessmentMode | null>(
    onboardingFlow ? "company" : null,
  );
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);

  // If the URL flips from a non-onboarding visit to `?onboarding=1` (rare,
  // but covers SPA history pushes from CompanyCreate), force company mode.
  useEffect(() => {
    if (onboardingFlow && mode !== "company") setMode("company");
  }, [onboardingFlow, mode]);

  const handleReadyToFinalize = async (info: { stateId: string; round: number; ambiguity: number }) => {
    if (finalizing) return;
    setFinalizing(true);
    setFinalizeError(null);
    try {
      const result = await onboardingApi.finalizeAssessment(info.stateId);
      navigate(result.redirectUrl, { replace: true });
    } catch (err) {
      setFinalizeError(
        err instanceof Error ? err.message : "Could not finalize the interview.",
      );
      setFinalizing(false);
    }
  };

  // Auth-state detection — mirror the Landing page pattern so anonymous
  // visitors hitting /assess directly get a sensible CTA instead of a
  // dead-end "Select a company first" wall.
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
  const loggedIn = !isAuthenticatedMode || Boolean(sessionQuery.data);

  // Load past project assessments so we can show them on the chooser.
  const projectsQuery = useQuery<ProjectAssessmentSummary[]>({
    queryKey: ["assess", "projects", companyId],
    queryFn: async () => {
      if (!companyId) return [];
      try {
        return await assessApi.listProjects(companyId);
      } catch {
        return [];
      }
    },
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });

  /* ---------------------------------------------------------------- */
  /*  No-company guard                                                  */
  /* ---------------------------------------------------------------- */
  if (!companyId) {
    // Wait for auth resolution before rendering — otherwise the page flickers
    // from "Try it free" to "Create your workspace" once the session loads.
    if (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading)) {
      return (
        <MarketingShell>
          <SectionContainer>
            <Eyebrow>Agent Readiness Assessment</Eyebrow>
          </SectionContainer>
        </MarketingShell>
      );
    }

    if (!loggedIn) {
      // Anonymous visitor — offer sign-up. Most likely path: someone hit
      // /assess from the marketing nav before they have an account.
      return (
        <MarketingShell>
          <SectionContainer>
            <Eyebrow>Agent Readiness Assessment</Eyebrow>
            <h1 className="mkt-display-page" style={{ marginTop: 16, marginBottom: 16 }}>
              Try it free.
            </h1>
            <p className="mkt-body-lg" style={{ color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
              The readiness assessment is scoped to a workspace. Sign up — the Free tier covers
              one workspace and one Chief of Staff agent, no credit card needed.
            </p>
            <div style={{ marginTop: 32, display: "flex", gap: 16, flexWrap: "wrap" }}>
              <Button href="/auth?mode=sign_up">Start free</Button>
              <Button href="/auth" variant="ghost">Sign in</Button>
            </div>
          </SectionContainer>
        </MarketingShell>
      );
    }

    // Logged in, but no company yet — push them through onboarding.
    return (
      <MarketingShell>
        <SectionContainer>
          <Eyebrow>Agent Readiness Assessment</Eyebrow>
          <h1 className="mkt-display-page" style={{ marginTop: 16, marginBottom: 16 }}>
            Create your workspace first.
          </h1>
          <p className="mkt-body-lg" style={{ color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            The assessment is scoped to a workspace. Set yours up — it takes about 30 seconds —
            and the Chief of Staff will walk you back here.
          </p>
          <div style={{ marginTop: 32, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Button href="/onboarding">Create your workspace</Button>
          </div>
        </SectionContainer>
      </MarketingShell>
    );
  }

  const projects = projectsQuery.data ?? [];
  const companyName = selectedCompany?.name ?? "your company";

  return (
    <MarketingShell>
      <SectionContainer>
        <Eyebrow>Agent Readiness Assessment</Eyebrow>
        <h1 className="mkt-display-page" style={{ marginTop: 16, marginBottom: 16, maxWidth: "20ch" }}>
          {mode === "project"
            ? `Assess a specific project for ${companyName}.`
            : mode === "company"
              ? `Where does ${companyName} sit on the readiness curve?`
              : `How would you like to assess ${companyName}?`}
        </h1>
        <p className="mkt-body-lg" style={{ color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
          {mode === "project"
            ? "Tell us about the project, answer a few adaptive clarifying questions, and we'll draft a project-specific agent recommendation you can download as a Word doc."
            : "Two ways in: a four-step company-wide readiness scan, or a project-scoped assessment that produces a downloadable Word doc."}
        </p>

        {mode === null && (
          <>
            <ModeChooser onPick={(m) => setMode(m)} />
            {projects.length > 0 && (
              <ProjectStoredList
                companyId={companyId}
                companyName={companyName}
                projects={projects}
                onRunNew={() => setMode("project")}
              />
            )}
          </>
        )}

        {mode === "company" && (
          <>
            {onboardingFlow && finalizing && (
              <div
                role="status"
                aria-live="polite"
                style={{ marginTop: 16, color: "var(--mkt-ink-soft)" }}
              >
                Finalizing your interview and handing off to your Chief of Staff…
              </div>
            )}
            {finalizeError && (
              <div
                role="alert"
                style={{ marginTop: 16, color: "var(--mkt-error, #b91c1c)" }}
              >
                {finalizeError}
              </div>
            )}
            <CompanyWizard
              companyId={companyId}
              defaultCompanyName={selectedCompany?.name}
              // In the onboarding chain, the chooser is the entry point —
              // hide the "switch mode" affordance so users don't bail out
              // before crystallization.
              onSwitchMode={onboardingFlow ? undefined : () => setMode(null)}
              onReadyToFinalize={onboardingFlow ? handleReadyToFinalize : undefined}
            />
          </>
        )}

        {mode === "project" && (
          <ProjectWizard
            companyId={companyId}
            companyName={companyName}
            onSwitchMode={() => setMode(null)}
            onCompleted={() => projectsQuery.refetch()}
          />
        )}
      </SectionContainer>

      <AssessLocalStyles />
    </MarketingShell>
  );
}
