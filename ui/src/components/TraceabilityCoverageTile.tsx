// AgentDash: goals-eval-hitl
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, ChevronDown, ChevronUp } from "lucide-react";
import { goalsEvalHitlApi, goalsEvalHitlQueryKeys } from "../api/goals-eval-hitl";

interface TraceabilityCoverageTileProps {
  companyId: string;
}

export function TraceabilityCoverageTile({ companyId }: TraceabilityCoverageTileProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: goalsEvalHitlQueryKeys.coverage(companyId, showBreakdown),
    queryFn: () => goalsEvalHitlApi.fetchCoverage(companyId, showBreakdown),
    enabled: !!companyId,
  });

  if (isLoading && !data) {
    return (
      <div className="px-4 py-4 sm:px-5 sm:py-5 rounded-lg border border-border">
        <div className="h-8 w-20 bg-muted animate-pulse rounded" />
        <div className="h-3 w-32 bg-muted/60 animate-pulse rounded mt-2" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-4 sm:px-5 sm:py-5 rounded-lg border border-border">
        <p className="text-sm text-destructive">{error.message}</p>
      </div>
    );
  }

  if (!data) return null;

  const total = data.totalInFlight ?? 0;
  const covered = data.coveredInFlight ?? 0;
  const ratio = total === 0 ? 0 : data.coverageRatio ?? 0;
  const percent = Math.round(ratio * 100);

  return (
    <div className="px-4 py-4 sm:px-5 sm:py-5 rounded-lg border border-border">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums">
            {total === 0 ? "—" : `${percent}%`}
          </p>
          <p className="text-xs sm:text-sm font-medium text-muted-foreground mt-1">
            Traceability Coverage
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1.5">
            {total === 0
              ? "No in-flight issues"
              : `${covered} of ${total} in-flight issues`}
          </p>
        </div>
        <ShieldCheck className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-1.5" />
      </div>

      {total > 0 && (
        <button
          type="button"
          onClick={() => setShowBreakdown((v) => !v)}
          className="mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showBreakdown ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
          {showBreakdown ? "Hide breakdown" : "View breakdown"}
        </button>
      )}

      {showBreakdown && data.byProject && data.byProject.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {data.byProject.map((row) => {
            const rowPercent = Math.round((row.coverageRatio ?? 0) * 100);
            return (
              <div
                key={row.projectId ?? "__no-project__"}
                className="flex items-center gap-2 text-xs"
              >
                <span
                  className="font-mono text-muted-foreground truncate min-w-[6rem] max-w-[10rem]"
                  title={row.projectId ?? "(no project)"}
                >
                  {row.projectId ? row.projectId.slice(0, 8) : "(no project)"}
                </span>
                <div className="flex-1 h-1.5 bg-muted rounded overflow-hidden">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${rowPercent}%` }}
                  />
                </div>
                <span className="tabular-nums text-muted-foreground/70 shrink-0">
                  {row.coveredInFlight}/{row.totalInFlight}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {showBreakdown && (!data.byProject || data.byProject.length === 0) && (
        <p className="mt-3 text-xs text-muted-foreground/70">
          No project-level data.
        </p>
      )}
    </div>
  );
}
