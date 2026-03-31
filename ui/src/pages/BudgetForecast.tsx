import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { DollarSign, TrendingUp, PieChart, Wallet, AlertTriangle } from "lucide-react";
import { useMemo } from "react";

// --- Types ---

interface BudgetPolicySummary {
  policyId: string;
  companyId: string;
  scopeType: string;
  scopeId: string;
  scopeName: string;
  metric: string;
  windowKind: string;
  amount: number;
  observedAmount: number;
  remainingAmount: number;
  utilizationPercent: number;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  status: string;
  paused: boolean;
  pauseReason: string | null;
}

interface BudgetIncident {
  id: string;
  scopeType: string;
  scopeId: string;
  scopeName: string;
  thresholdType: string;
  amountLimit: number;
  amountObserved: number;
  status: string;
  approvalStatus: string | null;
}

interface BudgetOverview {
  companyId: string;
  policies: BudgetPolicySummary[];
  activeIncidents: BudgetIncident[];
  pausedAgentCount: number;
  pausedProjectCount: number;
  pendingApprovalCount: number;
}

interface Agent {
  id: string;
  name: string;
  status: string;
  budgetMonthlyCents?: number | null;
}

// --- Helpers ---

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString()}`;
}

function utilizationColor(pct: number): string {
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-amber-500";
  return "bg-emerald-500";
}

function utilizationTextColor(pct: number): string {
  if (pct >= 100) return "text-red-600";
  if (pct >= 80) return "text-amber-600";
  return "text-emerald-600";
}

function utilizationBadge(pct: number): string {
  if (pct >= 100) return "bg-red-100 text-red-700";
  if (pct >= 80) return "bg-amber-100 text-amber-700";
  return "bg-emerald-100 text-emerald-700";
}

// --- Component ---

export function BudgetForecast() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;

  const { data: overview, isLoading: overviewLoading } = useQuery<BudgetOverview>({
    queryKey: ["budget-overview", cid],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${cid}/budgets/overview`);
      return res.json();
    },
    enabled: !!cid,
  });

  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ["budget-agents", cid],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${cid}/agents`);
      return res.json();
    },
    enabled: !!cid,
  });

  // Derive summaries
  const policies = overview?.policies ?? [];

  const companyPolicy = useMemo(
    () => policies.find((p) => p.scopeType === "company" && p.isActive) ?? null,
    [policies],
  );

  const agentPolicies = useMemo(
    () => policies.filter((p) => p.scopeType === "agent" && p.isActive),
    [policies],
  );

  const projectPolicies = useMemo(
    () => policies.filter((p) => p.scopeType === "project" && p.isActive),
    [policies],
  );

  // Merge agent data with policies
  const agentAllocations = useMemo(() => {
    const policyByScopeId = new Map<string, BudgetPolicySummary>();
    for (const p of agentPolicies) policyByScopeId.set(p.scopeId, p);

    return (agents as Agent[])
      .map((agent) => {
        const policy = policyByScopeId.get(agent.id);
        return {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          allocated: policy?.amount ?? 0,
          spent: policy?.observedAmount ?? 0,
          remaining: policy?.remainingAmount ?? 0,
          utilization: policy?.utilizationPercent ?? 0,
          hasPolicy: !!policy,
        };
      })
      .filter((a) => a.hasPolicy || a.allocated > 0)
      .sort((a, b) => b.utilization - a.utilization);
  }, [agents, agentPolicies]);

  // Totals
  const totalBudget = companyPolicy?.amount ?? 0;
  const totalSpent = companyPolicy?.observedAmount ?? 0;
  const totalRemaining = companyPolicy?.remainingAmount ?? 0;
  const totalUtilization = companyPolicy?.utilizationPercent ?? 0;

  // Forecast: sum of agent allocations vs company budget
  const allocatedToAgents = agentPolicies.reduce((sum, p) => sum + p.amount, 0);
  const allocatedToProjects = projectPolicies.reduce((sum, p) => sum + p.amount, 0);

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;

  if (overviewLoading) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold">Budget & Forecast</h1>
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
          Loading budget data...
        </div>
      </div>
    );
  }

  if (policies.length === 0) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold">Budget & Forecast</h1>
        <div className="rounded-xl border bg-card p-12 text-center space-y-3">
          <Wallet className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <div>
            <p className="font-medium text-muted-foreground">
              No budgets configured. Set up budget pools in Settings.
            </p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Budget policies let you set spending limits per company, agent, or project.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <DollarSign className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-bold">Budget & Forecast</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {policies.length} active budget {policies.length === 1 ? "policy" : "policies"}
            {overview && overview.pendingApprovalCount > 0 && (
              <span className="ml-2 text-amber-600 font-medium">
                {overview.pendingApprovalCount} pending approval{overview.pendingApprovalCount > 1 ? "s" : ""}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Incidents banner */}
      {overview && overview.activeIncidents.length > 0 && (
        <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <span className="font-medium text-amber-800 text-sm">
              {overview.activeIncidents.length} active budget incident{overview.activeIncidents.length > 1 ? "s" : ""}
            </span>
          </div>
          <div className="space-y-1.5">
            {overview.activeIncidents.slice(0, 5).map((inc) => (
              <div key={inc.id} className="flex items-center justify-between text-sm">
                <span className="text-amber-900">
                  <span className="font-medium">{inc.scopeName}</span>
                  <span className="text-amber-700 ml-1">
                    ({inc.scopeType}) - {inc.thresholdType} threshold
                  </span>
                </span>
                <span className="text-amber-800 font-medium">
                  {formatCents(inc.amountObserved)} / {formatCents(inc.amountLimit)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          icon={<DollarSign className="h-5 w-5 text-muted-foreground" />}
          label="Total Budget"
          value={totalBudget > 0 ? formatCents(totalBudget) : "--"}
          sub={companyPolicy ? `${companyPolicy.windowKind.replace(/_/g, " ")}` : "No company policy"}
          pct={null}
        />
        <SummaryCard
          icon={<TrendingUp className="h-5 w-5 text-muted-foreground" />}
          label="Spent"
          value={formatCents(totalSpent)}
          sub={totalBudget > 0 ? `${totalUtilization.toFixed(1)}% of budget` : ""}
          pct={totalUtilization}
        />
        <SummaryCard
          icon={<Wallet className="h-5 w-5 text-muted-foreground" />}
          label="Remaining"
          value={formatCents(totalRemaining)}
          sub={totalBudget > 0 ? `${(100 - totalUtilization).toFixed(1)}% available` : ""}
          pct={null}
        />
        <SummaryCard
          icon={<PieChart className="h-5 w-5 text-muted-foreground" />}
          label="Allocated"
          value={formatCents(allocatedToAgents + allocatedToProjects)}
          sub={`${agentPolicies.length} agents, ${projectPolicies.length} projects`}
          pct={null}
        />
      </div>

      {/* Utilization bar */}
      {totalBudget > 0 && (
        <div className="rounded-xl border bg-card p-5">
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Company Budget Utilization</h2>
          <div className="h-4 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${utilizationColor(totalUtilization)}`}
              style={{ width: `${Math.min(totalUtilization, 100)}%` }}
            />
          </div>
          <div className="flex justify-between mt-2 text-xs text-muted-foreground">
            <span>
              {formatCents(totalSpent)} spent
            </span>
            <span className={utilizationTextColor(totalUtilization)}>
              {totalUtilization.toFixed(1)}%
            </span>
            <span>
              {formatCents(totalBudget)} budget
            </span>
          </div>
        </div>
      )}

      {/* Allocation by Agent */}
      {agentAllocations.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Allocation by Agent</h2>
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">Agent</th>
                  <th className="text-right p-3 font-medium">Allocated</th>
                  <th className="text-right p-3 font-medium">Spent</th>
                  <th className="text-right p-3 font-medium">Remaining</th>
                  <th className="text-right p-3 font-medium">Utilization</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {agentAllocations.map((a) => (
                  <tr key={a.id} className="hover:bg-muted/30">
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{a.name}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            a.status === "active" || a.status === "running"
                              ? "bg-emerald-100 text-emerald-700"
                              : a.status === "paused"
                                ? "bg-amber-100 text-amber-700"
                                : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {a.status}
                        </span>
                      </div>
                    </td>
                    <td className="p-3 text-right font-medium">{formatCents(a.allocated)}</td>
                    <td className="p-3 text-right">{formatCents(a.spent)}</td>
                    <td className="p-3 text-right">{formatCents(a.remaining)}</td>
                    <td className="p-3 text-right">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${utilizationBadge(a.utilization)}`}>
                        {a.utilization.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Forecast Chart (horizontal bars) */}
      {policies.filter((p) => p.isActive && p.amount > 0).length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Spend vs Budget</h2>
          <div className="rounded-xl border bg-card p-5 space-y-4">
            {policies
              .filter((p) => p.isActive && p.amount > 0)
              .sort((a, b) => b.utilizationPercent - a.utilizationPercent)
              .map((p) => (
                <ForecastBar key={p.policyId} policy={p} />
              ))}
          </div>
        </div>
      )}

      {/* Budget Pools (project-level policies) */}
      {projectPolicies.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-lg font-semibold">Budget Pools</h2>
            <span className="text-xs text-muted-foreground">({projectPolicies.length} pools)</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projectPolicies.map((pool) => (
              <div key={pool.policyId} className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-sm truncate">{pool.scopeName}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${utilizationBadge(pool.utilizationPercent)}`}>
                    {pool.utilizationPercent.toFixed(1)}%
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mb-2">
                  {pool.windowKind.replace(/_/g, " ")} - {pool.metric.replace(/_/g, " ")}
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden mb-2">
                  <div
                    className={`h-full rounded-full ${utilizationColor(pool.utilizationPercent)}`}
                    style={{ width: `${Math.min(pool.utilizationPercent, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{formatCents(pool.observedAmount)} used</span>
                  <span>{formatCents(pool.amount)} limit</span>
                </div>
                {pool.paused && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-red-600">
                    <AlertTriangle className="h-3 w-3" />
                    Paused{pool.pauseReason ? ` (${pool.pauseReason})` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Sub-components ---

function SummaryCard({
  icon,
  label,
  value,
  sub,
  pct,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  pct: number | null;
}) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
      </div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      {pct !== null && (
        <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${utilizationColor(pct)}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function ForecastBar({ policy }: { policy: BudgetPolicySummary }) {
  const spentPct = policy.amount > 0 ? Math.min((policy.observedAmount / policy.amount) * 100, 100) : 0;
  // Forecast: estimate remainder of window based on current burn (simple linear)
  const forecastPct = Math.min(spentPct * 1.2, 100); // simple +20% projection

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{policy.scopeName}</span>
          <span className="text-xs text-muted-foreground">({policy.scopeType})</span>
        </div>
        <span className={`text-xs font-medium ${utilizationTextColor(policy.utilizationPercent)}`}>
          {formatCents(policy.observedAmount)} / {formatCents(policy.amount)}
        </span>
      </div>
      <div className="relative h-5 bg-gray-100 rounded-full overflow-hidden">
        {/* Forecast fill (amber, behind spent) */}
        <div
          className="absolute inset-y-0 left-0 bg-amber-200 rounded-full"
          style={{ width: `${forecastPct}%` }}
        />
        {/* Spent fill (green/red over forecast) */}
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${
            policy.utilizationPercent >= 100
              ? "bg-red-400"
              : policy.utilizationPercent >= 80
                ? "bg-amber-400"
                : "bg-emerald-400"
          }`}
          style={{ width: `${spentPct}%` }}
        />
      </div>
      <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
          Spent
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-200" />
          Forecast
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-gray-100 border" />
          Budget
        </span>
      </div>
    </div>
  );
}
