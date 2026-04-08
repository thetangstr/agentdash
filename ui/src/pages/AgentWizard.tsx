// AgentDash: 5-step Natural Language Agent Wizard page
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useNavigate } from "@/lib/router";
import { wizardApi } from "../api/wizard";
import { connectorsApi } from "../api/connectors";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  AGENT_ROLES,
  AGENT_ROLE_LABELS,
  AGENT_TONES,
  CONNECTOR_PROVIDERS,
  CONNECTOR_PROVIDER_LABELS,
} from "@agentdash/shared";
import {
  Sparkles,
  User,
  Plug,
  Clock,
  Eye,
  Check,
} from "lucide-react";

type WizardStep = 1 | 2 | 3 | 4 | 5;
type Tone = (typeof AGENT_TONES)[number];

const STEPS: { label: string; icon: React.ReactNode }[] = [
  { label: "Purpose", icon: <Sparkles className="h-4 w-4" /> },
  { label: "Identity", icon: <User className="h-4 w-4" /> },
  { label: "Connectors", icon: <Plug className="h-4 w-4" /> },
  { label: "Schedule", icon: <Clock className="h-4 w-4" /> },
  { label: "Review", icon: <Eye className="h-4 w-4" /> },
];

const TONE_DESCRIPTIONS: Record<Tone, string> = {
  professional: "Clear, precise, formal communication",
  friendly: "Warm, approachable, conversational",
  direct: "Concise, to-the-point, no fluff",
};

const FREQUENCY_OPTIONS: { label: string; value: "every_30m" | "hourly" | "daily" }[] = [
  { label: "Every 30 minutes", value: "every_30m" },
  { label: "Hourly", value: "hourly" },
  { label: "Daily", value: "daily" },
];

// AgentDash: Agent Wizard page — 5-step guided agent creation flow
export function AgentWizard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  const [step, setStep] = useState<WizardStep>(1);

  // Step 1
  const [purpose, setPurpose] = useState("");

  // Step 2
  const [name, setName] = useState("");
  const [tone, setTone] = useState<Tone>("professional");
  const [role, setRole] = useState<string>("general");
  const [customRole, setCustomRole] = useState("");

  // Step 3
  const [selectedConnectors, setSelectedConnectors] = useState<string[]>([]);

  // Step 4
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [frequency, setFrequency] = useState<"every_30m" | "hourly" | "daily">("hourly");

  useEffect(() => {
    setBreadcrumbs([{ label: "New Agent" }]);
  }, [setBreadcrumbs]);

  const { data: connectors } = useQuery({
    queryKey: ["connectors", selectedCompanyId],
    queryFn: () => connectorsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && step === 3,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      wizardApi.create(selectedCompanyId!, {
        purpose,
        name,
        tone,
        role: role === "custom" ? "custom" : role,
        customRole: role === "custom" ? customRole : undefined,
        connectors: selectedConnectors.length > 0 ? selectedConnectors : undefined,
        schedule: scheduleEnabled
          ? { frequency }
          : undefined,
      }),
    onSuccess: (result) => {
      navigate(`/agents/${result.agent.id}`);
    },
  });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground p-6">Select a company first.</p>;
  }

  const canProceed = (): boolean => {
    if (step === 1) return purpose.trim().length > 0;
    if (step === 2) return name.trim().length > 0;
    return true;
  };

  const handleNext = () => {
    if (step < 5) setStep((s) => (s + 1) as WizardStep);
  };

  const handleBack = () => {
    if (step > 1) setStep((s) => (s - 1) as WizardStep);
  };

  const handleStepClick = (target: WizardStep) => {
    // Allow navigation to completed steps only
    if (target < step) setStep(target);
  };

  const toggleConnector = (provider: string) => {
    setSelectedConnectors((prev) =>
      prev.includes(provider)
        ? prev.filter((p) => p !== provider)
        : [...prev, provider],
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b flex items-center gap-3">
        <Sparkles className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">New Agent</h1>
      </div>

      {/* Stepper */}
      <div className="px-6 py-4 border-b">
        <div className="flex items-center gap-0">
          {STEPS.map((s, idx) => {
            const stepNum = (idx + 1) as WizardStep;
            const isActive = stepNum === step;
            const isCompleted = stepNum < step;
            const isClickable = isCompleted;
            return (
              <div key={idx} className="flex items-center flex-1 last:flex-none">
                <button
                  onClick={() => isClickable && handleStepClick(stepNum)}
                  disabled={!isClickable && !isActive}
                  className={cn(
                    "flex flex-col items-center gap-1 px-3 py-2 rounded-lg transition-colors min-w-[80px]",
                    isActive && "text-primary",
                    isCompleted && "text-primary cursor-pointer hover:bg-primary/5",
                    !isActive && !isCompleted && "text-muted-foreground",
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center justify-center h-8 w-8 rounded-full border-2 transition-colors",
                      isActive && "border-primary bg-primary text-primary-foreground",
                      isCompleted && "border-primary bg-primary/10 text-primary",
                      !isActive && !isCompleted && "border-muted-foreground/30 text-muted-foreground",
                    )}
                  >
                    {isCompleted ? <Check className="h-4 w-4" /> : s.icon}
                  </div>
                  <span className="text-xs font-medium">{s.label}</span>
                </button>
                {idx < STEPS.length - 1 && (
                  <div
                    className={cn(
                      "flex-1 h-0.5 mx-1",
                      stepNum < step ? "bg-primary" : "bg-muted-foreground/20",
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {step === 1 && (
          <div className="max-w-xl space-y-4">
            <div>
              <h2 className="text-base font-semibold">What should this agent do?</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Describe the agent's purpose in plain language. Be as specific as you like.
              </p>
            </div>
            <textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="e.g. Monitor our HubSpot pipeline daily, summarize deals at risk, and post a digest to Slack..."
              rows={5}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        )}

        {step === 2 && (
          <div className="max-w-xl space-y-6">
            <div>
              <h2 className="text-base font-semibold">Give your agent an identity</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Name your agent and choose how it communicates and what role it plays.
              </p>
            </div>

            {/* Name */}
            <div className="space-y-1">
              <label className="text-sm font-medium">Agent name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Pipeline Watchdog"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            {/* Tone */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Communication tone</label>
              <div className="grid grid-cols-3 gap-3">
                {AGENT_TONES.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTone(t)}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-lg border-2 p-3 text-left transition-colors",
                      tone === t
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40",
                    )}
                  >
                    <span className="text-sm font-medium capitalize">{t}</span>
                    <span className="text-xs text-muted-foreground">{TONE_DESCRIPTIONS[t]}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Role */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Role</label>
              <div className="grid grid-cols-4 gap-2">
                {([...AGENT_ROLES, "custom"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRole(r)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                      role === r
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    {r === "custom" ? "Custom" : AGENT_ROLE_LABELS[r]}
                  </button>
                ))}
              </div>
              {role === "custom" && (
                <input
                  type="text"
                  value={customRole}
                  onChange={(e) => setCustomRole(e.target.value)}
                  placeholder="Enter custom role..."
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 mt-2"
                />
              )}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="max-w-xl space-y-4">
            <div>
              <h2 className="text-base font-semibold">Connect data sources</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Choose which integrations this agent can access. You can change these later.
              </p>
            </div>
            <div className="space-y-2">
              {CONNECTOR_PROVIDERS.map((provider) => {
                const connected = connectors?.find((c) => c.provider === provider);
                const isSelected = selectedConnectors.includes(provider);
                return (
                  <label
                    key={provider}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                      isSelected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleConnector(provider)}
                      className="h-4 w-4 accent-primary"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{CONNECTOR_PROVIDER_LABELS[provider]}</span>
                    </div>
                    {connected && (
                      <span
                        className={cn(
                          "text-xs px-2 py-0.5 rounded-full font-medium",
                          connected.status === "connected"
                            ? "bg-green-100 text-green-700"
                            : connected.status === "error"
                              ? "bg-red-100 text-red-700"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {connected.status}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="max-w-xl space-y-4">
            <div>
              <h2 className="text-base font-semibold">Set a schedule</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Optionally run this agent on a recurring schedule.
              </p>
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              <span className="text-sm font-medium">Enable schedule</span>
            </label>
            {scheduleEnabled && (
              <div className="space-y-2 ml-7">
                <label className="text-sm font-medium">Frequency</label>
                <div className="flex flex-col gap-2">
                  {FREQUENCY_OPTIONS.map((opt) => (
                    <label key={opt.value} className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="radio"
                        name="frequency"
                        value={opt.value}
                        checked={frequency === opt.value}
                        onChange={() => setFrequency(opt.value)}
                        className="h-4 w-4 accent-primary"
                      />
                      <span className="text-sm">{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 5 && (
          <div className="max-w-xl space-y-6">
            <div>
              <h2 className="text-base font-semibold">Review & create</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Confirm your agent configuration before creating.
              </p>
            </div>

            <div className="rounded-lg border divide-y">
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-28 shrink-0">Purpose</span>
                <p className="text-sm">{purpose}</p>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-28 shrink-0">Name</span>
                <p className="text-sm">{name}</p>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-28 shrink-0">Tone</span>
                <p className="text-sm capitalize">{tone}</p>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-28 shrink-0">Role</span>
                <p className="text-sm">
                  {role === "custom"
                    ? customRole || "Custom"
                    : AGENT_ROLE_LABELS[role as keyof typeof AGENT_ROLE_LABELS] ?? role}
                </p>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-28 shrink-0">Connectors</span>
                <p className="text-sm">
                  {selectedConnectors.length > 0
                    ? selectedConnectors
                        .map((p) => CONNECTOR_PROVIDER_LABELS[p as keyof typeof CONNECTOR_PROVIDER_LABELS] ?? p)
                        .join(", ")
                    : "None"}
                </p>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-28 shrink-0">Schedule</span>
                <p className="text-sm">
                  {scheduleEnabled
                    ? FREQUENCY_OPTIONS.find((o) => o.value === frequency)?.label ?? frequency
                    : "Not scheduled"}
                </p>
              </div>
            </div>

            {createMutation.isError && (
              <p className="text-sm text-red-600">
                Failed to create agent. Please try again.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Navigation footer */}
      <div className="px-6 py-4 border-t flex items-center justify-between">
        <Button
          variant="outline"
          onClick={handleBack}
          disabled={step === 1}
        >
          Back
        </Button>

        {step < 5 ? (
          <Button onClick={handleNext} disabled={!canProceed()}>
            Next
          </Button>
        ) : (
          <Button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create Agent"}
          </Button>
        )}
      </div>
    </div>
  );
}
