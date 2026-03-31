import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useState } from "react";
import { GitBranch, Play, ChevronRight, CheckCircle2, Circle, Loader2, XCircle, Clock } from "lucide-react";

interface PipelineStage {
  order: number;
  name: string;
  agentTemplateSlug?: string;
  agentId?: string;
  autoAdvance: boolean;
}

interface Pipeline {
  id: string;
  name: string;
  description?: string;
  status: string;
  stages: PipelineStage[];
  createdAt: string;
}

interface StageResult {
  stageIndex: number;
  stageName: string;
  agentId: string;
  issueId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
}

interface PipelineRun {
  id: string;
  pipelineId: string;
  status: string;
  currentStageIndex: number;
  stageResults: StageResult[];
  context?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}

function formatRelative(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const STATUS_STYLES: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  completed: { icon: CheckCircle2, color: "text-emerald-500" },
  running: { icon: Loader2, color: "text-blue-500 animate-spin" },
  failed: { icon: XCircle, color: "text-red-500" },
  cancelled: { icon: XCircle, color: "text-slate-400" },
};

export function Pipelines() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: pipelines = [], isLoading } = useQuery({
    queryKey: ["pipelines", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/pipelines`); return r.json() as Promise<Pipeline[]>; },
    enabled: !!cid,
  });

  const { data: runs = [] } = useQuery({
    queryKey: ["pipeline-runs", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/pipeline-runs`); return r.json() as Promise<PipelineRun[]>; },
    enabled: !!cid,
  });

  const selectedRun = selectedRunId ? runs.find((r) => r.id === selectedRunId) : null;
  const selectedPipeline = selectedRun ? pipelines.find((p) => p.id === selectedRun.pipelineId) : null;

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Agent Pipelines</h1>
        <p className="text-sm text-muted-foreground mt-1">Multi-agent workflows with stage-based handoffs</p>
      </div>

      {isLoading ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">Loading pipelines...</div>
      ) : pipelines.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center space-y-3">
          <GitBranch className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <div>
            <p className="font-medium text-muted-foreground">No pipelines defined</p>
            <p className="text-sm text-muted-foreground/70 mt-1">Create a pipeline via the API to orchestrate multi-agent workflows.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Pipeline Definitions */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Pipelines ({pipelines.length})</h2>
            {pipelines.map((p) => (
              <div key={p.id} className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <GitBranch className="h-5 w-5 text-violet-500" />
                    <div>
                      <p className="font-medium">{p.name}</p>
                      {p.description && <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"
                    }`}>{p.status}</span>
                    <span className="text-xs text-muted-foreground">{p.stages.length} stages</span>
                  </div>
                </div>
                {/* Stage chips */}
                <div className="flex items-center gap-1 mt-3 overflow-x-auto">
                  {p.stages.map((s, i) => (
                    <div key={i} className="flex items-center gap-1 shrink-0">
                      <span className="rounded-lg bg-muted px-2.5 py-1 text-xs font-medium">{s.name}</span>
                      {i < p.stages.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Pipeline Runs */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Recent Runs ({runs.length})
            </h2>
            {runs.length === 0 ? (
              <div className="rounded-xl border bg-card p-6 text-center text-muted-foreground text-sm">
                No pipeline runs yet. Start one from the API.
              </div>
            ) : (
              <div className="space-y-2">
                {runs.map((run) => {
                  const pipeline = pipelines.find((p) => p.id === run.pipelineId);
                  const statusStyle = STATUS_STYLES[run.status] ?? { icon: Circle, color: "text-muted-foreground" };
                  const StatusIcon = statusStyle.icon;
                  const isSelected = selectedRunId === run.id;

                  return (
                    <button
                      key={run.id}
                      onClick={() => setSelectedRunId(isSelected ? null : run.id)}
                      className={`w-full text-left rounded-xl border p-4 transition-colors ${
                        isSelected ? "border-primary bg-primary/5" : "bg-card hover:bg-muted/30"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <StatusIcon className={`h-5 w-5 ${statusStyle.color}`} />
                          <div>
                            <p className="font-medium">{pipeline?.name ?? "Unknown Pipeline"}</p>
                            <p className="text-xs text-muted-foreground">
                              Stage {run.currentStageIndex + 1}/{pipeline?.stages.length ?? "?"} — {run.stageResults.length} completed
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            run.status === "completed" ? "bg-emerald-100 text-emerald-700"
                              : run.status === "running" ? "bg-blue-100 text-blue-700"
                              : run.status === "failed" ? "bg-red-100 text-red-700"
                              : "bg-muted text-muted-foreground"
                          }`}>{run.status}</span>
                          <span className="text-xs text-muted-foreground">{formatRelative(run.startedAt)}</span>
                        </div>
                      </div>

                      {/* Expanded: Stage progress */}
                      {isSelected && pipeline && (
                        <div className="mt-4 pt-4 border-t">
                          <StageProgress
                            stages={pipeline.stages}
                            stageResults={run.stageResults}
                            currentStageIndex={run.currentStageIndex}
                            runStatus={run.status}
                          />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StageProgress({
  stages, stageResults, currentStageIndex, runStatus,
}: {
  stages: PipelineStage[];
  stageResults: StageResult[];
  currentStageIndex: number;
  runStatus: string;
}) {
  const resultMap = new Map(stageResults.map((r) => [r.stageIndex, r]));

  return (
    <div className="space-y-2">
      {stages.map((stage, i) => {
        const result = resultMap.get(i);
        const isCurrent = i === currentStageIndex && runStatus === "running";
        const isCompleted = !!result && result.status === "completed";
        const isPending = !result && !isCurrent;

        return (
          <div key={i} className="flex items-center gap-3">
            {/* Status indicator */}
            <div className={`flex items-center justify-center h-8 w-8 rounded-full border-2 shrink-0 ${
              isCompleted ? "border-emerald-500 bg-emerald-50"
                : isCurrent ? "border-blue-500 bg-blue-50"
                : "border-slate-200 bg-slate-50"
            }`}>
              {isCompleted && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
              {isCurrent && <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />}
              {isPending && <Circle className="h-4 w-4 text-slate-300" />}
            </div>

            {/* Stage info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <p className={`text-sm font-medium ${isPending ? "text-muted-foreground" : ""}`}>
                  {stage.name}
                </p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {stage.agentTemplateSlug && (
                    <span className="font-mono bg-muted px-1.5 py-0.5 rounded">{stage.agentTemplateSlug}</span>
                  )}
                  {result?.completedAt && (
                    <span>{formatRelative(result.completedAt)}</span>
                  )}
                  {stage.autoAdvance && (
                    <span className="text-emerald-600">auto</span>
                  )}
                </div>
              </div>
              {result && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Agent: {result.agentId.slice(0, 8)}... — Issue: {result.issueId.slice(0, 8)}...
                </p>
              )}
            </div>

            {/* Connector line */}
            {i < stages.length - 1 && (
              <div className="absolute left-[15px] mt-8 h-2 w-px bg-slate-200" />
            )}
          </div>
        );
      })}
    </div>
  );
}
