import { WorkforceRoleSelect, WorkforceTemplatePreview } from "@/components/WorkforceTemplatePreview";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { healthApi } from "../api/health";
import { WIZARD_DEFAULT_ADAPTER_TYPE, adapterTypeForInstancePreset } from "../lib/onboarding-defaults";
import { companySkillsApi } from "../api/companySkills";
import { queryKeys } from "../lib/queryKeys";
import { AGENT_ROLES, isBlockingPreflightResult, type AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Shield } from "lucide-react";
import { cn, agentUrl } from "../lib/utils";
import { roleLabels } from "../components/agent-config-primitives";
import {
  AgentConfigForm,
  AdapterEnvironmentResult,
  type CreateConfigValues,
} from "../components/AgentConfigForm";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { getUIAdapter, listUIAdapters } from "../adapters";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { isValidAdapterType } from "../adapters/metadata";
import { ReportsToPicker } from "../components/ReportsToPicker";
import { buildNewAgentHirePayload } from "../lib/new-agent-hire-payload";
import {
  buildAgentHarnessPreflightKey,
  getAgentCreateHarnessPreflightGate,
} from "../lib/agent-harness-preflight";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";

function createValuesForAdapterType(
  adapterType: CreateConfigValues["adapterType"],
): CreateConfigValues {
  const { adapterType: _discard, ...defaults } = defaultCreateValues;
  const nextValues: CreateConfigValues = { ...defaults, adapterType };
  if (adapterType === "codex_local") {
    nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
    nextValues.dangerouslyBypassSandbox =
      DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  } else if (adapterType === "gemini_local") {
    nextValues.model = DEFAULT_GEMINI_LOCAL_MODEL;
  } else if (adapterType === "cursor") {
    nextValues.model = DEFAULT_CURSOR_LOCAL_MODEL;
  } else if (adapterType === "opencode_local") {
    nextValues.model = "";
  }
  return nextValues;
}

export function NewAgent() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [workforceTemplateId, setWorkforceTemplateId] = useState(searchParams.get("workforceTemplateId") ?? "");
  useEffect(() => { setWorkforceTemplateId(searchParams.get("workforceTemplateId") ?? ""); }, [selectedCompanyId]);
  const presetAdapterType = searchParams.get("adapterType");

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("general");
  const [reportsTo, setReportsTo] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState("");
  // AgentDash (Scan 3, lane J): the runtime starts on the instance default
  // (health `adapterPreset`), not Claude Code. Until health answers, the
  // cached answer or the wizard default stands in; once the person picks a
  // runtime under Advanced, the instance default no longer overrides it.
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  // Only a runtime the instance reports as ready; otherwise the wizard default.
  const instanceAdapterType = health?.adapterReady
    ? adapterTypeForInstancePreset(health.adapterPreset)
    : WIZARD_DEFAULT_ADAPTER_TYPE;
  const [adapterTouched, setAdapterTouched] = useState(false);
  const [configValues, setConfigValues] = useState<CreateConfigValues>(() =>
    createValuesForAdapterType(instanceAdapterType as CreateConfigValues["adapterType"]),
  );
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  const [roleOpen, setRoleOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testAgentAction, setTestAgentAction] = useState<(() => void) | null>(null);
  const [testAgentState, setTestAgentState] = useState({ disabled: true, pending: false });
  const [testAgentFeedback, setTestAgentFeedback] = useState<{
    errorMessage: string | null;
    result: AdapterEnvironmentTestResult | null;
  }>({
    errorMessage: null,
    result: null,
  });
  const [passedHarnessPreflightKey, setPassedHarnessPreflightKey] = useState<string | null>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const {
    data: adapterModels,
    error: adapterModelsError,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching,
  } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.adapterModels(selectedCompanyId, configValues.adapterType)
      : ["agents", "none", "adapter-models", configValues.adapterType],
    queryFn: () => agentsApi.adapterModels(selectedCompanyId!, configValues.adapterType),
    enabled: Boolean(selectedCompanyId),
  });

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  // `agents === undefined` is "still loading", not "no agents" — treating the
  // unloaded state as first-agent prefilled CEO details into companies that
  // already have a team.
  const isFirstAgent = agents !== undefined && agents.length === 0;
  const effectiveRole = isFirstAgent ? "ceo" : role;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Team", href: "/agents" },
      { label: "New Agent" },
    ]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (presetAdapterType || adapterTouched) return;
    if (!isValidAdapterType(instanceAdapterType)) return;
    setConfigValues((prev) => {
      if (prev.adapterType === instanceAdapterType) return prev;
      return createValuesForAdapterType(instanceAdapterType as CreateConfigValues["adapterType"]);
    });
  }, [instanceAdapterType, presetAdapterType, adapterTouched]);

  useEffect(() => {
    const requested = presetAdapterType;
    if (!requested) return;
    if (!isValidAdapterType(requested)) return;
    setConfigValues((prev) => {
      if (prev.adapterType === requested) return prev;
      return createValuesForAdapterType(requested as CreateConfigValues["adapterType"]);
    });
  }, [presetAdapterType]);

  const createAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      agentsApi.hire(selectedCompanyId!, data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(agentUrl(result.agent));
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to create agent");
    },
  });

  const builtAdapterConfig = useMemo(() => {
    const adapter = getUIAdapter(configValues.adapterType);
    return adapter.buildAdapterConfig(configValues);
  }, [configValues]);

  function buildAdapterConfig() {
    return builtAdapterConfig;
  }

  const currentHarnessPreflightKey = useMemo(
    () => buildAgentHarnessPreflightKey({
      adapterType: configValues.adapterType,
      defaultEnvironmentId: configValues.defaultEnvironmentId ?? null,
      adapterConfig: builtAdapterConfig,
    }),
    [builtAdapterConfig, configValues.adapterType, configValues.defaultEnvironmentId],
  );

  const harnessPreflightGate = getAgentCreateHarnessPreflightGate({
    currentConfigKey: currentHarnessPreflightKey,
    passedConfigKey: passedHarnessPreflightKey,
    pending: testAgentState.pending,
    result: testAgentFeedback.result,
    errorMessage: testAgentFeedback.errorMessage,
  });

  function handleSubmit() {
    if (!selectedCompanyId || !name.trim()) return;
    setFormError(null);
    if (!harnessPreflightGate.canCreate) {
      setFormError(harnessPreflightGate.message ?? "Run Test Agent before creating this agent.");
      return;
    }
    if (configValues.adapterType === "opencode_local") {
      const selectedModel = configValues.model.trim();
      if (!selectedModel) {
        setFormError("OpenCode requires an explicit model in provider/model format.");
        return;
      }
      if (adapterModelsError) {
        setFormError(
          adapterModelsError instanceof Error
            ? adapterModelsError.message
            : "Failed to load OpenCode models.",
        );
        return;
      }
      if (adapterModelsLoading || adapterModelsFetching) {
        setFormError("OpenCode models are still loading. Please wait and try again.");
        return;
      }
      const discovered = adapterModels ?? [];
      if (!discovered.some((entry) => entry.id === selectedModel)) {
        setFormError(
          discovered.length === 0
            ? "No OpenCode models discovered. Run `opencode models` and authenticate providers."
            : `Configured OpenCode model is unavailable: ${selectedModel}`,
        );
        return;
      }
    }
    createAgent.mutate(
      buildNewAgentHirePayload({
        name,
        workforceTemplateId: workforceTemplateId || undefined,
        effectiveRole,
        title,
        capabilities,
        reportsTo,
        selectedSkillKeys,
        configValues,
        adapterConfig: buildAdapterConfig(),
        requireHarnessPreflight: true,
      }),
    );
  }

  const availableSkills = (companySkills ?? []).filter((skill) => !skill.key.startsWith("paperclipai/paperclip/"));

  function toggleSkill(key: string, checked: boolean) {
    setSelectedSkillKeys((prev) => {
      if (checked) {
        return prev.includes(key) ? prev : [...prev, key];
      }
      return prev.filter((value) => value !== key);
    });
  }

  const handleTestAgentActionChange = useCallback((fn: (() => void) | null) => {
    setTestAgentAction(() => fn);
  }, []);

  const handleTestAgentStateChange = useCallback((state: { disabled: boolean; pending: boolean }) => {
    setTestAgentState(state);
  }, []);

  const handleTestAgentFeedbackChange = useCallback((feedback: {
    errorMessage: string | null;
    result: AdapterEnvironmentTestResult | null;
  }) => {
    setTestAgentFeedback(feedback);
    // A warned check is an advisory pass unless it carries a blocking code —
    // the same shared rule the create gate and the server apply.
    if (feedback.result && !isBlockingPreflightResult(feedback.result)) {
      setPassedHarnessPreflightKey(currentHarnessPreflightKey);
    }
  }, [currentHarnessPreflightKey]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Hire a new agent</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Give it a role, a name and what it should do. Prefer to just describe
          the job?{" "}
          <Link to="/cos" className="underline">
            Ask your Chief of Staff
          </Link>{" "}
          — it will put together a hire proposal for you to confirm.
        </p>
      </div>

      <div className="bg-muted/50 border border-border rounded-lg p-3 text-sm text-muted-foreground">
        Press <em>Test Agent</em> to check it can run, then <em>Create agent</em>.
        How it runs is under <em>Advanced</em>; the defaults work for most teams.
      </div>

      <WorkforceRoleSelect value={workforceTemplateId} onChange={setWorkforceTemplateId}/>
      <WorkforceTemplatePreview templateId={workforceTemplateId}/>
      <div className="border border-border">
        {/* Name */}
        <div className="px-4 pt-4 pb-2">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Agent name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        {/* Title */}
        <div className="px-4 pb-2">
          <input
            className="w-full bg-transparent outline-none text-sm text-muted-foreground placeholder:text-muted-foreground/40"
            placeholder="Title (e.g. VP of Engineering)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* What it should do */}
        <div className="px-4 pb-3">
          <label className="block text-xs text-muted-foreground mb-1" htmlFor="new-agent-capabilities">
            What it should do
          </label>
          <textarea
            id="new-agent-capabilities"
            data-testid="new-agent-capabilities"
            className="w-full min-h-[64px] resize-y rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
            placeholder="e.g. Answer customer emails and flag anything urgent to me"
            value={capabilities}
            onChange={(e) => setCapabilities(e.target.value)}
          />
        </div>

        {/* Property chips: Role + Reports To */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          <Popover open={roleOpen} onOpenChange={setRoleOpen}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
                  isFirstAgent && "opacity-60 cursor-not-allowed"
                )}
                disabled={isFirstAgent}
              >
                <Shield className="h-3 w-3 text-muted-foreground" />
                {roleLabels[effectiveRole] ?? effectiveRole}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {AGENT_ROLES.map((r) => (
                <button
                  key={r}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    r === role && "bg-accent"
                  )}
                  onClick={() => { setRole(r); setRoleOpen(false); }}
                >
                  {roleLabels[r] ?? r}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <ReportsToPicker
            agents={agents ?? []}
            value={reportsTo}
            onChange={setReportsTo}
            disabled={isFirstAgent}
          />
        </div>

        {/* AgentDash (Scan 3, lane J): the technical settings (runtime,
            permissions, environment variables, extra arguments, skills) sit
            in a collapsed Advanced section. <details> keeps the form mounted
            while closed, so Test Agent still works without opening it. */}
        <details className="group border-t border-border" data-testid="new-agent-advanced">
          <summary className="flex min-h-11 cursor-pointer select-none items-center px-4 text-sm font-medium text-muted-foreground hover:text-foreground">
            Advanced
            <span className="ml-2 text-xs font-normal">How it runs, permissions and skills</span>
          </summary>
        {/* Shared config form */}
        <AgentConfigForm
          mode="create"
          values={configValues}
          onChange={(patch) => {
            if (patch.adapterType !== undefined) setAdapterTouched(true);
            setConfigValues((prev) => ({ ...prev, ...patch }));
          }}
          adapterModels={adapterModels}
          onTestActionChange={handleTestAgentActionChange}
          onTestActionStateChange={handleTestAgentStateChange}
          onTestFeedbackChange={handleTestAgentFeedbackChange}
        />

        <div className="border-t border-border px-4 py-4">
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">Company skills</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Optional skills from the company library. Built-in Paperclip runtime skills are added automatically.
              </p>
            </div>
            {availableSkills.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No optional company skills installed yet.
              </p>
            ) : (
              <div className="space-y-3">
                {availableSkills.map((skill) => {
                  const inputId = `skill-${skill.id}`;
                  const checked = selectedSkillKeys.includes(skill.key);
                  return (
                    <div key={skill.id} className="flex items-start gap-3">
                      <Checkbox
                        id={inputId}
                        checked={checked}
                        onCheckedChange={(next) => toggleSkill(skill.key, next === true)}
                      />
                      <label htmlFor={inputId} className="grid gap-1 leading-none max-sm:min-h-11 max-sm:content-center">
                        <span className="text-sm font-medium">{skill.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {skill.description ?? skill.key}
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        </details>

        {/* Footer */}
        <div className="border-t border-border px-4 py-3">
          {isFirstAgent && (
            <p className="text-xs text-muted-foreground mb-2">This will be the CEO</p>
          )}
          {formError && (
            <p className="text-xs text-destructive mb-2">{formError}</p>
          )}
          <div className="space-y-3">
            {testAgentFeedback.errorMessage && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {testAgentFeedback.errorMessage}
              </div>
            )}
            {testAgentFeedback.result && (
              <AdapterEnvironmentResult result={testAgentFeedback.result} />
            )}
            {!harnessPreflightGate.canCreate && (
              <p className="text-xs text-muted-foreground">
                {harnessPreflightGate.message}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate("/agents")}>
                Cancel
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={testAgentState.disabled}
                  onClick={() => testAgentAction?.()}
                >
                  {testAgentState.pending ? "Testing..." : "Test Agent"}
                </Button>
                <Button
                  size="sm"
                  disabled={!name.trim() || createAgent.isPending || !harnessPreflightGate.canCreate}
                  onClick={handleSubmit}
                >
                  {createAgent.isPending ? "Creating…" : "Create agent"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
