// AgentDash: one-UX (doc/plans/2026-09-30-one-ux.md) — the control-plane half
// of the one Dashboard every company lands on. It sits under Home's Waiting on
// you / Working now / Shipped blocks and carries only what those blocks do not:
// fleet size, open work, month spend, the agent fleet and recent activity.
//
// Deliberately left out, because the top half already shows them:
//   - the greeting and "N running" pill (Home's header and Working now),
//   - "awaiting you" and the approval cards (Waiting on you links to Decisions),
//   - the live-runs grid (Working now links to /dashboard/live).
// Numbers render directly from the data they count: no count-up animation.
// Each panel owns its loading and error state so one slow query never blanks
// the page.
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, CircleDot, DollarSign, History, PauseCircle, type LucideIcon } from "lucide-react";
import type { ActivityEvent, Agent, DashboardSummary } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { dashboardApi } from "../../api/dashboard";
import { agentsApi } from "../../api/agents";
import { activityApi } from "../../api/activity";
import { accessApi } from "../../api/access";
import { queryKeys } from "../../lib/queryKeys";
import { buildCompanyUserProfileMap } from "../../lib/company-members";
import { formatCents, formatTokens } from "../../lib/utils";
import { BILLED_BY_PROVIDER_NOTE, NOT_MEASURED_TEXT, TOKENS_COUNTED_NOTE, UNMEASURED_USAGE_NOTE } from "../../lib/token-figures";
import { timeAgo } from "../../lib/timeAgo";
import { agentIdentityLineUnderName, humanizeAgentRole, isGenericAgentRole } from "../../lib/agent-identity";
import { ActivityRow } from "../ActivityRow";
import { IMPORTANT_SYSTEM_ACTIVITY_ACTIONS, isSystemPlumbingActivity } from "../../lib/activity-format";

export const FLEET_TILE_LIMIT = 6;
export const DASHBOARD_ACTIVITY_LIMIT = 8;
export const NO_AGENTS_TEXT = "No agents yet.";
export const BYOK_SPEND_NOTE = BILLED_BY_PROVIDER_NOTE;
/** GH #918: what the spend tile says to a member who cannot read the cost routes. */
export const SPEND_RESTRICTED_NOTE = "Visible to administrators only";

/**
 * AgentDash (review-1015): the line under an agent's name must never restate
 * the name. agentIdentityLineUnderName suppresses its own duplicates, but the
 * role fallback re-printed "Chief of Staff" under "Chief of Staff" — so the
 * CoS names itself "Your Chief of Staff" and any other restating role drops
 * the line entirely. Same rule on phone and desktop (one row renders both).
 */
export function fleetRowSubtitle(agent: { name?: string | null; role?: string | null; title?: string | null }): string {
  const line = agentIdentityLineUnderName(agent);
  if (line) return line;
  if ((agent.role ?? "").trim() === "chief_of_staff") return "Your Chief of Staff";
  const roleLabel = isGenericAgentRole(agent.role) ? "" : humanizeAgentRole(agent.role);
  if (roleLabel && roleLabel.toLowerCase() === (agent.name ?? "").trim().toLowerCase()) return "";
  return roleLabel || "Agent";
}

/**
 * AgentDash: what the month-spend tile shows. A BYOK box meters tokens but not
 * dollars (the customer's model provider bills them), so "$0.00" next to real
 * usage would be wrong. Dollars whenever any were metered; tokens when the
 * agents used tokens and nothing was priced; "Not measured" when work
 * happened but recorded no usage; "$0.00" only when nothing ran. Chat turns
 * count as work — conversations leave no heartbeat run row.
 */
export function monthSpendTile(costs: DashboardSummary["costs"]): {
  label: string;
  value: string;
  unmetered: boolean;
  unmeasured: boolean;
  restricted: boolean;
} {
  // GH #918: `costs` is null for members who cannot read the cost routes —
  // say so plainly rather than fake a zero.
  if (costs === null) {
    return {
      label: "Spend this month",
      value: "—",
      unmetered: false,
      unmeasured: false,
      restricted: true,
    };
  }
  const tokens = Number(costs.monthTokens ?? 0);
  if (costs.monthSpendCents <= 0 && tokens > 0) {
    return { label: "Tokens this month", value: formatTokens(tokens), unmetered: true, unmeasured: false, restricted: false };
  }
  if (costs.monthSpendCents <= 0 && ((costs.monthRuns ?? 0) + (costs.monthChatTurns ?? 0)) > 0) {
    return { label: "Spend this month", value: NOT_MEASURED_TEXT, unmetered: false, unmeasured: true, restricted: false };
  }
  return { label: "Spend this month", value: formatCents(costs.monthSpendCents), unmetered: false, unmeasured: false, restricted: false };
}

export const NO_ACTIVITY_TEXT = "No activity yet. Hires, issues and runs show up here as they happen.";

/**
 * How many agents the company has. The dashboard summary can lag the agent
 * list for a moment right after a hire (AGE-448 race), so take the larger.
 */
export function fleetSize(summary: DashboardSummary | undefined, agents: Agent[] | undefined): number | null {
  if (!summary && !agents) return null;
  const fromSummary = summary
    ? summary.agents.active + summary.agents.running + summary.agents.paused + summary.agents.error
    : 0;
  const fromList = (agents ?? []).filter((a) => a.status !== "terminated").length;
  return Math.max(fromSummary, fromList);
}

function detailString(event: ActivityEvent, ...keys: string[]) {
  const details = event.details;
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function activityEntityName(event: ActivityEvent) {
  if (event.entityType === "issue") return detailString(event, "identifier", "issueIdentifier");
  if (event.entityType === "project") return detailString(event, "projectName", "name", "title");
  if (event.entityType === "goal") return detailString(event, "goalTitle", "title", "name");
  return detailString(event, "name", "title");
}

function PanelMessage({ tone = "muted", children, testId }: { tone?: "muted" | "error"; children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      role={tone === "error" ? "alert" : undefined}
      className={`px-4 py-5 text-sm ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
    >
      {children}
    </div>
  );
}

function errorText(what: string, error: unknown) {
  const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
  return `Couldn't load ${what}.${detail}`;
}

function Panel({
  title,
  testId,
  action,
  children,
}: {
  title: string;
  testId: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card" data-testid={testId} aria-label={title}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  to,
  testId,
  title,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  detail: ReactNode;
  /** GH #918: a card with nowhere truthful to go renders as a div, not a link. */
  to?: string;
  testId: string;
  /** Hover text saying what the number counts. */
  title?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" data-testid={`${testId}-value`}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>
    </>
  );
  const className =
    "block rounded-xl border border-border bg-card px-4 py-3 text-inherit no-underline transition-colors hover:border-foreground/20";
  if (!to) {
    return (
      <div title={title} data-testid={testId} className={className}>
        {body}
      </div>
    );
  }
  return (
    <Link to={to} title={title} data-testid={testId} className={className}>
      {body}
    </Link>
  );
}

function StatsRow({
  summary,
  isLoading,
  error,
  agentCount,
}: {
  summary: DashboardSummary | undefined;
  isLoading: boolean;
  error: unknown;
  agentCount: number | null;
}) {
  if (error && !summary) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <PanelMessage tone="error" testId="dashboard-stats-error">
          {errorText("the numbers", error)}
        </PanelMessage>
      </div>
    );
  }
  if (isLoading || !summary) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="dashboard-stats-loading" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[86px] animate-pulse rounded-xl border border-border bg-muted/40 motion-reduce:animate-none" />
        ))}
      </div>
    );
  }
  const { agents, tasks, costs, budgets } = summary;
  const spend = monthSpendTile(costs);
  return (
    <div className="space-y-3">
      {budgets.activeIncidents > 0 ? (
        <div
          role="alert"
          data-testid="dashboard-budget-incident"
          className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-2.5">
            <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <div>
              <div className="font-medium">
                {budgets.activeIncidents} active budget incident{budgets.activeIncidents === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-muted-foreground">
                {budgets.pausedAgents} agent{budgets.pausedAgents === 1 ? "" : "s"} paused · {budgets.pausedProjects}{" "}
                project{budgets.pausedProjects === 1 ? "" : "s"} paused
              </div>
            </div>
          </div>
          <Link to="/costs" className="shrink-0 text-sm underline underline-offset-2">
            Open budgets
          </Link>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="dashboard-stats">
        <StatCard
          icon={Bot}
          label="Agents"
          value={agentCount ?? 0}
          detail={`${agents.running} running · ${agents.paused} paused · ${agents.error} with errors`}
          to="/agents/all"
          testId="dashboard-stat-agents"
        />
        <StatCard
          icon={CircleDot}
          label="Open issues"
          value={tasks.open}
          detail={`${tasks.inProgress} in progress · ${tasks.blocked} blocked`}
          to="/issues"
          testId="dashboard-stat-issues"
        />
        <StatCard
          icon={DollarSign}
          label={spend.label}
          value={spend.value}
          detail={
            spend.restricted
              ? SPEND_RESTRICTED_NOTE
              : spend.unmetered
              ? BYOK_SPEND_NOTE
              : spend.unmeasured
              ? UNMEASURED_USAGE_NOTE
              : costs && costs.monthBudgetCents > 0
              ? `${costs.monthUtilizationPercent}% of ${formatCents(costs.monthBudgetCents)} budget`
              : "No monthly budget set"
          }
          to={spend.restricted ? undefined : "/costs"}
          title={spend.unmetered ? TOKENS_COUNTED_NOTE : undefined}
          testId="dashboard-stat-spend"
        />
      </div>
    </div>
  );
}

function statusTone(status: string): { word: string; dot: string } {
  switch (status) {
    case "running":
      return { word: "running", dot: "bg-emerald-500" };
    case "error":
      return { word: "error", dot: "bg-destructive" };
    case "paused":
      return { word: "paused", dot: "bg-amber-500" };
    case "idle":
      return { word: "idle", dot: "bg-muted-foreground/50" };
    default:
      return { word: status.replace(/_/g, " "), dot: "bg-muted-foreground/50" };
  }
}

function FleetPanel({ agents, isLoading, error }: { agents: Agent[] | undefined; isLoading: boolean; error: unknown }) {
  const live = (agents ?? []).filter((a) => a.status !== "terminated");
  const shown = live.slice(0, FLEET_TILE_LIMIT);
  return (
    <Panel
      title="Agent fleet"
      testId="dashboard-fleet"
      action={
        live.length > 0 ? (
          <Link to="/agents/all" className="text-xs text-muted-foreground hover:text-foreground hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-end">
            View all {live.length}
          </Link>
        ) : undefined
      }
    >
      {error && !agents ? (
        <PanelMessage tone="error">{errorText("your agents", error)}</PanelMessage>
      ) : isLoading && !agents ? (
        <PanelMessage>Loading agents…</PanelMessage>
      ) : live.length === 0 ? (
        <PanelMessage testId="dashboard-fleet-empty">
          {NO_AGENTS_TEXT}{" "}
          <Link to="/agents/new" className="font-medium text-foreground underline underline-offset-2">
            Hire your first agent
          </Link>
        </PanelMessage>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((agent) => {
            const tone = statusTone(agent.status);
            return (
              <li key={agent.id} data-testid="dashboard-fleet-row">
                <Link
                  to={`/agents/${agent.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 text-inherit no-underline hover:bg-accent/50"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{agent.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {fleetRowSubtitle(agent)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted-foreground">
                    <span className="block">{tone.word}</span>
                    {agent.lastHeartbeatAt ? <span className="block">{timeAgo(agent.lastHeartbeatAt)}</span> : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function ActivityPanel({ companyId, agents }: { companyId: string; agents: Agent[] | undefined }) {
  const { data: activity, isLoading, error } = useQuery({
    queryKey: [...queryKeys.activity(companyId), { limit: DASHBOARD_ACTIVITY_LIMIT }],
    queryFn: () => activityApi.list(companyId, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    refetchInterval: 60_000,
  });
  const { data: members } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    retry: false,
  });
  const userProfileMap = useMemo(() => buildCompanyUserProfileMap(members?.users), [members?.users]);
  const agentMap = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const event of activity ?? []) {
      const name = activityEntityName(event);
      if (name) map.set(`${event.entityType}:${event.entityId}`, name);
    }
    return map;
  }, [activity, agents]);
  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of activity ?? []) {
      const title = event.entityType === "issue" ? detailString(event, "issueTitle", "title") : null;
      if (title) map.set(`${event.entityType}:${event.entityId}`, title);
    }
    return map;
  }, [activity]);
  // System plumbing (workspace leases, runtime checks, read/queue noise)
  // stays out of Home — but the system events an owner must not miss (budget
  // hard-stops, ceiling pauses, failed recovery, escalations, failed hire
  // hooks) stay in.
  const events = (activity ?? [])
    .filter((event) =>
      !isSystemPlumbingActivity(event.action)
      && (event.actorType !== "system" || IMPORTANT_SYSTEM_ACTIVITY_ACTIONS.has(event.action)))
    .slice(0, DASHBOARD_ACTIVITY_LIMIT);

  return (
    <Panel
      title="Recent activity"
      testId="dashboard-activity"
      action={
        <Link to="/activity" className="text-xs text-muted-foreground hover:text-foreground hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-end">
          All activity
        </Link>
      }
    >
      {error && !activity ? (
        <PanelMessage tone="error">{errorText("recent activity", error)}</PanelMessage>
      ) : isLoading && !activity ? (
        <PanelMessage>Loading activity…</PanelMessage>
      ) : events.length === 0 ? (
        <PanelMessage testId="dashboard-activity-empty">
          <span className="inline-flex items-center gap-2">
            <History className="h-4 w-4 shrink-0" aria-hidden="true" />
            {NO_ACTIVITY_TEXT}
          </span>
        </PanelMessage>
      ) : (
        <div className="divide-y divide-border overflow-hidden">
          {events.map((event) => (
            <ActivityRow
              key={event.id}
              event={event}
              agentMap={agentMap}
              userProfileMap={userProfileMap}
              entityNameMap={entityNameMap}
              entityTitleMap={entityTitleMap}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

/**
 * The control-plane half of the Dashboard. The summary and agent-list queries
 * share their cache keys with the top half, so they are fetched once.
 */
export function ControlPlanePanels({ companyId }: { companyId: string }) {
  const summary = useQuery({
    queryKey: queryKeys.dashboard(companyId),
    queryFn: () => dashboardApi.summary(companyId),
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const agentCount = fleetSize(summary.data, agents.data);

  return (
    <section className="space-y-4" data-testid="dashboard-control-plane" aria-label="Agents, spend and activity">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Agents, spend and activity</h2>
      <StatsRow summary={summary.data} isLoading={summary.isLoading} error={summary.error} agentCount={agentCount} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <FleetPanel agents={agents.data} isLoading={agents.isLoading} error={agents.error} />
        <ActivityPanel companyId={companyId} agents={agents.data} />
      </div>
    </section>
  );
}
