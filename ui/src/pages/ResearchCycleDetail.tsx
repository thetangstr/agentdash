// AgentDash: AutoResearch cycle detail page (CUJ-8)
import { useEffect } from "react";
import { useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { FlaskConical, Lightbulb, BarChart3 } from "lucide-react";

interface ResearchCycle {
  id: string;
  title: string;
  description: string | null;
  status: string;
  currentIteration: number;
  maxIterations: number;
  ownerAgentId: string | null;
  projectId: string | null;
  goalId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface Hypothesis {
  id: string;
  title: string;
  rationale: string | null;
  source: string;
  status: string;
  priority: number | null;
  cycleId: string;
  createdAt: string;
}

interface Experiment {
  id: string;
  title: string | null;
  description: string | null;
  status: string;
  hypothesisId: string | null;
  cycleId: string;
  createdAt: string;
}

export function ResearchCycleDetail() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: cycle, isLoading, error } = useQuery({
    queryKey: ["research-cycle", selectedCompanyId, cycleId],
    queryFn: () => api.get<ResearchCycle>(`/companies/${selectedCompanyId}/research-cycles/${cycleId}`),
    enabled: !!selectedCompanyId && !!cycleId,
  });

  const { data: hypotheses } = useQuery({
    queryKey: ["research-hypotheses", selectedCompanyId, cycleId],
    queryFn: () => api.get<Hypothesis[]>(`/companies/${selectedCompanyId}/research-cycles/${cycleId}/hypotheses`),
    enabled: !!selectedCompanyId && !!cycleId,
  });

  const { data: experiments } = useQuery({
    queryKey: ["research-experiments", selectedCompanyId, cycleId],
    queryFn: () => api.get<Experiment[]>(`/companies/${selectedCompanyId}/research-cycles/${cycleId}/experiments`),
    enabled: !!selectedCompanyId && !!cycleId,
  });

  useEffect(() => {
    if (cycle) {
      setBreadcrumbs([
        { label: "Research" },
        { label: cycle.title },
      ]);
    }
  }, [cycle, setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={FlaskConical} message="Select a company." />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  if (!cycle) return <EmptyState icon={FlaskConical} message="Research cycle not found." />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 shrink-0">
          <FlaskConical className="h-6 w-6" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold truncate">{cycle.title}</h1>
          {cycle.description && (
            <p className="text-sm text-muted-foreground mt-1">{cycle.description}</p>
          )}
          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
            <span>Iteration {cycle.currentIteration}/{cycle.maxIterations}</span>
            {cycle.startedAt && <span>Started {new Date(cycle.startedAt).toLocaleDateString()}</span>}
          </div>
        </div>
        <StatusBadge status={cycle.status} />
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Status" value={cycle.status} />
        <StatCard label="Iteration" value={`${cycle.currentIteration} / ${cycle.maxIterations}`} />
        <StatCard label="Hypotheses" value={String(hypotheses?.length ?? 0)} />
        <StatCard label="Experiments" value={String(experiments?.length ?? 0)} />
      </div>

      {/* Hypotheses */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Lightbulb className="h-4 w-4" />
          Hypotheses ({hypotheses?.length ?? 0})
        </h2>
        {hypotheses && hypotheses.length > 0 ? (
          <div className="border border-border">
            {hypotheses.map((h) => (
              <EntityRow
                key={h.id}
                title={h.title}
                subtitle={h.rationale || undefined}
                leading={
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{h.source}</span>
                }
                trailing={<StatusBadge status={h.status} />}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No hypotheses generated yet.</p>
        )}
      </section>

      {/* Experiments */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          Experiments ({experiments?.length ?? 0})
        </h2>
        {experiments && experiments.length > 0 ? (
          <div className="border border-border">
            {experiments.map((e) => (
              <EntityRow
                key={e.id}
                title={e.title ?? "Untitled experiment"}
                subtitle={e.description || undefined}
                trailing={<StatusBadge status={e.status} />}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No experiments created yet.</p>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold mt-0.5">{value}</p>
    </div>
  );
}
