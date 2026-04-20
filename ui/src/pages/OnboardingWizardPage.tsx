"use client";
import { useState } from "react";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { api } from "../api/client";
import { assessApi } from "../api/assess";

const STEPS = [
  { key: "discovery", label: "Discovery", description: "Tell us about your company" },
  { key: "scope", label: "Scope", description: "What will the AI team manage?" },
  { key: "goals", label: "Goals", description: "Define your objectives" },
  { key: "access", label: "Access", description: "Set up oversight" },
  { key: "bootstrap", label: "Bootstrap", description: "Deploy your team" },
] as const;

export function OnboardingWizardPage() {
  const { selectedCompany } = useCompany();
  const navigate = useNavigate();
  const companyId = selectedCompany?.id;
  const companyPrefix = selectedCompany?.issuePrefix ?? "";
  const [stepIndex, setStepIndex] = useState(0);
  const [deploying, setDeploying] = useState(false);
  const [researching, setResearching] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    companyInfo: "",
    scope: "company",
    companyGoal: "",
    teamGoals: ["", ""],
    overseerName: "",
    overseerEmail: "",
  });
  if (!companyId) return <div className="p-6 text-muted-foreground">Select a company</div>;

  const step = STEPS[stepIndex];

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      {/* Progress */}
      <div className="flex items-center gap-1">
        {STEPS.map((s, i) => (
          <div key={s.key} className="flex-1 flex items-center gap-1">
            <div className={`h-2 flex-1 rounded-full ${i <= stepIndex ? "bg-primary" : "bg-muted"}`} />
          </div>
        ))}
      </div>
      <div className="text-center">
        <p className="text-xs text-muted-foreground">Step {stepIndex + 1} of {STEPS.length}</p>
        <h1 className="text-2xl font-bold mt-1">{step.label}</h1>
        <p className="text-sm text-muted-foreground">{step.description}</p>
      </div>

      {/* Step Content */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        {step.key === "discovery" && (
          <>
            <label className="block text-sm font-medium">Company Information</label>
            <textarea
              className="w-full rounded-lg border bg-background p-3 text-sm min-h-[120px] focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Paste your company description, mission statement, or any context about your business..."
              value={formData.companyInfo}
              onChange={(e) => setFormData({ ...formData, companyInfo: e.target.value })}
            />
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">Or provide a URL to your docs/wiki and we'll analyze it automatically.</p>
              <button
                type="button"
                className="text-sm text-accent hover:underline disabled:opacity-50 whitespace-nowrap"
                onClick={async () => {
                  if (!formData.companyInfo) return;
                  setResearching(true);
                  try {
                    const result = await assessApi.research(companyId, formData.companyInfo, selectedCompany?.name ?? "");
                    setFormData((prev) => ({
                      ...prev,
                      companyInfo: [
                        prev.companyInfo,
                        result.summary ? `\nSummary: ${result.summary}` : "",
                        result.suggestedIndustry ? `\nIndustry: ${result.suggestedIndustry}` : "",
                      ].join(""),
                    }));
                  } catch { /* ignore errors */ }
                  setResearching(false);
                }}
                disabled={researching || !formData.companyInfo?.startsWith("http")}
              >
                {researching ? "Researching..." : "Research this URL"}
              </button>
            </div>
          </>
        )}

        {step.key === "scope" && (
          <>
            <label className="block text-sm font-medium">Operating Mode</label>
            <div className="space-y-2">
              {[
                { value: "company", label: "Entire Company", desc: "AI agents manage cross-functional work" },
                { value: "department", label: "Department", desc: "Agents own one domain, interface with human teams" },
                { value: "team", label: "Team", desc: "Agents augment a human team collaboratively" },
                { value: "project", label: "Project", desc: "Time-boxed, goal-specific agent deployment" },
              ].map((opt) => (
                <label key={opt.value} className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${formData.scope === opt.value ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
                  <input type="radio" name="scope" value={opt.value} checked={formData.scope === opt.value} onChange={() => setFormData({ ...formData, scope: opt.value })} className="mt-0.5" />
                  <div>
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="text-xs text-muted-foreground">{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </>
        )}

        {step.key === "goals" && (
          <>
            <label className="block text-sm font-medium">Company Goal</label>
            <input
              className="w-full rounded-lg border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="e.g., Launch v2.0 by Q3 2026"
              value={formData.companyGoal}
              onChange={(e) => setFormData({ ...formData, companyGoal: e.target.value })}
            />
            <label className="block text-sm font-medium mt-4">Team Goals</label>
            {formData.teamGoals.map((g, i) => (
              <input
                key={i}
                className="w-full rounded-lg border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={`Team goal ${i + 1}`}
                value={g}
                onChange={(e) => {
                  const goals = [...formData.teamGoals];
                  goals[i] = e.target.value;
                  setFormData({ ...formData, teamGoals: goals });
                }}
              />
            ))}
          </>
        )}

        {step.key === "access" && (
          <>
            <label className="block text-sm font-medium">Primary Overseer</label>
            <input
              className="w-full rounded-lg border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Name"
              value={formData.overseerName}
              onChange={(e) => setFormData({ ...formData, overseerName: e.target.value })}
            />
            <input
              className="w-full rounded-lg border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Email"
              value={formData.overseerEmail}
              onChange={(e) => setFormData({ ...formData, overseerEmail: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">This person will review agent work, approve spawn requests, and manage budgets.</p>
          </>
        )}

        {step.key === "bootstrap" && (
          <div className="text-center space-y-4">
            <div className="text-4xl">🚀</div>
            <h3 className="font-semibold">Ready to deploy your agent team</h3>
            <p className="text-sm text-muted-foreground">
              Based on your goals, we'll suggest an initial team of agents from your templates.
              You can customize and add more agents later.
            </p>
            {deployError && (
              <p className="text-sm text-destructive">{deployError}</p>
            )}
            <button
              disabled={deploying}
              onClick={async () => {
                setDeploying(true);
                setDeployError(null);
                try {
                  // 1. Create onboarding session
                  const session = await api.post<{ id: string }>(
                    `/companies/${companyId}/onboarding/sessions`,
                    {},
                  );
                  // 2. Ingest wizard form data as a source
                  const sourceContent = [
                    formData.companyInfo && `Company: ${formData.companyInfo}`,
                    `Scope: ${formData.scope}`,
                    formData.companyGoal && `Goal: ${formData.companyGoal}`,
                    ...formData.teamGoals.filter(Boolean).map((g) => `Team goal: ${g}`),
                    formData.overseerName && `Overseer: ${formData.overseerName} (${formData.overseerEmail})`,
                  ].filter(Boolean).join("\n");

                  await api.post(
                    `/companies/${companyId}/onboarding/sessions/${session.id}/sources`,
                    { sourceType: "text", sourceLocator: "onboarding-wizard", rawContent: sourceContent },
                  );
                  // 3. Extract context from sources
                  await api.post(
                    `/companies/${companyId}/onboarding/sessions/${session.id}/extract`,
                    {},
                  );
                  // 4. Generate plan (LLM-powered or fallback)
                  await api.post(
                    `/companies/${companyId}/onboarding/sessions/${session.id}/generate-plan`,
                    {},
                  );
                  // 5. Apply the plan (creates departments, goals, templates, agents, projects)
                  await api.post(
                    `/companies/${companyId}/onboarding/sessions/${session.id}/apply-plan`,
                    {},
                  );
                  // 6. Complete the session
                  await api.post(
                    `/companies/${companyId}/onboarding/sessions/${session.id}/complete`,
                    {},
                  );
                  // 7. Navigate to dashboard
                  navigate(`/${companyPrefix}/dashboard`);
                } catch (err) {
                  setDeployError(err instanceof Error ? err.message : "Deploy failed");
                } finally {
                  setDeploying(false);
                }
              }}
              className="px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50"
            >
              {deploying ? "Deploying..." : "Deploy Team"}
            </button>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex justify-between">
        <button
          onClick={() => setStepIndex(Math.max(0, stepIndex - 1))}
          disabled={stepIndex === 0}
          className="px-4 py-2 rounded-lg border text-sm font-medium disabled:opacity-30 hover:bg-muted"
        >
          Back
        </button>
        {stepIndex < STEPS.length - 1 && (
          <button
            onClick={() => setStepIndex(Math.min(STEPS.length - 1, stepIndex + 1))}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
