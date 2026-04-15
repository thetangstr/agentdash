// AgentDash: Budget forecast display page (CUJ-11)
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { budgetsApi } from "../api/budgets";
import { api } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { DollarSign, TrendingUp, TrendingDown, AlertTriangle } from "lucide-react";
import type { BudgetOverview } from "@agentdash/shared";

interface BurnRateData {
  scopeType: string;
  scopeId: string;
  dailyBurn: number;
  weeklyBurn: number;
  monthlyBurn: number;
  projectedMonthlyTotal: number;
  daysUntilBudgetExhausted: number | null;
}

interface WorkforceSnapshot {
  totalAgents: number;
  activeAgents: number;
  idleAgents: number;
  utilizationPercent: number;
}

export function BudgetForecast() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Budget Forecast" }]);
  }, [setBreadcrumbs]);

  const { data: overview, isLoading, error } = useQuery({
    queryKey: queryKeys.budgets.overview(selectedCompanyId!),
    queryFn: () => budgetsApi.overview(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: burnRate } = useQuery({
    queryKey: ["budget-burn-rate", selectedCompanyId],
    queryFn: () => api.get<BurnRateData>(`/companies/${selectedCompanyId}/budget-forecasts/burn-rate?scopeType=company`),
    enabled: !!selectedCompanyId,
  });

  const { data: workforce } = useQuery({
    queryKey: ["capacity-workforce", selectedCompanyId],
    queryFn: () => api.get<WorkforceSnapshot>(`/companies/${selectedCompanyId}/capacity/workforce`),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select a company to view budget forecast." />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Budget Forecast</h2>

      {/* Overview cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          icon={<DollarSign className="h-5 w-5" />}
          label="Monthly Burn"
          value={burnRate ? `$${burnRate.monthlyBurn.toLocaleString()}` : "—"}
          color="blue"
        />
        <MetricCard
          icon={<TrendingUp className="h-5 w-5" />}
          label="Projected Monthly"
          value={burnRate ? `$${burnRate.projectedMonthlyTotal.toLocaleString()}` : "—"}
          color="teal"
        />
        <MetricCard
          icon={burnRate?.daysUntilBudgetExhausted != null && burnRate.daysUntilBudgetExhausted < 30
            ? <AlertTriangle className="h-5 w-5" />
            : <TrendingDown className="h-5 w-5" />}
          label="Days Until Exhausted"
          value={burnRate?.daysUntilBudgetExhausted != null ? String(burnRate.daysUntilBudgetExhausted) : "N/A"}
          color={burnRate?.daysUntilBudgetExhausted != null && burnRate.daysUntilBudgetExhausted < 30 ? "red" : "gray"}
        />
        <MetricCard
          icon={<DollarSign className="h-5 w-5" />}
          label="Daily Burn"
          value={burnRate ? `$${burnRate.dailyBurn.toLocaleString()}` : "—"}
          color="gray"
        />
      </div>

      {/* Workforce utilization */}
      {workforce && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Workforce Utilization
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Total Agents" value={String(workforce.totalAgents)} />
            <StatCard label="Active" value={String(workforce.activeAgents)} />
            <StatCard label="Idle" value={String(workforce.idleAgents)} />
            <StatCard label="Utilization" value={`${workforce.utilizationPercent}%`} />
          </div>
          <div className="h-3 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-teal-500 rounded-full transition-all"
              style={{ width: `${Math.min(100, workforce.utilizationPercent)}%` }}
            />
          </div>
        </section>
      )}

      {/* Budget policies */}
      {overview && overview.policies.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Budget Policies ({overview.policies.length})
          </h3>
          <div className="border border-border">
            {overview.policies.map((policy) => (
              <div key={policy.policyId} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{policy.scopeName}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${policy.utilizationPercent > 90 ? "bg-red-500" : policy.utilizationPercent > 70 ? "bg-amber-500" : "bg-teal-500"}`}
                        style={{ width: `${Math.min(100, policy.utilizationPercent)}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      ${policy.observedAmount.toLocaleString()} / ${policy.amount.toLocaleString()}
                    </span>
                  </div>
                </div>
                <StatusBadge status={policy.isActive ? "active" : "paused"} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Active incidents */}
      {overview && overview.activeIncidents.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Active Incidents ({overview.activeIncidents.length})
          </h3>
          <div className="border border-border">
            {overview.activeIncidents.map((incident) => (
              <div key={incident.id} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{incident.scopeName} — {incident.thresholdType}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    ${incident.amountObserved.toLocaleString()} / ${incident.amountLimit.toLocaleString()} ({incident.metric})
                  </p>
                </div>
                <StatusBadge status={incident.status} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400",
    teal: "bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400",
    red: "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400",
    gray: "bg-muted text-muted-foreground",
  };

  return (
    <div className="border border-border p-4 flex items-start gap-3">
      <div className={`flex h-10 w-10 items-center justify-center rounded ${colorMap[color] ?? colorMap.gray}`}>
        {icon}
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold mt-0.5">{value}</p>
      </div>
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
