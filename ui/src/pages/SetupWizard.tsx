"use client";
import { useState } from "react";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { api } from "../api/client";
import { assessApi } from "../api/assess";

const STEPS = [
  { key: "about", label: "About Your Business" },
  { key: "team", label: "Your Team" },
  { key: "live", label: "You're Live" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

interface StarterAgent {
  name: string;
  role: string;
  description: string;
}

type Scope = "company" | "department" | "team" | "project";

const SCOPE_OPTIONS: { value: Scope; label: string; desc: string }[] = [
  { value: "company", label: "Entire Company", desc: "AI agents manage cross-functional work across the organization" },
  { value: "department", label: "Department", desc: "Agents own one domain and interface with human teams" },
  { value: "team", label: "Team", desc: "Agents augment a human team collaboratively" },
  { value: "project", label: "Project", desc: "Time-boxed, goal-specific agent deployment" },
];

const AGENTS_BY_SCOPE: Record<Scope, StarterAgent[]> = {
  company: [
    { name: "Chief of Staff", role: "chief_of_staff", description: "Interviews stakeholders, decomposes goals, and proposes the agent team that'll execute them." },
    { name: "Sales Agent", role: "cmo", description: "Manages pipeline, drafts outreach, and closes deals." },
    { name: "Engineering Agent", role: "engineer", description: "Scopes tasks, writes code, and ships features." },
  ],
  department: [
    { name: "Department Lead", role: "pm", description: "Owns the department roadmap, coordinates with leadership." },
    { name: "Analyst", role: "researcher", description: "Researches trends, analyzes data, and generates reports." },
    { name: "Specialist", role: "engineer", description: "Executes domain-specific work and maintains standards." },
  ],
  team: [
    { name: "Team Lead", role: "pm", description: "Coordinates sprint work, unblocks teammates, and tracks velocity." },
    { name: "Developer", role: "engineer", description: "Implements features, reviews code, and maintains the codebase." },
  ],
  project: [
    { name: "Project Manager", role: "pm", description: "Plans milestones, tracks deliverables, and manages timeline." },
    { name: "Project Developer", role: "engineer", description: "Builds features toward the project goal, writes tests." },
  ],
};

const CHECKLIST_KEYS = ["company", "team", "apiKey", "hubspot", "issue"] as const;
type ChecklistKey = (typeof CHECKLIST_KEYS)[number];

interface ChecklistState {
  company: boolean;
  team: boolean;
  apiKey: boolean;
  hubspot: boolean;
  issue: boolean;
}

export function SetupWizard() {
  const { selectedCompany } = useCompany();
  const navigate = useNavigate();

  const companyId = selectedCompany?.id ?? "";
  const companyPrefix = selectedCompany?.issuePrefix ?? "";
  const companyName = selectedCompany?.name ?? "Your Company";

  const [stepIndex, setStepIndex] = useState(0);
  const [researching, setResearching] = useState(false);
  const [formData, setFormData] = useState({ companyInfo: "", mainGoal: "", scope: "company" as Scope });
  const agents = AGENTS_BY_SCOPE[formData.scope];
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(
    new Set(agents.map((a) => a.name)),
  );

  function handleScopeChange(scope: Scope) {
    setFormData((prev) => ({ ...prev, scope }));
    setSelectedAgents(new Set(AGENTS_BY_SCOPE[scope].map((a) => a.name)));
  }
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<ChecklistState>({
    company: true,
    team: false,
    apiKey: false,
    hubspot: false,
    issue: false,
  });

  if (!companyId) {
    return <div className="p-6 text-muted-foreground">Loading company...</div>;
  }

  const step: StepKey = STEPS[stepIndex].key;

  function toggleAgent(name: string) {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleDeploy() {
    setDeploying(true);
    setDeployError(null);
    try {
      const session = await api.post<{ id: string }>(
        `/companies/${companyId}/onboarding/sessions`,
        {},
      );

      const scopeLabel = SCOPE_OPTIONS.find((o) => o.value === formData.scope)?.label ?? formData.scope;
      const sourceContent = [
        `Operating mode: ${scopeLabel}`,
        formData.companyInfo && `Company: ${formData.companyInfo}`,
        formData.mainGoal && `Goal: ${formData.mainGoal}`,
        `Agents: ${[...selectedAgents].join(", ")}`,
      ]
        .filter(Boolean)
        .join("\n");

      await api.post(`/companies/${companyId}/onboarding/sessions/${session.id}/sources`, {
        sourceType: "text",
        sourceLocator: "setup-wizard",
        rawContent: sourceContent,
      });

      await api.post(`/companies/${companyId}/onboarding/sessions/${session.id}/extract`, {});
      await api.post(`/companies/${companyId}/onboarding/sessions/${session.id}/generate-plan`, {});
      await api.post(`/companies/${companyId}/onboarding/sessions/${session.id}/apply-plan`, {});
      await api.post(`/companies/${companyId}/onboarding/sessions/${session.id}/complete`, {});

      const newChecklist: ChecklistState = { ...checklist, team: true };
      setChecklist(newChecklist);
      saveChecklist(newChecklist);
      setStepIndex(2);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setDeploying(false);
    }
  }

  function saveChecklist(state: ChecklistState) {
    localStorage.setItem(
      `agentdash.onboarding.${companyId}`,
      JSON.stringify(state),
    );
  }

  function toggleChecklistItem(key: ChecklistKey) {
    const updated = { ...checklist, [key]: !checklist[key] };
    setChecklist(updated);
    saveChecklist(updated);
  }

  const checklistItems: { key: ChecklistKey; label: string }[] = [
    { key: "company", label: "Company created" },
    { key: "team", label: "Agent team deployed" },
    { key: "apiKey", label: "Add your AI API key" },
    { key: "hubspot", label: "Connect HubSpot" },
    { key: "issue", label: "Create first issue" },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl space-y-8">
        {/* Progress bar */}
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            {STEPS.map((s, i) => (
              <div key={s.key} className="flex-1">
                <div
                  className={`h-1.5 rounded-full transition-colors ${i <= stepIndex ? "bg-primary" : "bg-muted"}`}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground text-center">
            Step {stepIndex + 1} of {STEPS.length} — {STEPS[stepIndex].label}
          </p>
        </div>

        {/* Step: About Your Business */}
        {step === "about" && (
          <div className="space-y-6">
            <div className="text-center space-y-1">
              <h1 className="text-2xl font-bold">About Your Business</h1>
              <p className="text-sm text-muted-foreground">
                Help your AI team understand your company and goals.
              </p>
            </div>
            <div className="rounded-xl border bg-card p-6 space-y-5">
              <div className="space-y-2">
                <label className="block text-sm font-medium">How will AI agents operate?</label>
                <div className="space-y-2">
                  {SCOPE_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${formData.scope === opt.value ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                    >
                      <input
                        type="radio"
                        name="scope"
                        value={opt.value}
                        checked={formData.scope === opt.value}
                        onChange={() => handleScopeChange(opt.value)}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="text-sm font-medium">{opt.label}</div>
                        <div className="text-xs text-muted-foreground">{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium">Tell us about your company</label>
                <textarea
                  className="w-full rounded-lg border bg-background p-3 text-sm min-h-[100px] focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Paste a description, your website URL, or a few sentences about what you do..."
                  value={formData.companyInfo}
                  onChange={(e) => setFormData({ ...formData, companyInfo: e.target.value })}
                />
                <button
                  type="button"
                  className="text-sm text-accent hover:underline disabled:opacity-50"
                  onClick={async () => {
                    if (!formData.companyInfo) return;
                    setResearching(true);
                    try {
                      const result = await assessApi.research(companyId, formData.companyInfo, companyName);
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
              <div className="space-y-2">
                <label className="block text-sm font-medium">What's your main goal?</label>
                <input
                  className="w-full rounded-lg border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="e.g., Close 100 deals by Q3"
                  value={formData.mainGoal}
                  onChange={(e) => setFormData({ ...formData, mainGoal: e.target.value })}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setStepIndex(1)}
                className="px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step: Your Team */}
        {step === "team" && (
          <div className="space-y-6">
            <div className="text-center space-y-1">
              <h1 className="text-2xl font-bold">Your Team</h1>
              <p className="text-sm text-muted-foreground">
                Choose the agents to deploy for your company.
              </p>
            </div>
            <div className="rounded-xl border bg-card p-6 space-y-3">
              {agents.map((agent) => {
                const selected = selectedAgents.has(agent.name);
                return (
                  <label
                    key={agent.name}
                    className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors ${selected ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleAgent(agent.name)}
                      className="mt-0.5 accent-primary"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{agent.name}</span>
                        <span className="text-xs text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                          {agent.role}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{agent.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>

            {deployError && (
              <p className="text-sm text-destructive text-center">{deployError}</p>
            )}

            <div className="flex justify-between">
              <button
                onClick={() => setStepIndex(0)}
                disabled={deploying}
                className="px-4 py-2 rounded-lg border text-sm font-medium disabled:opacity-30 hover:bg-muted"
              >
                Back
              </button>
              <button
                onClick={handleDeploy}
                disabled={deploying || selectedAgents.size === 0}
                className="px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50"
              >
                {deploying ? "Deploying..." : "Deploy Team"}
              </button>
            </div>
          </div>
        )}

        {/* Step: You're Live */}
        {step === "live" && (
          <div className="space-y-6 text-center">
            <div className="space-y-2">
              <div className="text-5xl">🎉</div>
              <h1 className="text-2xl font-bold">{companyName} is live</h1>
              <p className="text-sm text-muted-foreground">
                Your AI team is ready. Here's what to do next.
              </p>
            </div>

            <div className="rounded-xl border bg-card p-6 text-left space-y-3">
              {checklistItems.map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center gap-3 cursor-pointer group"
                >
                  <span className={`text-lg ${checklist[key] ? "text-primary" : "text-muted-foreground"}`}>
                    {checklist[key] ? "✅" : "⬜"}
                  </span>
                  <span
                    className={`text-sm ${checklist[key] ? "line-through text-muted-foreground" : ""}`}
                    onClick={() => toggleChecklistItem(key)}
                  >
                    {label}
                  </span>
                </label>
              ))}
            </div>

            <button
              onClick={() => navigate(`/${companyPrefix}/dashboard`)}
              className="px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90"
            >
              Open Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
