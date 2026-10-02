import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { EntityRow } from "../components/EntityRow";
import { AgentKindBadge } from "@/components/AgentKindBadge";
import { useStewardshipFeature } from "@/hooks/useStewardshipCapability";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { TeamViewTabs } from "../components/TeamViewTabs";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Bot, Plus, List, GitBranch, SlidersHorizontal, MoreHorizontal, UserPlus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentIcon } from "../components/AgentIconPicker";
import { useIsPhone } from "../hooks/useIsPhone";
import { type Agent } from "@paperclipai/shared";
import { agentIdentityLine } from "../lib/agent-identity";

import { getAdapterLabel, plainRuntimeLabel } from "../adapters/adapter-display-registry";


type FilterTab = "all" | "active" | "paused" | "error";

function matchesFilter(status: string, tab: FilterTab, showTerminated: boolean): boolean {
  if (status === "terminated") return showTerminated;
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function filterAgents(agents: Agent[], tab: FilterTab, showTerminated: boolean): Agent[] {
  return agents
    .filter((a) => matchesFilter(a.status, tab, showTerminated))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether this agent wakes on its own.
 *
 * `runtimeConfig.heartbeat.enabled` defaults to absent, and the heartbeat
 * service treats missing-or-false as never-run-this-agent. The agent then sits
 * at `idle` — indistinguishable on this page from one that is simply between
 * tasks — and does nothing forever. That is how MKThink's instance recorded
 * zero runs for days while everything looked healthy.
 *
 * Leaving the default off is defensible: waking on a timer spends money
 * unattended, and that should be a decision. Leaving it invisible is not.
 */
function isScheduled(agent: Agent): boolean {
  const heartbeat = agent.runtimeConfig?.heartbeat;
  if (!heartbeat || typeof heartbeat !== "object" || Array.isArray(heartbeat)) return false;
  return (heartbeat as { enabled?: unknown }).enabled === true;
}

function NotScheduledBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
      title="This agent has no schedule. It runs when it is given work or someone wakes it."
    >
      Runs when asked
    </span>
  );
}

function getConfiguredModel(agent: Agent): string | null {
  const value = agent.adapterConfig?.model;
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model.length > 0 ? model : null;
}

function filterOrgTree(nodes: OrgNode[], tab: FilterTab, showTerminated: boolean): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab, showTerminated);
      if (matchesFilter(node.status, tab, showTerminated) || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function Agents() {
  const { selectedCompanyId } = useCompany();
  // AgentDash (canary1): when the workspace cannot assign stewards, "Needs a
  // steward" is not something anyone here can act on; hide that badge. Only a
  // definite "off" hides it; loading or unknown keeps today's rendering.
  const hideUnpaired = useStewardshipFeature(selectedCompanyId) === "off";
  // AgentDash: UX-11 — the Team page explains who hires agents and points at
  // Ask. Same for every company (one UX).
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const isPhone = useIsPhone();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab = (pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error") ? pathSegment : "all";
  const [view, setView] = useState<"list" | "org">("org");
  const forceListView = isMobile || isPhone;
  const effectiveView: "list" | "org" = forceListView ? "list" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "org",
  });

  const { data: runs } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "agents-page"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  // Map agentId -> first live run + live run count
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "running" && r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Team" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a workspace to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = filterAgents(agents ?? [], tab, showTerminated);
  const filteredOrg = filterOrgTree(orgTree ?? [], tab, showTerminated);

  return (
    <div className="space-y-4">
      {/* AgentDash: sidebar IA — Team is "List | Org chart"; the org chart moved off the sidebar. */}
      <TeamViewTabs active="list" />
      {isPhone ? (
        <PhoneAgentsToolbar
          tab={tab}
          onTabChange={(v) => navigate(`/agents/${v}`)}
          showTerminated={showTerminated}
          onShowTerminatedChange={setShowTerminated}
          onNewAgent={openNewAgent}
          onSetUpRole={() => navigate("/workforce")}
        />
      ) : (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => navigate(`/agents/${v}`)}>
          <PageTabBar
            items={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "error", label: "Error" },
            ]}
            value={tab}
            onValueChange={(v) => navigate(`/agents/${v}`)}
          />
        </Tabs>
        <div className="flex items-center gap-2">
          {/* Filters */}
          <div className="relative">
            <button
              className={cn(
                "flex items-center gap-1.5 px-2 py-1.5 text-xs transition-colors border border-border",
                filtersOpen || showTerminated ? "text-foreground bg-accent" : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal className="h-3 w-3" />
              Filters
              {showTerminated && <span className="ml-0.5 px-1 bg-foreground/10 rounded text-[10px]">1</span>}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-48 border border-border bg-popover shadow-md p-1">
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-left hover:bg-accent/50 transition-colors"
                  onClick={() => setShowTerminated(!showTerminated)}
                >
                  <span className={cn(
                    "flex items-center justify-center h-3.5 w-3.5 border border-border rounded-sm",
                    showTerminated && "bg-foreground"
                  )}>
                    {showTerminated && <span className="text-background text-[10px] leading-none">&#10003;</span>}
                  </span>
                  Show terminated
                </button>
              </div>
            )}
          </div>
          {/* View toggle */}
          {!forceListView && (
            <div className="flex items-center border border-border">
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("list")}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("org")}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <Link to="/workforce" className="text-sm underline">Set up a role</Link>
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Agent
          </Button>
        </div>
      </div>
      )}

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">{filtered.length} agent{filtered.length !== 1 ? "s" : ""}</p>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message="Your Chief of Staff hires agents when an issue needs them. You can also ask for one."
          action="Ask for a hire"
          actionTo="/cos"
          actionIcon={null}
        />
      )}

      {/* List view */}
      {/* AgentDash: mobile lists — two-line cards so a name never truncates behind its chips. */}
      {effectiveView === "list" && filtered.length > 0 && isPhone && (
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="agents-phone-list">
          {filtered.map((agent) => (
            <li key={agent.id}>
              <PhoneAgentCard
                agent={agent}
                liveRun={liveRunByAgent.get(agent.id)}
                dimmed={!!agent.pausedAt && tab !== "paused"}
                hideUnpaired={hideUnpaired}
              />
            </li>
          ))}
        </ul>
      )}

      {effectiveView === "list" && filtered.length > 0 && !isPhone && (
        <div className="border border-border">
          {filtered.map((agent) => {
            return (
              <EntityRow
                key={agent.id}
                title={agent.name}
                titleBadge={
                  agent.status === "terminated" ? null : <AgentKindBadge agent={agent} hideUnpaired={hideUnpaired} />
                }
                subtitle={agentIdentityLine(agent)}
                to={agentUrl(agent)}
                className={agent.pausedAt && tab !== "paused" ? "opacity-50" : ""}
                leading={
                  <span className="relative flex h-2.5 w-2.5">
                    <span
                      className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[agent.status] ?? agentStatusDotDefault}`}
                    />
                  </span>
                }
                trailing={
                  <div className="flex items-center gap-3">
                    <span className="sm:hidden">
                      {liveRunByAgent.has(agent.id) ? (
                        <LiveRunIndicator
                          agentRef={agentRouteRef(agent)}
                          runId={liveRunByAgent.get(agent.id)!.runId}
                          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                        />
                      ) : (
                        <StatusBadge status={agent.status} />
                      )}
                      {isScheduled(agent) || agent.status === "terminated" ? null : <NotScheduledBadge />}
                    </span>
                    <div className="hidden sm:flex items-center gap-3">
                      {liveRunByAgent.has(agent.id) && (
                        <LiveRunIndicator
                          agentRef={agentRouteRef(agent)}
                          runId={liveRunByAgent.get(agent.id)!.runId}
                          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                        />
                      )}
                      <span
                        className="w-36 truncate text-left text-xs text-muted-foreground"
                        title={getAdapterLabel(agent.adapterType)}
                      >
                        {plainRuntimeLabel(agent.adapterType)}
                      </span>
                      <span
                        className="w-36 truncate text-left font-mono text-xs text-muted-foreground"
                        title={getConfiguredModel(agent)
                          ?? (agent.adapterType === "hermes_local" ? "inherited from hermes config" : undefined)}
                      >
                        {getConfiguredModel(agent)
                          ?? (agent.adapterType === "hermes_local" ? "default*" : "—")}
                      </span>
                      <span className="w-16 shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">
                        {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                      </span>
                      <span className="flex w-48 shrink-0 justify-end gap-1 whitespace-nowrap" data-testid="agent-row-schedule-status">
                        {isScheduled(agent) || agent.status === "terminated" ? null : <NotScheduledBadge />}
                        <StatusBadge status={agent.status} />
                      </span>
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="border border-border py-1">
          {filteredOrg.map((node) => (
            <OrgTreeNode key={node.id} node={node} depth={0} agentMap={agentMap} liveRunByAgent={liveRunByAgent} tab={tab} hideUnpaired={hideUnpaired} />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No organizational hierarchy defined.
        </p>
      )}
    </div>
  );
}

const FILTER_TAB_OPTIONS: Array<{ value: FilterTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "error", label: "Error" },
];

/**
 * The phone toolbar: the status filter, one primary "New agent" button, and a
 * ⋯ menu holding the rest (show terminated, set up a role). Every control is
 * at least 44px tall.
 */
function PhoneAgentsToolbar({
  tab,
  onTabChange,
  showTerminated,
  onShowTerminatedChange,
  onNewAgent,
  onSetUpRole,
}: {
  tab: FilterTab;
  onTabChange: (tab: FilterTab) => void;
  showTerminated: boolean;
  onShowTerminatedChange: (value: boolean) => void;
  onNewAgent: () => void;
  onSetUpRole: () => void;
}) {
  return (
    <div className="flex items-center gap-2" data-testid="agents-phone-toolbar">
      <select
        value={tab}
        onChange={(e) => onTabChange(e.target.value as FilterTab)}
        aria-label="Filter agents by status"
        className="h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-base focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {FILTER_TAB_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Button className="h-11 shrink-0" onClick={onNewAgent}>
        <Plus className="h-4 w-4" />
        New agent
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="relative size-11 shrink-0"
            aria-label="More agent actions"
          >
            <MoreHorizontal className="h-5 w-5" />
            {showTerminated ? (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuCheckboxItem
            className="min-h-11"
            checked={showTerminated}
            onCheckedChange={(checked) => onShowTerminatedChange(checked === true)}
          >
            Show terminated
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem className="min-h-11" onSelect={onSetUpRole}>
            <UserPlus className="h-4 w-4" />
            Set up a role
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * One agent on a phone: avatar, then the full name (wrapping, never
 * truncated) and role on the first line, with the kind, status and schedule
 * chips wrapping onto the second.
 */
function PhoneAgentCard({
  agent,
  liveRun,
  dimmed,
  hideUnpaired,
}: {
  agent: Agent;
  liveRun: { runId: string; liveCount: number } | undefined;
  dimmed: boolean;
  hideUnpaired: boolean;
}) {
  const role = agentIdentityLine(agent);
  return (
    <Link
      to={agentUrl(agent)}
      data-testid="agent-phone-card"
      className={cn(
        "flex min-h-11 items-start gap-3 px-4 py-3 text-inherit no-underline transition-colors hover:bg-accent/50",
        dimmed && "opacity-50",
      )}
    >
      <span className="relative mt-0.5 shrink-0">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
          <AgentIcon icon={agent.icon} className="h-4 w-4 text-foreground/70" />
        </span>
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background",
            agentStatusDot[agent.status] ?? agentStatusDotDefault,
          )}
          aria-hidden="true"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="break-words text-sm font-medium text-foreground" data-testid="agent-phone-name">
            {agent.name}
          </span>
          <span className="break-words text-xs text-muted-foreground">{role}</span>
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {agent.status === "terminated" ? null : <AgentKindBadge agent={agent} className="text-xs" hideUnpaired={hideUnpaired} />}
          {liveRun ? (
            // A chip, not LiveRunIndicator's link: the whole card is already a link.
            <span className="flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
              <span className="h-2 w-2 rounded-full bg-blue-500" aria-hidden="true" />
              Live{liveRun.liveCount > 1 ? ` (${liveRun.liveCount})` : ""}
            </span>
          ) : (
            <StatusBadge status={agent.status} />
          )}
          {isScheduled(agent) || agent.status === "terminated" ? null : <NotScheduledBadge className="text-xs" />}
        </span>
      </span>
    </Link>
  );
}

function OrgTreeNode({
  node,
  depth,
  agentMap,
  liveRunByAgent,
  tab,
  hideUnpaired,
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  tab: FilterTab;
  hideUnpaired: boolean;
}) {
  const agent = agentMap.get(node.id);

  const statusColor = agentStatusDot[node.status] ?? agentStatusDotDefault;

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <Link
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        className={cn("flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left no-underline text-inherit", agent?.pausedAt && tab !== "paused" && "opacity-50")}
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className={`absolute inline-flex h-full w-full rounded-full ${statusColor}`} />
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{node.name}</span>
          {agent && node.status !== "terminated" ? (
            <AgentKindBadge agent={agent} className="ml-2 align-middle" hideUnpaired={hideUnpaired} />
          ) : null}
          <span className="text-xs text-muted-foreground ml-2" data-testid="agent-org-row-identity">
            {agentIdentityLine({ role: node.role, title: agent?.title ?? null })}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="sm:hidden">
            {liveRunByAgent.has(node.id) ? (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            ) : (
              <StatusBadge status={node.status} />
            )}
            {agent && !isScheduled(agent) && node.status !== "terminated" ? <NotScheduledBadge /> : null}
          </span>
          <div className="hidden sm:flex items-center gap-3">
            {liveRunByAgent.has(node.id) && (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            )}
            {agent && (
              <>
                <span
                  className="w-36 truncate text-left text-xs text-muted-foreground"
                  title={getAdapterLabel(agent.adapterType)}
                >
                  {plainRuntimeLabel(agent.adapterType)}
                </span>
                <span
                  className="w-36 truncate text-left font-mono text-xs text-muted-foreground"
                  title={getConfiguredModel(agent) ?? undefined}
                >
                  {getConfiguredModel(agent) ?? "—"}
                </span>
                <span className="w-16 shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">
                  {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                </span>
              </>
            )}
            <span className="flex w-48 shrink-0 justify-end gap-1 whitespace-nowrap" data-testid="agent-row-schedule-status">
              {agent && !isScheduled(agent) && node.status !== "terminated" ? <NotScheduledBadge /> : null}
              <StatusBadge status={node.status} />
            </span>
          </div>
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode key={child.id} node={child} depth={depth + 1} agentMap={agentMap} liveRunByAgent={liveRunByAgent} tab={tab} hideUnpaired={hideUnpaired} />
          ))}
        </div>
      )}
    </div>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}
