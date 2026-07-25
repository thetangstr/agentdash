import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Send,
  Receipt,
  LifeBuoy,
  PenLine,
  TrendingUp,
  Mail,
  BadgeDollarSign,
  Copy,
  Check,
  Bot,
  CircleAlert,
  CirclePause,
  CircleCheck,
  type LucideIcon,
} from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { dashboardApi } from "../api/dashboard";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { ApiError } from "../api/client";

// AgentDash: "Porcelain" Overview — the agent control-plane home screen.
// Live data version: fetches real company dashboard, agents, and approvals.

const EASE = "cubic-bezier(0.22,1,0.36,1)";
const GREEN = "var(--success-500)";
const AMBER = "var(--warn-500)";
const CLAY = "var(--accent-500)";

function getReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ------------------------------------------------------------------ hooks */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(getReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    setReduced(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function useCountUp(target: number, delay: number, reduced: boolean): number {
  const [value, setValue] = useState<number>(reduced ? target : 0);
  useEffect(() => {
    if (reduced) {
      setValue(target);
      return;
    }
    let raf = 0;
    let start = 0;
    let cancelled = false;
    const tick = (ts: number) => {
      if (cancelled) return;
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / 1000);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setValue(target);
    };
    const timer = window.setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [target, delay, reduced]);
  return value;
}

/* ------------------------------------------------------- motion primitives */

function Reveal({
  index,
  reduced,
  children,
  className,
  style,
}: {
  index: number;
  reduced: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const [shown, setShown] = useState<boolean>(reduced);
  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const t = window.setTimeout(() => setShown(true), index * 52);
    return () => window.clearTimeout(t);
  }, [reduced, index]);
  return (
    <div
      className={className}
      style={{
        ...style,
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(12px)",
        transition: reduced ? undefined : `opacity 480ms ${EASE}, transform 480ms ${EASE}`,
        willChange: reduced ? undefined : "opacity, transform",
      }}
    >
      {children}
    </div>
  );
}

function PopNumber({ value, reduced }: { value: number; reduced: boolean }) {
  const [popKey, setPopKey] = useState(0);
  const prev = useRef(value);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      prev.current = value;
      return;
    }
    if (prev.current === value) return;
    prev.current = value;
    if (!reduced) setPopKey((k) => k + 1);
  }, [value, reduced]);
  return (
    <span
      key={popKey}
      className={!reduced && popKey > 0 ? "pcl-pop-anim" : undefined}
      style={{ display: "inline-block" }}
    >
      {value}
    </span>
  );
}

function AwaitingNumber({ count, reduced }: { count: number; reduced: boolean }) {
  const [display, setDisplay] = useState<number>(reduced ? count : 0);
  const [popKey, setPopKey] = useState(0);
  const entranceDone = useRef(false);
  const prev = useRef(count);

  useEffect(() => {
    if (reduced) {
      setDisplay(count);
      entranceDone.current = true;
      return;
    }
    const target = count;
    let raf = 0;
    let start = 0;
    let cancelled = false;
    const tick = (ts: number) => {
      if (cancelled) return;
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / 1000);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else {
        setDisplay(target);
        entranceDone.current = true;
      }
    };
    const timer = window.setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (prev.current === count) return;
    prev.current = count;
    if (!entranceDone.current) return;
    setDisplay(count);
    if (!reduced) setPopKey((k) => k + 1);
  }, [count, reduced]);

  return (
    <span
      key={popKey}
      className={!reduced && popKey > 0 ? "pcl-pop-anim" : undefined}
      style={{ display: "inline-block" }}
    >
      {display}
    </span>
  );
}

function Meter({
  pct,
  color,
  delay,
  height,
  reduced,
}: {
  pct: number;
  color: string;
  delay: number;
  height: number;
  reduced: boolean;
}) {
  const [w, setW] = useState<number>(reduced ? pct : 0);
  useEffect(() => {
    if (reduced) {
      setW(pct);
      return;
    }
    const t = window.setTimeout(() => setW(pct), delay);
    return () => window.clearTimeout(t);
  }, [pct, delay, reduced]);
  return (
    <div
      className="bg-secondary"
      style={{ height, borderRadius: 999, overflow: "hidden", width: "100%" }}
    >
      <div
        style={{
          width: `${w}%`,
          height: "100%",
          background: color,
          borderRadius: 999,
          transition: reduced ? undefined : `width 1000ms ${EASE}`,
        }}
      />
    </div>
  );
}

function StatusDot({
  color,
  pulse,
  reduced,
  size = 8,
}: {
  color: string;
  pulse: boolean;
  reduced: boolean;
  size?: number;
}) {
  return (
    <span
      className={pulse && !reduced ? "pcl-pulse-dot" : undefined}
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        display: "inline-block",
        flex: "none",
      }}
    />
  );
}

/* --------------------------------------------------------------- data types */

type LiveAgent = {
  id: string;
  name: string;
  icon: LucideIcon;
  category: string;
  statusLine: string;
  statusWord: string;
  statusColor: string;
  dotColor: string;
  pulse: boolean;
  pct: number;
  fillColor: string;
  timing: string;
};

type ApprovalStatus = "pending" | "resolving" | "collapsing";

type Resolution = { label: string; tone: "success" | "muted" };

type LiveApproval = {
  id: string;
  card: boolean;
  status: ApprovalStatus;
  eyebrowIcon?: LucideIcon;
  eyebrowText?: string;
  eyebrowClay?: boolean;
  clayBorder?: boolean;
  title?: string;
  body?: ReactNode;
  primaryLabel?: string;
  secondaryLabel?: string;
  primaryResolution?: Resolution;
  resolution?: Resolution;
};

/* ----------------------------------------------------------------- helpers */

const AGENT_ICONS: Record<string, LucideIcon> = {
  engineer: PenLine,
  engineering_lead: PenLine,
  cmo: Send,
  marketing: Send,
  sales: BadgeDollarSign,
  general: Bot,
  support: LifeBuoy,
  chief_of_staff: Bot,
  ceo: Bot,
  default: Bot,
};

function agentIcon(role: string): LucideIcon {
  return AGENT_ICONS[role] ?? AGENT_ICONS.default;
}

function agentStatusDisplay(status: string): {
  word: string;
  color: string;
  pulse: boolean;
} {
  switch (status) {
    case "running":
      return { word: "running", color: GREEN, pulse: true };
    case "error":
      return { word: "error", color: AMBER, pulse: false };
    case "paused":
      return { word: "paused", color: AMBER, pulse: false };
    case "idle":
      return { word: "idle", color: "var(--muted-foreground)", pulse: false };
    default:
      return { word: status, color: "var(--muted-foreground)", pulse: false };
  }
}

const APPROVAL_ICONS: Record<string, LucideIcon> = {
  hire_agent: Bot,
  approve_ceo_strategy: TrendingUp,
  budget_override_required: BadgeDollarSign,
  request_board_approval: Mail,
};

function approvalIcon(type: string): LucideIcon {
  return APPROVAL_ICONS[type] ?? Mail;
}

function approvalTypeLabel(type: string): string {
  switch (type) {
    case "hire_agent":
      return "hire request";
    case "approve_ceo_strategy":
      return "strategy review";
    case "budget_override_required":
      return "budget override";
    case "request_board_approval":
      return "board approval";
    default:
      return type;
  }
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "good morning";
  if (h < 18) return "good afternoon";
  return "good evening";
}

function todayLabel(): string {
  return new Date()
    .toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    })
    .toLowerCase();
}

function budgetPct(budgetCents: number, spendCents: number): number {
  if (budgetCents <= 0) return 0;
  return Math.min(100, Math.round((spendCents / budgetCents) * 100));
}

/* --------------------------------------------------------------- subviews */

function StatCard({
  eyebrow,
  big,
  delta,
}: {
  eyebrow: string;
  big: ReactNode;
  delta: ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl" style={{ padding: 18 }}>
      <div
        className="text-muted-foreground"
        style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}
      >
        {eyebrow}
      </div>
      <div
        className="text-foreground"
        style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.05, marginTop: 8 }}
      >
        {big}
      </div>
      <div style={{ marginTop: 8, fontSize: 12.5 }}>{delta}</div>
    </div>
  );
}

function AgentTile({ agent, meterDelay, reduced }: { agent: LiveAgent; meterDelay: number; reduced: boolean }) {
  const Icon = agent.icon;
  return (
    <Link
      to={`/agents/${agent.id}`}
      className="bg-card border border-border rounded-2xl hover:border-border-strong block"
      style={{
        padding: 16,
        transition: reduced
          ? undefined
          : `transform 200ms ${EASE}, box-shadow 200ms ${EASE}, border-color 200ms ${EASE}`,
      }}
      onMouseEnter={(e) => {
        if (reduced) return;
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 6px 16px -8px rgba(0,0,0,0.13)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      {/* header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          className="bg-secondary"
          style={{
            width: 38,
            height: 38,
            borderRadius: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "none",
          }}
        >
          <Icon size={18} className="text-foreground" />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="text-foreground" style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.2 }}>
            {agent.name}
          </div>
          <div className="text-muted-foreground" style={{ fontSize: 11.5 }}>
            {agent.category}
          </div>
        </div>
        <StatusDot color={agent.dotColor} pulse={agent.pulse} reduced={reduced} />
      </div>

      {/* status line */}
      <div
        className="text-text-secondary"
        style={{ fontSize: 13, lineHeight: 1.35, minHeight: 38, marginTop: 12 }}
      >
        {agent.statusLine}
      </div>

      {/* progress */}
      <div style={{ marginTop: 10 }}>
        <Meter pct={agent.pct} color={agent.fillColor} delay={meterDelay} height={4} reduced={reduced} />
      </div>

      {/* footer */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: agent.statusColor }}>{agent.statusWord}</span>
        <span className="text-muted-foreground" style={{ fontSize: 12.5 }}>
          {agent.timing}
        </span>
      </div>
    </Link>
  );
}

function PressButton({
  children,
  onClick,
  variant,
  className,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant: "dark" | "hairline";
  className?: string;
  style?: CSSProperties;
}) {
  const base =
    variant === "dark"
      ? "bg-foreground text-background"
      : "bg-card text-foreground border border-border hover:border-border-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`active:scale-[0.96] ${base} ${className ?? ""}`}
      style={{
        borderRadius: 999,
        padding: "9px 14px",
        fontSize: 12.5,
        fontWeight: 600,
        transition: `transform 120ms ${EASE}, border-color 120ms ${EASE}, background-color 120ms ${EASE}`,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function ApprovalCard({
  approval,
  reduced,
  onResolve,
}: {
  approval: LiveApproval;
  reduced: boolean;
  onResolve: (id: string, resolution: Resolution) => void;
}) {
  const EyebrowIcon = approval.eyebrowIcon;
  const resolved = approval.status !== "pending";
  const collapsing = approval.status === "collapsing";

  return (
    <div
      style={{
        maxHeight: collapsing ? 0 : 600,
        opacity: collapsing ? 0 : 1,
        overflow: "hidden",
        transition: reduced ? undefined : `max-height 440ms ${EASE}, opacity 440ms ${EASE}`,
      }}
    >
      <div
        className="bg-card border border-border"
        style={{
          borderRadius: 14,
          padding: 15,
          borderLeft: approval.clayBorder ? `3px solid ${CLAY}` : undefined,
        }}
      >
        {/* eyebrow */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {EyebrowIcon ? (
            <EyebrowIcon
              size={13}
              style={{ color: approval.eyebrowClay ? CLAY : "var(--muted-foreground)" }}
            />
          ) : null}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: approval.eyebrowClay ? CLAY : "var(--muted-foreground)",
            }}
          >
            {approval.eyebrowText}
          </span>
        </div>

        {/* title */}
        <div className="text-foreground" style={{ fontSize: 13.5, fontWeight: 700, marginTop: 8 }}>
          {approval.title}
        </div>

        {/* body */}
        {approval.body ? (
          <div
            className="text-muted-foreground"
            style={{ fontSize: 12.5, lineHeight: 1.45, marginTop: 6 }}
          >
            {approval.body}
          </div>
        ) : null}

        {/* action row OR confirmation */}
        <div style={{ marginTop: 14 }}>
          {resolved && approval.resolution ? (
            <div
              className="pcl-confirm"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                minHeight: 38,
              }}
            >
              <Check
                size={15}
                style={{
                  color: approval.resolution.tone === "success" ? GREEN : "var(--muted-foreground)",
                }}
              />
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: approval.resolution.tone === "success" ? GREEN : "var(--muted-foreground)",
                }}
              >
                {approval.resolution.label}
              </span>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <PressButton
                variant="dark"
                style={{ flex: 1 }}
                onClick={() =>
                  approval.primaryResolution && onResolve(approval.id, approval.primaryResolution)
                }
              >
                {approval.primaryLabel}
              </PressButton>
              <PressButton
                variant="hairline"
                onClick={() => {
                  if (approval.secondaryLabel === "deny" || approval.secondaryLabel === "reject") {
                    onResolve(approval.id, { label: "declined", tone: "muted" });
                  }
                }}
              >
                {approval.secondaryLabel}
              </PressButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- loading / empty */

function LoadingDashboard() {
  return (
    <div className="flex items-center justify-center" style={{ minHeight: 300 }}>
      <div className="text-muted-foreground text-sm">Loading dashboard…</div>
    </div>
  );
}

function ErrorDashboard({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center" style={{ minHeight: 300 }}>
      <div className="text-destructive text-sm">{message}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- page */

export function Overview() {
  const reduced = usePrefersReducedMotion();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const [approvals, setApprovals] = useState<LiveApproval[]>([]);
  const resolvingIds = useRef<Set<string>>(new Set());

  // Fetch real dashboard data
  const { data: dashboard, isLoading: dashLoading, error: dashError } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Fetch real agents
  const { data: rawAgents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Fetch pending approvals
  const { data: rawApprovals } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  // Sync approvals from API → local state (for resolve animations)
  useEffect(() => {
    if (!rawApprovals) return;
    const next: LiveApproval[] = rawApprovals.slice(0, 3).map((a) => {
      const Icon = approvalIcon(a.type);
      const payload = a.payload as Record<string, unknown> | null;
      const agentName =
        typeof payload?.name === "string" ? payload.name :
        typeof payload?.role === "string" ? String(payload.role) : "";
      return {
        id: a.id,
        card: true,
        status: "pending" as ApprovalStatus,
        eyebrowIcon: Icon,
        eyebrowText: `${approvalTypeLabel(a.type)}${agentName ? ` · ${agentName}` : ""}`,
        eyebrowClay: a.type === "hire_agent",
        clayBorder: a.type === "hire_agent",
        title: a.type === "hire_agent" && agentName
          ? `hire ${agentName}`
          : a.type === "approve_ceo_strategy"
            ? "CEO strategy proposal"
            : approvalTypeLabel(a.type),
        body: a.decisionNote ?? undefined,
        primaryLabel: "approve",
        secondaryLabel: "reject",
        primaryResolution: { label: "approved", tone: "success" as const },
      };
    });
    setApprovals(next);
  }, [rawApprovals]);

  // Dashboard stats (read before early returns so hooks stay unconditional)
  // AgentDash: use the actual agent list as source of truth for count when
  // the dashboard API hasn't caught up yet (race after agent creation).
  const agentsActive = Math.max(
    dashboard?.agents?.active ?? 0,
    rawAgents?.length ?? 0
  );
  const agentsRunning = dashboard?.agents?.running ?? 0;
  const tasksDone = dashboard?.tasks?.done ?? 0;
  const tasksOpen = dashboard?.tasks?.open ?? 0;
  const tasksInProgress = dashboard?.tasks?.inProgress ?? 0;
  const pendingApprovals = dashboard?.pendingApprovals ?? 0;
  const monthSpend = dashboard?.costs?.monthSpendCents ?? 0;
  const monthBudget = dashboard?.costs?.monthBudgetCents ?? 0;
  const utilPct = budgetPct(monthBudget, monthSpend);

  // Hooks MUST be called before any early return
  const animatedAgents = useCountUp(agentsActive, 0, reduced);
  const animatedTasks = useCountUp(tasksOpen + tasksInProgress + tasksDone, 70, reduced);

  if (!selectedCompanyId) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: 300 }}>
        <div className="text-muted-foreground text-sm">Select a company to view its dashboard.</div>
      </div>
    );
  }

  if (dashLoading && !dashboard) return <LoadingDashboard />;
  if (dashError) {
    const msg = dashError instanceof ApiError ? `Error ${dashError.status}: ${dashError.message}` : "Failed to load dashboard data.";
    return <ErrorDashboard message={msg} />;
  }

  // Build live agent tiles
  const agentList = (rawAgents ?? []).filter(
    (a) => a.status !== "terminated",
  );
  const liveAgents: LiveAgent[] = agentList.slice(0, 6).map((a) => {
    const st = agentStatusDisplay(a.status);
    return {
      id: a.id,
      name: a.name,
      icon: agentIcon(a.role),
      category: a.role?.replace(/_/g, " ") ?? "agent",
      statusLine: a.status === "running" ? "working on a task…" : a.status === "idle" ? "idle — waiting for work" : `${a.status}`,
      statusWord: st.word,
      statusColor: st.color,
      dotColor: st.color,
      pulse: st.pulse,
      pct: a.status === "running" ? 50 : a.status === "idle" ? 0 : 30,
      fillColor: st.color,
      timing: a.lastHeartbeatAt
        ? `${new Date(a.lastHeartbeatAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
        : "—",
    };
  });

  const awaitingCount = pendingApprovals;
  const visibleCards = approvals.filter((a) => a.card && a.status === "pending");
  const extraPending = Math.max(0, pendingApprovals - visibleCards.length);

  function resolveApproval(id: string, resolution: Resolution) {
    if (resolvingIds.current.has(id)) return;
    resolvingIds.current.add(id);

    // Optimistic UI update
    setApprovals((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: "resolving", resolution } : a)),
    );
    window.setTimeout(
      () => {
        setApprovals((prev) => prev.map((a) => (a.id === id ? { ...a, status: "collapsing" } : a)));
      },
      reduced ? 400 : 720,
    );
    window.setTimeout(
      () => {
        setApprovals((prev) => prev.filter((a) => a.id !== id));
      },
      reduced ? 440 : 720 + 440,
    );

    // Fire real API call
    if (resolution.tone === "success") {
      approvalsApi.approve(id).catch(() => {});
    } else {
      approvalsApi.reject(id).catch(() => {});
    }
  }

  // reveal index counter
  let idx = 0;
  const next = () => idx++;

  const companyName = selectedCompany?.name ?? "your company";

  return (
    <div className="mx-auto w-full max-w-[1080px]" style={{ padding: "32px 28px 80px" }}>
      {/* scoped keyframes */}
      <style>{`
        @keyframes pcl-pop { from { transform: scale(1.4); } to { transform: scale(1); } }
        @keyframes pcl-dot-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(22,163,74,0.45); }
          70%  { box-shadow: 0 0 0 5px rgba(22,163,74,0); }
          100% { box-shadow: 0 0 0 0 rgba(22,163,74,0); }
        }
        .pcl-pop-anim { animation: pcl-pop 320ms ${EASE}; }
        .pcl-pulse-dot { animation: pcl-dot-pulse 1.8s ${EASE} infinite; }
        .pcl-confirm { animation: pcl-fade 220ms ${EASE}; }
        @keyframes pcl-fade { from { opacity: 0; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .pcl-pop-anim, .pcl-pulse-dot, .pcl-confirm { animation: none !important; }
        }
      `}</style>

      {/* 1. PAGE HEAD */}
      <Reveal index={next()} reduced={reduced}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div
              className="text-muted-foreground"
              style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}
            >
              {todayLabel()}
            </div>
            <h1
              className="text-foreground"
              style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.05, marginTop: 8 }}
            >
              {greeting()}, board
            </h1>
            <p className="text-muted-foreground" style={{ fontSize: 15, marginTop: 8 }}>
              {companyName} · {agentsActive} agent{agentsActive !== 1 ? "s" : ""} · {tasksOpen} open task{tasksOpen !== 1 ? "s" : ""}
              {pendingApprovals > 0 ? ` · ${pendingApprovals} awaiting your call` : ""}
            </p>
          </div>
          <div
            className="bg-card border border-border"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              borderRadius: 999,
              padding: "6px 12px",
              flex: "none",
            }}
          >
            <StatusDot color={GREEN} pulse reduced={reduced} />
            <span style={{ fontSize: 12, fontWeight: 700, color: GREEN }}>
              {agentsRunning > 0 ? `${agentsRunning} running` : "all idle"}
            </span>
          </div>
        </div>
      </Reveal>

      {/* 2. STAT ROW */}
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: 12, marginTop: 28 }}>
        <Reveal index={next()} reduced={reduced}>
          <StatCard
            eyebrow="agents"
            big={<PopNumber value={animatedAgents} reduced={reduced} />}
            delta={
              <span className="text-muted-foreground">
                {agentsRunning} running · {dashboard?.agents?.paused ?? 0} paused
              </span>
            }
          />
        </Reveal>
        <Reveal index={next()} reduced={reduced}>
          <StatCard
            eyebrow="open tasks"
            big={<PopNumber value={animatedTasks} reduced={reduced} />}
            delta={
              <span className="text-muted-foreground">
                {tasksInProgress} in progress · {tasksDone} done
              </span>
            }
          />
        </Reveal>
        <Reveal index={next()} reduced={reduced}>
          <StatCard
            eyebrow="awaiting you"
            big={<AwaitingNumber count={awaitingCount} reduced={reduced} />}
            delta={
              pendingApprovals > 0 ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: CLAY, fontWeight: 600 }}>
                  <StatusDot color={CLAY} pulse={false} reduced={reduced} size={7} />
                  needs review
                </span>
              ) : (
                <span className="text-muted-foreground">all clear</span>
              )
            }
          />
        </Reveal>
        <Reveal index={next()} reduced={reduced}>
          <StatCard
            eyebrow="spend this month"
            big={
              monthBudget > 0 ? (
                <span>
                  ${(monthSpend / 100).toFixed(2)}
                  <span className="text-muted-foreground" style={{ fontSize: 18, fontWeight: 700 }}>
                    {" "}/ ${(monthBudget / 100).toFixed(0)}
                  </span>
                </span>
              ) : (
                <span>${(monthSpend / 100).toFixed(2)}</span>
              )
            }
            delta={
              monthBudget > 0 ? (
                <span className="text-muted-foreground">{utilPct}% of budget</span>
              ) : (
                <span className="text-muted-foreground">unlimited budget</span>
              )
            }
          />
        </Reveal>
      </div>

      {/* 3. TWO-COLUMN GRID */}
      <div
        className="grid grid-cols-1 lg:grid-cols-[1fr_360px] items-start"
        style={{ gap: 14, marginTop: 28 }}
      >
        {/* LEFT — agent fleet */}
        <div>
          <Reveal index={next()} reduced={reduced}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 className="text-foreground" style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>
                agent fleet
              </h2>
              {agentList.length > 0 && (
                <Link
                  to="/agents/all"
                  style={{ fontSize: 12.5, fontWeight: 600, color: CLAY }}
                  className="hover:underline"
                >
                  view all {agentList.length} →
                </Link>
              )}
            </div>
          </Reveal>

          {liveAgents.length === 0 ? (
            <Reveal index={next()} reduced={reduced}>
              <div className="bg-card border border-border rounded-2xl" style={{ padding: 32, textAlign: "center" }}>
                <p className="text-muted-foreground text-sm">
                  No agents yet.{" "}
                  <Link to="/agents/new" style={{ color: CLAY, fontWeight: 600 }}>
                    Hire your first agent →
                  </Link>
                </p>
              </div>
            </Reveal>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 12 }}>
              {liveAgents.map((agent, i) => (
                <Reveal key={agent.id} index={next()} reduced={reduced}>
                  <AgentTile agent={agent} meterDelay={i * 80} reduced={reduced} />
                </Reveal>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT — needs your call */}
        <div>
          <Reveal index={next()} reduced={reduced}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <h2 className="text-foreground" style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>
                needs your call
              </h2>
              {pendingApprovals > 0 && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minWidth: 22,
                    height: 22,
                    padding: "0 7px",
                    borderRadius: 999,
                    background: CLAY,
                    color: "var(--text-inverse)",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  <PopNumber value={awaitingCount} reduced={reduced} />
                </span>
              )}
            </div>
          </Reveal>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {visibleCards.map((approval) => (
              <Reveal key={approval.id} index={next()} reduced={reduced}>
                <ApprovalCard approval={approval} reduced={reduced} onResolve={resolveApproval} />
              </Reveal>
            ))}

            {visibleCards.length === 0 && pendingApprovals === 0 ? (
              <Reveal index={next()} reduced={reduced}>
                <div className="bg-card border border-border rounded-2xl" style={{ padding: 24, textAlign: "center" }}>
                  <CircleCheck size={24} style={{ color: GREEN, margin: "0 auto 8px" }} />
                  <p className="text-muted-foreground text-sm">Nothing waiting on you.</p>
                </div>
              </Reveal>
            ) : null}

            {extraPending > 0 ? (
              <Reveal index={next()} reduced={reduced}>
                <div style={{ textAlign: "center" }}>
                  <Link
                    to="/approvals"
                    className="text-muted-foreground hover:text-foreground"
                    style={{ fontSize: 12.5, transition: `color 120ms ${EASE}` }}
                  >
                    + {extraPending} more in approvals
                  </Link>
                </div>
              </Reveal>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Overview;
