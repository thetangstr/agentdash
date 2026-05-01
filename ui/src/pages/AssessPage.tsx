// AgentDash: Agent Readiness Assessment — top-of-page mode chooser
// (Entire company / Specific project) wrapping the existing CompanyWizard
// and the new ProjectWizard. Both wizards share the marketing surface chrome
// and the wizard chrome extracted into ./assess/wizard-chrome.tsx.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { assessApi, type ProjectAssessmentSummary } from "../api/assess";
import { MarketingShell } from "../marketing/MarketingShell";
import { SectionContainer } from "../marketing/components/SectionContainer";
import { Eyebrow } from "../marketing/components/Eyebrow";
import { CompanyWizard } from "./assess/CompanyWizard";
import { ProjectWizard } from "./assess/ProjectWizard";
import { ModeChooser, type AssessmentMode } from "./assess/ModeChooser";
import { ProjectStoredList } from "./assess/ProjectStoredCard";
import { AssessLocalStyles } from "./assess/wizard-chrome";

export function AssessPage() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const [mode, setMode] = useState<AssessmentMode | null>(null);

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
    return (
      <MarketingShell>
        <SectionContainer>
          <Eyebrow>Agent Readiness Assessment</Eyebrow>
          <h1 className="mkt-display-page" style={{ marginTop: 16, marginBottom: 16 }}>
            Select a company first.
          </h1>
          <p className="mkt-body-lg" style={{ color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            The assessment is scoped to a company. Pick or create one from the company switcher,
            then come back to run a readiness analysis.
          </p>
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
          <CompanyWizard
            companyId={companyId}
            defaultCompanyName={selectedCompany?.name}
            onSwitchMode={() => setMode(null)}
          />
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
