import { useQuery } from "@tanstack/react-query";
import { Target, TrendingUp, CheckCircle2 } from "lucide-react";

interface AgentOkrsProps {
  companyId: string;
  agentId: string;
}

export function AgentOkrs({ companyId, agentId }: AgentOkrsProps) {
  const { data: okrs = [], isLoading } = useQuery({
    queryKey: ["agent-okrs", companyId, agentId],
    queryFn: async () => {
      const res = await fetch(
        `/api/companies/${companyId}/okrs?agentId=${agentId}`,
      );
      return res.json();
    },
    enabled: !!companyId && !!agentId,
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading OKRs...</div>;
  }

  if (okrs.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center space-y-2">
        <Target className="h-8 w-8 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No OKRs assigned to this agent</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {okrs.map((okr: any) => {
        const keyResults = okr.keyResults ?? okr.key_results ?? [];

        return (
          <div
            key={okr.id}
            className="rounded-xl border bg-card p-5 space-y-4 hover:border-foreground/20 transition-colors"
          >
            {/* Objective Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                <Target className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm">{okr.title ?? okr.objective}</h3>
                  {okr.description && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {okr.description}
                    </p>
                  )}
                </div>
              </div>
              {okr.status && (
                <span className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground">
                  {okr.status}
                </span>
              )}
            </div>

            {/* Key Results */}
            {keyResults.length > 0 && (
              <div className="space-y-3 pl-7">
                {keyResults.map((kr: any, idx: number) => {
                  const current = kr.current ?? kr.currentValue ?? 0;
                  const target = kr.target ?? kr.targetValue ?? 1;
                  const pct = Math.min(Math.round((current / target) * 100), 100);
                  const barColor =
                    pct >= 80
                      ? "bg-emerald-500"
                      : pct >= 50
                        ? "bg-amber-500"
                        : "bg-red-500";
                  const textColor =
                    pct >= 80
                      ? "text-emerald-600"
                      : pct >= 50
                        ? "text-amber-600"
                        : "text-red-600";

                  return (
                    <div key={kr.id ?? idx} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {pct >= 100 ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                          ) : (
                            <TrendingUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          )}
                          <span className="text-sm truncate">
                            {kr.title ?? kr.description ?? `Key Result ${idx + 1}`}
                          </span>
                        </div>
                        <span className={`text-xs font-medium shrink-0 ${textColor}`}>
                          {pct}%
                        </span>
                      </div>
                      {/* Progress bar */}
                      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${barColor}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {current} / {target}
                          {kr.unit ? ` ${kr.unit}` : ""}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
