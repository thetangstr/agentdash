// AgentDash: Goal hub rollup (AGE-40).
// Single-call view of the goal's agent roster, originating plan, open work,
// spend/budget, KPI progress, and activity timeline.

import { useQuery } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  DollarSign,
  Target,
  Users,
  Workflow,
} from "lucide-react";
import { goalsApi, type GoalHubAgentSummary, type GoalHubKpiRow, type GoalHubRollup } from "../api/goals";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface GoalHubProps {
  companyId: string;
  goalId: string;
}

function centsToUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function percentLabel(p: number | null): string {
  if (p == null) return "—";
  return `${p.toFixed(p >= 10 ? 0 : 1)}%`;
}

export function GoalHub({ companyId, goalId }: GoalHubProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.hub(companyId, goalId),
    queryFn: () => goalsApi.getHub(companyId, goalId),
    enabled: !!companyId && !!goalId,
  });

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="goal-hub-loading">
        <div className="h-24 bg-muted/40 animate-pulse" />
        <div className="h-24 bg-muted/40 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        Failed to load goal hub: {(error as Error).message}
      </p>
    );
  }

  if (!data) return null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="goal-hub">
      <AgentsCard agents={data.agents} />
      <PlanCard plan={data.plan} />
      <WorkCard work={data.work} />
      <SpendCard spend={data.spend} />
      <div className="lg:col-span-2">
        <KpiCard kpis={data.kpis} />
      </div>
      <div className="lg:col-span-2">
        <ActivityCard activity={data.activity} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function AgentsCard({ agents }: { agents: GoalHubAgentSummary[] }) {
  return (
    <Card data-testid="goal-hub-agents-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          Agents ({agents.length})
        </CardTitle>
        <CardDescription>Roster serving this goal and their monthly spend.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents assigned yet. Propose a team from this goal to hire agents.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {agents.map((a) => {
              const pct =
                a.budgetMonthlyCents > 0
                  ? Math.round((a.spendMonthlyCents / a.budgetMonthlyCents) * 100)
                  : null;
              return (
                <li key={a.agentId} className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm font-medium">{a.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {a.role} · {a.adapterType} · {a.status}
                    </p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>
                      <span data-testid="agent-spend">{centsToUsd(a.spendMonthlyCents)}</span>
                      {" / "}
                      {centsToUsd(a.budgetMonthlyCents)}
                    </div>
                    {pct != null && <div>{pct}% of budget</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PlanCard({ plan }: { plan: GoalHubRollup["plan"] }) {
  return (
    <Card data-testid="goal-hub-plan-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4" />
          Plan
        </CardTitle>
        <CardDescription>The agent-team plan that spawned this goal's roster.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {!plan ? (
          <p className="text-sm text-muted-foreground">
            No plan has been proposed for this goal yet.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="capitalize">
                {plan.archetype}
              </Badge>
              <Badge variant={plan.status === "expanded" ? "default" : "outline"} className="capitalize">
                {plan.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                created {timeAgo(plan.createdAt)}
              </span>
            </div>
            {plan.rationale && <p className="text-sm">{plan.rationale}</p>}
            {plan.decisionNote && (
              <p className="text-sm italic text-muted-foreground">
                Decision note: {plan.decisionNote}
              </p>
            )}
            {plan.approvedAt && (
              <p className="text-xs text-muted-foreground">
                Approved {timeAgo(plan.approvedAt)}
                {plan.approvedByUserId ? ` by ${plan.approvedByUserId}` : ""}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function WorkCard({ work }: { work: GoalHubRollup["work"] }) {
  return (
    <Card data-testid="goal-hub-work-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Workflow className="h-4 w-4" />
          Work
        </CardTitle>
        <CardDescription>Open issues, routines and playbooks assigned to this goal.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-3">
        <div className="border border-border p-3">
          <p className="text-xs text-muted-foreground">Open issues</p>
          <p className="text-2xl font-semibold" data-testid="work-open-issues">
            {work.openIssueCount}
          </p>
        </div>
        <div className="border border-border p-3">
          <p className="text-xs text-muted-foreground">Active routines</p>
          <p className="text-2xl font-semibold" data-testid="work-active-routines">
            {work.activeRoutineCount}
          </p>
        </div>
        <div className="border border-border p-3">
          <p className="text-xs text-muted-foreground">Active playbooks</p>
          <p className="text-2xl font-semibold" data-testid="work-active-pipelines">
            {work.activePipelineCount}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function SpendCard({ spend }: { spend: GoalHubRollup["spend"] }) {
  const overBudget = spend.percentOfBudget != null && spend.percentOfBudget >= 100;
  return (
    <Card data-testid="goal-hub-spend-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="h-4 w-4" />
          Impact &amp; ROI
        </CardTitle>
        <CardDescription>
          Monthly window: {new Date(spend.windowStart).toLocaleDateString()} — current
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Spend</p>
            <p className="text-lg font-semibold" data-testid="spend-amount">
              {centsToUsd(spend.spendCents)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Revenue</p>
            <p className="text-lg font-semibold" data-testid="revenue-amount">
              {centsToUsd(spend.revenueCents)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Net</p>
            <p
              className={`text-lg font-semibold ${
                spend.netCents >= 0 ? "text-emerald-600" : "text-destructive"
              }`}
              data-testid="net-amount"
            >
              {centsToUsd(spend.netCents)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Budget</p>
            <p className="text-lg font-semibold" data-testid="budget-amount">
              {spend.budgetCents == null ? "No policy" : centsToUsd(spend.budgetCents)}
            </p>
          </div>
        </div>
        {spend.budgetCents != null && (
          <div className="space-y-1">
            <div className="h-2 w-full bg-muted">
              <div
                className={`h-2 ${overBudget ? "bg-destructive" : "bg-primary"}`}
                style={{
                  width: `${Math.min(100, spend.percentOfBudget ?? 0)}%`,
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {percentLabel(spend.percentOfBudget)} of budget used
              {overBudget && (
                <span className="ml-2 inline-flex items-center gap-1 text-destructive">
                  <AlertTriangle className="h-3 w-3" /> over budget
                </span>
              )}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function KpiCard({ kpis }: { kpis: GoalHubKpiRow[] }) {
  return (
    <Card data-testid="goal-hub-kpi-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-4 w-4" />
          KPIs
        </CardTitle>
        <CardDescription>Baseline -&gt; current -&gt; target, with on-track indicator.</CardDescription>
      </CardHeader>
      <CardContent>
        {kpis.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No KPIs defined. Approve a plan with KPIs to track impact.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {kpis.map((k) => (
              <li key={k.metric} className="py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{k.metric}</p>
                    <p className="text-xs text-muted-foreground">
                      {k.baseline} -&gt; <span data-testid={`kpi-current-${k.metric}`}>{k.current}</span> -&gt; {k.target} {k.unit} ({k.horizonDays}d horizon)
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">
                      {k.progressPercent.toFixed(0)}%
                    </span>
                    {k.onTrack ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                    )}
                  </div>
                </div>
                <div className="mt-2 h-1.5 w-full bg-muted">
                  <div
                    className={`h-1.5 ${k.onTrack ? "bg-emerald-500" : "bg-amber-500"}`}
                    style={{ width: `${Math.min(100, k.progressPercent)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityCard({ activity }: { activity: GoalHubRollup["activity"] }) {
  return (
    <Card data-testid="goal-hub-activity-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ActivityIcon className="h-4 w-4" />
          Activity
        </CardTitle>
        <CardDescription>Recent heartbeats and audit-log entries touching this goal.</CardDescription>
      </CardHeader>
      <CardContent>
        {activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity yet. Work assigned to this goal will show up here.
          </p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {activity.map((entry) => (
              <li key={`${entry.kind}-${entry.id}`} className="flex items-center justify-between py-2">
                <div>
                  <p className="font-medium">{entry.summary}</p>
                  <p className="text-xs text-muted-foreground">
                    {entry.kind === "heartbeat_run" ? "heartbeat" : "audit"}
                    {entry.entityType ? ` · ${entry.entityType}` : ""}
                    {entry.actorId ? ` · ${entry.actorId}` : ""}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">{timeAgo(entry.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
