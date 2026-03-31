import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { FlaskConical, ArrowLeft, BookOpen, Globe, Bot } from "lucide-react";

export function ResearchCycleDetail() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;

  const { data: cycle, isLoading } = useQuery({
    queryKey: ["research-cycle", cid, cycleId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${cid}/research-cycles/${cycleId}`);
      return res.json();
    },
    enabled: !!cid && !!cycleId,
  });

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;
  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (!cycle) return <div className="p-6 text-muted-foreground">Research cycle not found</div>;

  const statusColors: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-700",
    paused: "bg-amber-100 text-amber-700",
    completed: "bg-blue-100 text-blue-700",
    cancelled: "bg-slate-100 text-slate-600",
  };

  const findings = cycle.findings ?? cycle.results ?? [];
  const sources = cycle.sources ?? cycle.sourcesExamined ?? [];
  const status = cycle.status ?? "active";

  return (
    <div className="p-6 space-y-6">
      {/* Back link */}
      <Link
        to="/research"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Research
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <FlaskConical className="h-6 w-6 text-muted-foreground mt-1" />
          <div>
            <h1 className="text-2xl font-bold">{cycle.title ?? cycle.name ?? "Untitled Cycle"}</h1>
            {cycle.topic && (
              <p className="text-sm text-muted-foreground mt-1">{cycle.topic}</p>
            )}
            {cycle.description && !cycle.topic && (
              <p className="text-sm text-muted-foreground mt-1">{cycle.description}</p>
            )}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[status] ?? "bg-muted text-muted-foreground"}`}
        >
          {status}
        </span>
      </div>

      {/* Metadata */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cycle.createdAt && (
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground mb-1">Created</p>
            <p className="text-sm font-medium">
              {new Date(cycle.createdAt).toLocaleDateString()}
            </p>
          </div>
        )}
        {cycle.currentIteration != null && (
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground mb-1">Iteration</p>
            <p className="text-sm font-medium">
              {cycle.currentIteration}
              {cycle.maxIterations ? ` / ${cycle.maxIterations}` : ""}
            </p>
          </div>
        )}
        {cycle.agentId && (
          <div className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Bot className="h-3.5 w-3.5" />
              Agent
            </div>
            <p className="text-sm font-medium truncate">
              {cycle.agentName ?? cycle.agentId.slice(0, 8)}
            </p>
          </div>
        )}
        {sources.length > 0 && (
          <div className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Globe className="h-3.5 w-3.5" />
              Sources
            </div>
            <p className="text-sm font-medium">{sources.length} examined</p>
          </div>
        )}
      </div>

      {/* Summary / Conclusion */}
      {(cycle.summary ?? cycle.conclusion) && (
        <div className="rounded-xl border bg-card p-5 space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Summary</h2>
          <p className="text-sm leading-relaxed">{cycle.summary ?? cycle.conclusion}</p>
        </div>
      )}

      {/* Findings */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <BookOpen className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Findings</h2>
        </div>
        {findings.length === 0 ? (
          <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
            No findings recorded for this cycle yet.
          </div>
        ) : (
          <div className="space-y-3">
            {findings.map((f: any, idx: number) => (
              <div
                key={f.id ?? idx}
                className="rounded-xl border bg-card p-4 space-y-2 hover:border-foreground/20 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-medium text-sm">
                    {f.title ?? f.heading ?? `Finding ${idx + 1}`}
                  </h3>
                  {f.confidence != null && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {Math.round(f.confidence * 100)}% confidence
                    </span>
                  )}
                </div>
                {(f.body ?? f.content ?? f.description) && (
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {f.body ?? f.content ?? f.description}
                  </p>
                )}
                {f.source && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Globe className="h-3 w-3" />
                    {f.source}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sources Examined */}
      {sources.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Globe className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Sources Examined</h2>
          </div>
          <div className="rounded-xl border overflow-hidden">
            <div className="divide-y">
              {sources.map((s: any, idx: number) => (
                <div key={idx} className="px-4 py-3 flex items-center gap-3 text-sm">
                  <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate">
                    {typeof s === "string" ? s : s.url ?? s.name ?? s.title ?? `Source ${idx + 1}`}
                  </span>
                  {typeof s === "object" && s.type && (
                    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs">
                      {s.type}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
