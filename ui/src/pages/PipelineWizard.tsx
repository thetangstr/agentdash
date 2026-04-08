// AgentDash: Pipeline creation wizard — 5-step guided pipeline creation flow
import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useNavigate } from "@/lib/router";
import { pipelinesApi } from "../api/pipelines";
import { DagPreview } from "../components/DagPreview";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  PIPELINE_EXECUTION_MODES,
  PIPELINE_STAGE_TYPES,
} from "@agentdash/shared";
import type {
  PipelineStageDefinition,
  PipelineEdgeDefinition,
  PipelineDefaults,
} from "@agentdash/shared";
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  Trash2,
  GitBranch,
  Check,
  Eye,
  Settings,
  Layers,
  FileText,
} from "lucide-react";

type WizardStep = 1 | 2 | 3 | 4 | 5;

const STEPS: { label: string; icon: React.ReactNode }[] = [
  { label: "Basics", icon: <FileText className="h-4 w-4" /> },
  { label: "Stages", icon: <Layers className="h-4 w-4" /> },
  { label: "Edges", icon: <GitBranch className="h-4 w-4" /> },
  { label: "Defaults", icon: <Settings className="h-4 w-4" /> },
  { label: "Review", icon: <Eye className="h-4 w-4" /> },
];

const STAGE_TYPE_LABELS: Record<(typeof PIPELINE_STAGE_TYPES)[number], string> = {
  agent: "Agent",
  hitl_gate: "HITL Gate",
  merge: "Merge",
};

const STAGE_TYPE_DESCRIPTIONS: Record<(typeof PIPELINE_STAGE_TYPES)[number], string> = {
  agent: "Runs an AI agent with scoped instructions",
  hitl_gate: "Pauses for human approval before continuing",
  merge: "Waits for multiple upstream stages to complete",
};

function makeStageId(counter: number): string {
  return `stage-${counter}`;
}

function makeEdgeId(counter: number): string {
  return `edge-${counter}`;
}

function defaultStage(
  id: string,
  type: (typeof PIPELINE_STAGE_TYPES)[number],
  index: number,
): PipelineStageDefinition {
  const base: PipelineStageDefinition = {
    id,
    name: `${STAGE_TYPE_LABELS[type]} ${index}`,
    type,
    scopedInstruction: "",
  };
  if (type === "hitl_gate") {
    return { ...base, hitlInstructions: "", hitlTimeoutHours: 24 };
  }
  if (type === "merge") {
    return { ...base, mergeStrategy: "all" };
  }
  return base;
}

export default function PipelineWizard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  const [step, setStep] = useState<WizardStep>(1);

  // Step 1: Basics
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [executionMode, setExecutionMode] = useState<(typeof PIPELINE_EXECUTION_MODES)[number]>("sync");

  // Step 2: Stages
  const [stages, setStages] = useState<PipelineStageDefinition[]>([]);
  const [stageCounter, setStageCounter] = useState(1);

  // Step 3: Edges
  const [edges, setEdges] = useState<PipelineEdgeDefinition[]>([]);
  const [edgeCounter, setEdgeCounter] = useState(1);

  // Step 4: Defaults
  const [stageTimeoutMinutes, setStageTimeoutMinutes] = useState(60);
  const [hitlTimeoutHours, setHitlTimeoutHours] = useState(24);
  const [maxSelfHealRetries, setMaxSelfHealRetries] = useState(3);
  const [budgetCapUsd, setBudgetCapUsd] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipelines", href: "/pipelines" }, { label: "New Pipeline" }]);
  }, [setBreadcrumbs]);

  // Stage management
  const addStage = (type: (typeof PIPELINE_STAGE_TYPES)[number]) => {
    const id = makeStageId(stageCounter);
    setStages((prev) => [...prev, defaultStage(id, type, stageCounter)]);
    setStageCounter((c) => c + 1);
  };

  const removeStage = (id: string) => {
    setStages((prev) => prev.filter((s) => s.id !== id));
    // Remove connected edges
    setEdges((prev) => prev.filter((e) => e.fromStageId !== id && e.toStageId !== id));
  };

  const updateStage = (id: string, updates: Partial<PipelineStageDefinition>) => {
    setStages((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    );
  };

  // Edge management
  const addEdge = () => {
    if (stages.length < 2) return;
    const id = makeEdgeId(edgeCounter);
    setEdges((prev) => [
      ...prev,
      {
        id,
        fromStageId: stages[0].id,
        toStageId: stages[1].id,
        condition: "",
      },
    ]);
    setEdgeCounter((c) => c + 1);
  };

  const removeEdge = (id: string) => {
    setEdges((prev) => prev.filter((e) => e.id !== id));
  };

  const updateEdge = (id: string, updates: Partial<PipelineEdgeDefinition>) => {
    setEdges((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...updates } : e)),
    );
  };

  const canProceed = (): boolean => {
    if (step === 1) return name.trim().length > 0;
    if (step === 2) return stages.length >= 1;
    return true;
  };

  const handleNext = () => {
    if (step < 5) setStep((s) => (s + 1) as WizardStep);
  };

  const handleBack = () => {
    if (step > 1) setStep((s) => (s - 1) as WizardStep);
  };

  const handleStepClick = (target: WizardStep) => {
    if (target < step) setStep(target);
  };

  const buildDefaults = (): PipelineDefaults => {
    const defaults: PipelineDefaults = {
      stageTimeoutMinutes,
      hitlTimeoutHours,
      maxSelfHealRetries,
    };
    const budget = parseFloat(budgetCapUsd);
    if (!isNaN(budget) && budget > 0) {
      defaults.budgetCapUsd = budget;
    }
    return defaults;
  };

  const createMutation = useMutation({
    mutationFn: () =>
      pipelinesApi.create(selectedCompanyId!, {
        name,
        description: description.trim() || undefined,
        stages,
        edges: edges.length > 0 ? edges : undefined,
        executionMode,
        defaults: buildDefaults(),
      }),
    onSuccess: (data) => {
      navigate(`/pipelines/${data.id}`);
    },
  });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground p-6">Select a company first.</p>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b flex items-center gap-3">
        <GitBranch className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">New Pipeline</h1>
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
        {/* Step 1: Basics */}
        {step === 1 && (
          <div className="max-w-xl space-y-6">
            <div>
              <h2 className="text-base font-semibold">Pipeline basics</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Give your pipeline a name, optional description, and choose how stages execute.
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">
                Pipeline name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Deal Review Pipeline"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this pipeline do?"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Execution mode</label>
              <div className="grid grid-cols-2 gap-3">
                {PIPELINE_EXECUTION_MODES.map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setExecutionMode(mode)}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-lg border-2 p-3 text-left transition-colors",
                      executionMode === mode
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40",
                    )}
                  >
                    <span className="text-sm font-medium capitalize">{mode}</span>
                    <span className="text-xs text-muted-foreground">
                      {mode === "sync"
                        ? "Stages run one after another, blocking until complete"
                        : "Stages may run concurrently, non-blocking dispatch"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Stages */}
        {step === 2 && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h2 className="text-base font-semibold">Define stages</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Add the stages your pipeline will execute. At least one stage is required.
              </p>
            </div>

            {/* Add stage buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              {PIPELINE_STAGE_TYPES.map((type) => (
                <button
                  key={type}
                  onClick={() => addStage(type)}
                  className="flex items-center gap-1.5 rounded-md border border-dashed border-primary/60 px-3 py-1.5 text-sm text-primary hover:bg-primary/5 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {STAGE_TYPE_LABELS[type]}
                </button>
              ))}
            </div>

            {stages.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <Layers className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No stages yet. Add one above.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {stages.map((stage, idx) => (
                  <div key={stage.id} className="rounded-lg border bg-card p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground font-mono w-6 shrink-0">
                        {idx + 1}
                      </span>
                      <input
                        type="text"
                        value={stage.name}
                        onChange={(e) => updateStage(stage.id, { name: e.target.value })}
                        className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        placeholder="Stage name"
                      />
                      <span
                        className={cn(
                          "text-xs px-2 py-0.5 rounded-full font-medium shrink-0",
                          stage.type === "agent" && "bg-gray-100 text-gray-600",
                          stage.type === "hitl_gate" && "bg-amber-100 text-amber-700",
                          stage.type === "merge" && "bg-purple-100 text-purple-700",
                        )}
                      >
                        {STAGE_TYPE_LABELS[stage.type]}
                      </span>
                      <button
                        onClick={() => removeStage(stage.id)}
                        className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                        title="Remove stage"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    {/* Scoped instruction */}
                    <div className="space-y-1 ml-9">
                      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Scoped instruction
                      </label>
                      <textarea
                        value={stage.scopedInstruction}
                        onChange={(e) => updateStage(stage.id, { scopedInstruction: e.target.value })}
                        placeholder={
                          stage.type === "hitl_gate"
                            ? "Instructions shown to the human reviewer..."
                            : stage.type === "merge"
                            ? "Instructions for merging upstream results..."
                            : "What should this agent do in this stage?"
                        }
                        rows={2}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                      />
                    </div>

                    {/* HITL-specific fields */}
                    {stage.type === "hitl_gate" && (
                      <div className="ml-9 space-y-2">
                        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          HITL timeout (hours)
                        </label>
                        <input
                          type="number"
                          min={1}
                          value={stage.hitlTimeoutHours ?? 24}
                          onChange={(e) =>
                            updateStage(stage.id, { hitlTimeoutHours: parseInt(e.target.value, 10) || 24 })
                          }
                          className="w-32 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                      </div>
                    )}

                    {/* Merge-specific fields */}
                    {stage.type === "merge" && (
                      <div className="ml-9 space-y-2">
                        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Merge strategy
                        </label>
                        <div className="flex items-center gap-3">
                          {(["all", "any"] as const).map((strategy) => (
                            <label key={strategy} className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name={`merge-strategy-${stage.id}`}
                                value={strategy}
                                checked={(stage.mergeStrategy ?? "all") === strategy}
                                onChange={() => updateStage(stage.id, { mergeStrategy: strategy })}
                                className="h-4 w-4 accent-primary"
                              />
                              <span className="text-sm capitalize">{strategy}</span>
                              <span className="text-xs text-muted-foreground">
                                {strategy === "all" ? "(wait for all)" : "(first to finish)"}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 3: Edges */}
        {step === 3 && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h2 className="text-base font-semibold">Connect stages</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Define the flow between stages. Add optional conditions to control branching.
              </p>
            </div>

            {/* DAG Preview */}
            {stages.length > 0 && (
              <div className="rounded-lg border bg-card p-4 overflow-x-auto">
                <p className="text-xs text-muted-foreground mb-3 font-medium uppercase tracking-wide">
                  Live DAG preview
                </p>
                <DagPreview stages={stages} edges={edges} />
              </div>
            )}

            {stages.length < 2 ? (
              <div className="rounded-lg border border-dashed p-6 text-center">
                <p className="text-sm text-muted-foreground">
                  Add at least 2 stages to create edges.
                </p>
              </div>
            ) : (
              <>
                <button
                  onClick={addEdge}
                  className="flex items-center gap-1.5 rounded-md border border-dashed border-primary/60 px-3 py-1.5 text-sm text-primary hover:bg-primary/5 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add edge
                </button>

                {edges.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No edges yet. Stages will run independently without connections.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {edges.map((edge, idx) => (
                      <div key={edge.id} className="rounded-lg border bg-card p-4">
                        <div className="flex items-center gap-3 mb-3">
                          <span className="text-xs text-muted-foreground font-mono w-6 shrink-0">
                            {idx + 1}
                          </span>
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <select
                              value={edge.fromStageId}
                              onChange={(e) => updateEdge(edge.id, { fromStageId: e.target.value })}
                              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                            >
                              {stages.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                            <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            <select
                              value={edge.toStageId}
                              onChange={(e) => updateEdge(edge.id, { toStageId: e.target.value })}
                              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                            >
                              {stages.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            onClick={() => removeEdge(edge.id)}
                            className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                            title="Remove edge"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="ml-9 space-y-1">
                          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Condition (optional)
                          </label>
                          <input
                            type="text"
                            value={edge.condition ?? ""}
                            onChange={(e) => updateEdge(edge.id, { condition: e.target.value || undefined })}
                            placeholder='e.g. status == "approved"'
                            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Step 4: Defaults */}
        {step === 4 && (
          <div className="max-w-xl space-y-6">
            <div>
              <h2 className="text-base font-semibold">Pipeline defaults</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Set timeout, retry, and budget defaults applied to all stages unless overridden.
              </p>
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-sm font-medium">Stage timeout (minutes)</label>
                <input
                  type="number"
                  min={1}
                  value={stageTimeoutMinutes}
                  onChange={(e) => setStageTimeoutMinutes(parseInt(e.target.value, 10) || 60)}
                  className="w-40 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <p className="text-xs text-muted-foreground">How long each stage may run before timing out.</p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">HITL timeout (hours)</label>
                <input
                  type="number"
                  min={1}
                  value={hitlTimeoutHours}
                  onChange={(e) => setHitlTimeoutHours(parseInt(e.target.value, 10) || 24)}
                  className="w-40 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <p className="text-xs text-muted-foreground">How long to wait for human review before escalating.</p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Max self-heal retries</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={maxSelfHealRetries}
                  onChange={(e) => setMaxSelfHealRetries(parseInt(e.target.value, 10) || 0)}
                  className="w-40 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <p className="text-xs text-muted-foreground">Number of automatic retry attempts on stage failure.</p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Budget cap (USD)</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={budgetCapUsd}
                  onChange={(e) => setBudgetCapUsd(e.target.value)}
                  placeholder="e.g. 10.00"
                  className="w-40 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <p className="text-xs text-muted-foreground">Optional hard stop if pipeline spend exceeds this amount.</p>
              </div>
            </div>
          </div>
        )}

        {/* Step 5: Review */}
        {step === 5 && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h2 className="text-base font-semibold">Review & create</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Confirm your pipeline configuration before creating.
              </p>
            </div>

            {/* DAG Preview */}
            {stages.length > 0 && (
              <div className="rounded-lg border bg-card p-4 overflow-x-auto">
                <p className="text-xs text-muted-foreground mb-3 font-medium uppercase tracking-wide">
                  Pipeline DAG
                </p>
                <DagPreview stages={stages} edges={edges} />
              </div>
            )}

            {/* Summary table */}
            <div className="rounded-lg border divide-y">
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-32 shrink-0">Name</span>
                <p className="text-sm font-medium">{name}</p>
              </div>
              {description && (
                <div className="px-4 py-3 flex gap-4">
                  <span className="text-sm text-muted-foreground w-32 shrink-0">Description</span>
                  <p className="text-sm">{description}</p>
                </div>
              )}
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-32 shrink-0">Execution mode</span>
                <p className="text-sm capitalize">{executionMode}</p>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-32 shrink-0">Stages</span>
                <div className="flex flex-wrap gap-1.5">
                  {stages.map((s) => (
                    <span
                      key={s.id}
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full font-medium",
                        s.type === "agent" && "bg-gray-100 text-gray-600",
                        s.type === "hitl_gate" && "bg-amber-100 text-amber-700",
                        s.type === "merge" && "bg-purple-100 text-purple-700",
                      )}
                    >
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-32 shrink-0">Edges</span>
                <p className="text-sm">
                  {edges.length === 0
                    ? "No edges (stages run independently)"
                    : `${edges.length} edge${edges.length !== 1 ? "s" : ""}`}
                </p>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-32 shrink-0">Stage timeout</span>
                <p className="text-sm">{stageTimeoutMinutes} min</p>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-32 shrink-0">HITL timeout</span>
                <p className="text-sm">{hitlTimeoutHours} hr</p>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-32 shrink-0">Self-heal retries</span>
                <p className="text-sm">{maxSelfHealRetries}</p>
              </div>
              <div className="px-4 py-3 flex gap-4">
                <span className="text-sm text-muted-foreground w-32 shrink-0">Budget cap</span>
                <p className="text-sm">
                  {budgetCapUsd && parseFloat(budgetCapUsd) > 0
                    ? `$${parseFloat(budgetCapUsd).toFixed(2)}`
                    : "None"}
                </p>
              </div>
            </div>

            {createMutation.isError && (
              <p className="text-sm text-red-600">
                Failed to create pipeline. Please try again.
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
          className="gap-1.5"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>

        {step < 5 ? (
          <Button onClick={handleNext} disabled={!canProceed()} className="gap-1.5">
            Next
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            className="gap-1.5"
          >
            <GitBranch className="h-3.5 w-3.5" />
            {createMutation.isPending ? "Creating..." : "Create Pipeline"}
          </Button>
        )}
      </div>
    </div>
  );
}
