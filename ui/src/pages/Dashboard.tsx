import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { cn, formatCents } from "../lib/utils";
import { Bot, LayoutDashboard, AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function formatBriefingDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function Dashboard() {
  const { selectedCompanyId, selectedCompany, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const recentActivity = useMemo(() => (activity ?? []).slice(0, 8), [activity]);

  // Activity animation logic (preserved from original)
  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) window.clearTimeout(timer);
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;
    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);
    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }
    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) { for (const id of currentIds) seen.add(id); return; }
    setAnimatedActivityIds((prev) => { const next = new Set(prev); for (const id of newIds) next.add(id); return next; });
    for (const id of newIds) seen.add(id);
    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => { const next = new Set(prev); for (const id of newIds) next.delete(id); return next; });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => { return () => { for (const timer of activityAnimationTimersRef.current) window.clearTimeout(timer); }; }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  // ── Empty / Loading states ──────────────────────────────────────────

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to AgentDash. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />;
  }

  if (isLoading) return <PageSkeleton variant="dashboard" />;

  const hasNoAgents = agents !== undefined && agents.length === 0;
  const totalAgents = data ? data.agents.active + data.agents.running + data.agents.paused + data.agents.error : 0;

  // ── Build attention items ───────────────────────────────────────────

  const attentionItems: Array<{ key: string; tone: "danger" | "warning"; label: string; detail: string; to: string }> = [];
  if (data) {
    if (data.agents.error > 0)
      attentionItems.push({ key: "errors", tone: "danger", label: `${data.agents.error} agent${data.agents.error > 1 ? "s" : ""} in error`, detail: "Needs investigation", to: "/agents/error" });
    if (data.tasks.blocked > 0)
      attentionItems.push({ key: "blocked", tone: "danger", label: `${data.tasks.blocked} task${data.tasks.blocked > 1 ? "s" : ""} blocked`, detail: "May be stalling progress", to: "/issues" });
    if (data.budgets.activeIncidents > 0)
      attentionItems.push({ key: "budget", tone: "danger", label: `${data.budgets.activeIncidents} budget incident${data.budgets.activeIncidents > 1 ? "s" : ""}`, detail: `${data.budgets.pausedAgents} agents paused`, to: "/costs" });
    const totalApprovals = data.pendingApprovals + data.budgets.pendingApprovals;
    if (totalApprovals > 0)
      attentionItems.push({ key: "approvals", tone: "warning", label: `${totalApprovals} pending approval${totalApprovals > 1 ? "s" : ""}`, detail: "Awaiting your review", to: "/approvals" });
  }

  // ── Agent status dots ───────────────────────────────────────────────

  const statusDotColor = (status: string) => {
    if (status === "running") return "bg-cyan-400";
    if (status === "active" || status === "idle") return "bg-emerald-400";
    if (status === "paused") return "bg-amber-400";
    if (status === "error") return "bg-red-400";
    return "bg-muted-foreground/30";
  };

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl space-y-8 py-2">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{getGreeting()}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{formatBriefingDate()} &middot; {selectedCompany?.name}</p>
      </div>

      {/* No agents banner */}
      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">No agents yet.</p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one
          </button>
        </div>
      )}

      {data && (
        <>
          {/* ── Needs Attention ─────────────────────────────────────── */}
          {attentionItems.length > 0 ? (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Needs your attention</h2>
              {attentionItems.map((item) => (
                <Link
                  key={item.key}
                  to={item.to}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-xl border px-4 py-3 no-underline transition-colors",
                    item.tone === "danger"
                      ? "border-red-200 bg-red-50 hover:bg-red-100/70 dark:border-red-500/20 dark:bg-red-950/40 dark:hover:bg-red-950/60"
                      : "border-amber-200 bg-amber-50 hover:bg-amber-100/70 dark:border-amber-500/20 dark:bg-amber-950/40 dark:hover:bg-amber-950/60",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <AlertTriangle className={cn("h-4 w-4 shrink-0", item.tone === "danger" ? "text-red-500" : "text-amber-500")} />
                    <div>
                      <p className={cn("text-sm font-medium", item.tone === "danger" ? "text-red-900 dark:text-red-100" : "text-amber-900 dark:text-amber-100")}>{item.label}</p>
                      <p className={cn("text-xs", item.tone === "danger" ? "text-red-700/70 dark:text-red-300/70" : "text-amber-700/70 dark:text-amber-300/70")}>{item.detail}</p>
                    </div>
                  </div>
                  <ChevronRight className={cn("h-4 w-4 shrink-0", item.tone === "danger" ? "text-red-400" : "text-amber-400")} />
                </Link>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-500/20 dark:bg-emerald-950/40">
              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
              <p className="text-sm text-emerald-800 dark:text-emerald-200">All clear — nothing needs your attention right now.</p>
            </div>
          )}

          {/* ── Team Pulse ──────────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Team</h2>
              <Link to="/agents" className="text-xs text-primary hover:underline no-underline flex items-center gap-0.5">
                View all <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="rounded-xl border bg-card px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1">
                  {(agents ?? []).slice(0, 12).map((a) => (
                    <div key={a.id} className={cn("w-2.5 h-2.5 rounded-full", statusDotColor(a.status))} title={`${a.name}: ${a.status}`} />
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{totalAgents}</span> agent{totalAgents !== 1 ? "s" : ""}
                  {data.agents.running > 0 && <> &middot; <span className="text-cyan-600 dark:text-cyan-400">{data.agents.running} running</span></>}
                  {data.agents.paused > 0 && <> &middot; <span className="text-amber-600 dark:text-amber-400">{data.agents.paused} paused</span></>}
                  {data.agents.error > 0 && <> &middot; <span className="text-red-500">{data.agents.error} error</span></>}
                </p>
              </div>
            </div>
          </div>

          {/* ── Progress Summary ────────────────────────────────────── */}
          <div>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">This month</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border bg-card px-4 py-4">
                <p className="text-3xl font-bold">{data.tasks.done}</p>
                <p className="text-sm text-muted-foreground mt-0.5">tasks completed</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {data.tasks.inProgress} in progress &middot; {data.tasks.open} open
                </p>
              </div>
              <div className="rounded-xl border bg-card px-4 py-4">
                <p className="text-3xl font-bold">{formatCents(data.costs.monthSpendCents)}</p>
                <p className="text-sm text-muted-foreground mt-0.5">spent this month</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {data.costs.monthBudgetCents > 0
                    ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                    : "No budget set"}
                </p>
              </div>
            </div>
          </div>

          {/* ── Plugin widgets ──────────────────────────────────────── */}
          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-xl border bg-card p-4"
          />

          {/* ── Recent Activity ─────────────────────────────────────── */}
          {recentActivity.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Recent activity</h2>
                <Link to="/activity" className="text-xs text-primary hover:underline no-underline flex items-center gap-0.5">
                  View all <ChevronRight className="h-3 w-3" />
                </Link>
              </div>
              <div className="rounded-xl border divide-y divide-border overflow-hidden">
                {recentActivity.map((event) => (
                  <ActivityRow
                    key={event.id}
                    event={event}
                    agentMap={agentMap}
                    entityNameMap={entityNameMap}
                    entityTitleMap={entityTitleMap}
                    className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
