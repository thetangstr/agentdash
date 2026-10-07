import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  PlayCircle,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useToastActions } from "../context/ToastContext";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";
import { useAgentOrder } from "../hooks/useAgentOrder";
import {
  buildSidebarAgentTree,
  getSidebarTeamGroupStorageKey,
  readSidebarTeamGroupExpanded,
  writeSidebarTeamGroupExpanded,
  type SidebarAgentTreeNode,
} from "../lib/sidebar-agent-teams";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Agent } from "@paperclipai/shared";

function SidebarAgentItem({
  activeAgentId,
  activeTab,
  agent,
  disabled,
  isMobile,
  onPauseResume,
  runCount,
  setSidebarOpen,
  teamToggle,
}: {
  activeAgentId: string | null;
  activeTab: string | null;
  agent: Agent;
  disabled: boolean;
  isMobile: boolean;
  onPauseResume: (agent: Agent, action: "pause" | "resume") => void;
  runCount: number;
  setSidebarOpen: (open: boolean) => void;
  /** AgentDash: the team-group chevron, for an agent with direct reports. */
  teamToggle?: ReactNode;
}) {
  const routeRef = agentRouteRef(agent);
  const href = activeTab ? `${agentUrl(agent)}/${activeTab}` : agentUrl(agent);
  const editHref = `${agentUrl(agent)}/configuration`;
  const isActive = activeAgentId === routeRef;
  const isPaused = agent.status === "paused";
  const isBudgetPaused = isPaused && agent.pauseReason === "budget";
  const pauseResumeLabel = isPaused ? "Resume agent" : "Pause agent";
  const pauseResumeDisabled = disabled || agent.status === "pending_approval" || isBudgetPaused;
  const pauseResumeDisabledLabel = disabled
    ? "Updating..."
    : isBudgetPaused
      ? "Budget paused"
      : pauseResumeLabel;

  return (
    <div className="group/agent relative flex items-center">
      <NavLink
        to={href}
        state={SIDEBAR_SCROLL_RESET_STATE}
        onClick={() => {
          if (isMobile) setSidebarOpen(false);
        }}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors max-sm:min-h-11 max-sm:text-sm",
          // Room for the actions menu, plus the team chevron when there is one.
          teamToggle ? "pr-14 max-sm:pr-20" : "pr-8 max-sm:pr-14",
          isActive
            ? "bg-accent text-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground"
        )}
      >
        <AgentIcon icon={agent.icon} className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 truncate">{agent.name}</span>
        {(agent.pauseReason === "budget" || runCount > 0) && (
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            {agent.pauseReason === "budget" ? (
              <BudgetSidebarMarker title="Agent paused by budget" />
            ) : null}
            {runCount > 0 ? (
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
            ) : null}
            {runCount > 0 ? (
              <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
                {runCount} live
              </span>
            ) : null}
          </span>
        )}
      </NavLink>

      {teamToggle}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 transition-opacity data-[state=open]:pointer-events-auto data-[state=open]:opacity-100",
              isMobile
                ? "opacity-100"
                : "pointer-events-none opacity-0 group-hover/agent:pointer-events-auto group-hover/agent:opacity-100 group-focus-within/agent:pointer-events-auto group-focus-within/agent:opacity-100",
            )}
            aria-label={`Open actions for ${agent.name}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem asChild>
            <Link
              to={editHref}
              onClick={() => {
                if (isMobile) setSidebarOpen(false);
              }}
            >
              <Pencil className="size-4" />
              <span>Edit agent</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              if (pauseResumeDisabled) return;
              onPauseResume(agent, isPaused ? "resume" : "pause");
            }}
            disabled={pauseResumeDisabled}
            title={isBudgetPaused ? "Agent was paused by budget limits" : undefined}
          >
            {isPaused ? <PlayCircle className="size-4" /> : <PauseCircle className="size-4" />}
            <span>{pauseResumeDisabledLabel}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// AgentDash: the row data behind the agent list nested under Team
// (SidebarTeamItem) — one sidebar for every company (doc/plans/2026-09-30-one-ux.md).
export function useSidebarAgentRows() {
  const [pendingAgentIds, setPendingAgentIds] = useState<Set<string>>(() => new Set());
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { pushToast } = useToastActions();
  const location = useLocation();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);

  const visibleAgents = useMemo(() => {
    const filtered = (agents ?? []).filter(
      (a: Agent) => a.status !== "terminated"
    );
    return filtered;
  }, [agents]);
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedAgents } = useAgentOrder({
    agents: visibleAgents,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;

  const pauseResumeAgent = useMutation({
    mutationFn: ({ agent, action }: { agent: Agent; action: "pause" | "resume" }) =>
      action === "pause"
        ? agentsApi.pause(agent.id, selectedCompanyId ?? undefined)
        : agentsApi.resume(agent.id, selectedCompanyId ?? undefined),
    onMutate: ({ agent }) => {
      setPendingAgentIds((current) => {
        const next = new Set(current);
        next.add(agent.id);
        return next;
      });
    },
    onSuccess: async (_agent, { agent, action }) => {
      if (selectedCompanyId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(selectedCompanyId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) }),
        ]);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentRouteRef(agent)) }),
      ]);
      pushToast({
        title: action === "pause" ? "Agent paused" : "Agent resumed",
        body: agent.name,
        tone: "success",
      });
    },
    onError: (error, { agent, action }) => {
      pushToast({
        title: action === "pause" ? "Could not pause agent" : "Could not resume agent",
        body: error instanceof Error ? error.message : agent.name,
        tone: "error",
      });
    },
    onSettled: (_data, _error, { agent }) => {
      setPendingAgentIds((current) => {
        const next = new Set(current);
        next.delete(agent.id);
        return next;
      });
    },
  });

  return {
    activeAgentId,
    activeTab,
    companyId: selectedCompanyId ?? null,
    currentUserId,
    isMobile,
    liveCountByAgent,
    orderedAgents,
    pendingAgentIds,
    pauseResume: (agent: Agent, action: "pause" | "resume") =>
      pauseResumeAgent.mutate({ agent, action }),
    setSidebarOpen,
  };
}

export type SidebarAgentRowsState = ReturnType<typeof useSidebarAgentRows>;

function renderAgentItem(agent: Agent, rows: SidebarAgentRowsState, teamToggle?: ReactNode) {
  return (
    <SidebarAgentItem
      key={agent.id}
      activeAgentId={rows.activeAgentId}
      activeTab={rows.activeTab}
      agent={agent}
      disabled={rows.pendingAgentIds.has(agent.id)}
      isMobile={rows.isMobile}
      onPauseResume={rows.pauseResume}
      runCount={rows.liveCountByAgent.get(agent.id) ?? 0}
      setSidebarOpen={rows.setSidebarOpen}
      teamToggle={teamToggle}
    />
  );
}

// AgentDash: one team — a lead with direct reports. The lead's row stays a
// normal agent link; the chevron beside it shows or hides the reports, and
// that choice is remembered per user per company per lead. Expanded by default.
function teamContainsRouteRef(node: SidebarAgentTreeNode<Agent>, routeRef: string): boolean {
  return node.children.some(
    (child) => agentRouteRef(child.agent) === routeRef || teamContainsRouteRef(child, routeRef),
  );
}

function SidebarTeamGroup({
  node,
  rows,
}: {
  node: SidebarAgentTreeNode<Agent>;
  rows: SidebarAgentRowsState;
}) {
  const lead = node.agent;
  const storageKey = rows.companyId
    ? getSidebarTeamGroupStorageKey(rows.companyId, rows.currentUserId, lead.id)
    : null;
  const [expanded, setExpanded] = useState(() => readSidebarTeamGroupExpanded(storageKey));

  // The user id arrives with the session query, so the key can change after
  // mount; re-read so the remembered state follows the right user/company.
  useEffect(() => {
    setExpanded(readSidebarTeamGroupExpanded(storageKey));
  }, [storageKey]);

  // The agent being viewed is never hidden: a collapsed team that contains it
  // shows open (without changing the remembered choice).
  const containsActive = useMemo(
    () => rows.activeAgentId !== null && teamContainsRouteRef(node, rows.activeAgentId),
    [node, rows.activeAgentId],
  );
  const open = expanded || containsActive;

  const toggle = (
    <CollapsibleTrigger
      aria-label={open ? `Hide ${lead.name}'s team` : `Show ${lead.name}'s team`}
      className="absolute right-7 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:right-8 max-sm:h-11 max-sm:w-11"
    >
      <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
    </CollapsibleTrigger>
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setExpanded(next);
        writeSidebarTeamGroupExpanded(storageKey, next);
      }}
    >
      {renderAgentItem(lead, rows, toggle)}
      <CollapsibleContent
        data-sidebar-team-group={lead.id}
        className="ml-3 flex min-w-0 flex-col gap-0.5 border-l border-border pl-1.5 mt-0.5"
      >
        <SidebarAgentTreeRows nodes={node.children} rows={rows} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function SidebarAgentTreeRows({
  nodes,
  rows,
}: {
  nodes: SidebarAgentTreeNode<Agent>[];
  rows: SidebarAgentRowsState;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.children.length > 0 ? (
          <SidebarTeamGroup key={node.agent.id} node={node} rows={rows} />
        ) : (
          renderAgentItem(node.agent, rows)
        ),
      )}
    </>
  );
}

// AgentDash: the agent list under Team, grouped by reporting line — a lead
// with reports heads a collapsible group; agents with no manager in the list
// and no reports are plain top-level rows. Order within each level follows
// useAgentOrder; indentation stops at two levels (lib/sidebar-agent-teams).
export function SidebarAgentRows(rows: SidebarAgentRowsState) {
  const tree = useMemo(() => buildSidebarAgentTree(rows.orderedAgents), [rows.orderedAgents]);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 mt-0.5">
      <SidebarAgentTreeRows nodes={tree} rows={rows} />
    </div>
  );
}
