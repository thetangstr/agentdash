import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  type LucideIcon,
} from "lucide-react";

// AgentDash: "Porcelain" Overview — the agent control-plane home screen.
// Founder-to-founder voice (all lowercase). Motion is CSS-only (no framer-motion)
// and every animation no-ops under prefers-reduced-motion. Demo data is inline.

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

// Count-up for the STATIC stat numbers (constant targets).
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

// Fade-in + rise on mount, staggered by index. Steady state is opacity:1 via
// React state (not CSS fill-mode), so it can never stall hidden.
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

// A number that scale-pops (1.4 -> 1) whenever its value changes.
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

// "awaiting you" stat: counts up 0->target on mount, then scale-pops on each
// later change (so the entrance tween and the resolve-pop don't fight).
function AwaitingNumber({ count, reduced }: { count: number; reduced: boolean }) {
  const [display, setDisplay] = useState<number>(reduced ? count : 0);
  const [popKey, setPopKey] = useState(0);
  const entranceDone = useRef(false);
  const prev = useRef(count);

  // entrance count-up (mount only)
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

  // later changes -> snap + pop
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

// A progress / meter bar that animates width 0 -> pct.
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

type Agent = {
  id: string;
  name: string;
  icon: LucideIcon;
  category: string;
  statusLine: string;
  statusWord: string;
  statusColor: string; // word color
  dotColor: string;
  pulse: boolean;
  pct: number;
  fillColor: string;
  timing: string;
};

type ApprovalStatus = "pending" | "resolving" | "collapsing";

type Resolution = { label: string; tone: "success" | "muted" };

type Approval = {
  id: string;
  card: boolean;
  status: ApprovalStatus;
  // card-only fields
  eyebrowIcon?: LucideIcon;
  eyebrowText?: string;
  eyebrowClay?: boolean;
  clayBorder?: boolean;
  title?: string;
  body?: ReactNode;
  voiceMatch?: number;
  primaryLabel?: string;
  secondaryLabel?: string;
  primaryResolution?: Resolution;
  resolution?: Resolution;
};

const INITIAL_AGENTS: Agent[] = [
  {
    id: "scout",
    name: "scout",
    icon: Send,
    category: "outbound · gtm",
    statusLine: "drafting outreach to 12 logistics saas leads",
    statusWord: "running",
    statusColor: GREEN,
    dotColor: GREEN,
    pulse: true,
    pct: 70,
    fillColor: GREEN,
    timing: "ready in 3 min",
  },
  {
    id: "ledger",
    name: "ledger",
    icon: Receipt,
    category: "finance · ops",
    statusLine: "reconciling 48 stripe payouts against open invoices",
    statusWord: "running",
    statusColor: GREEN,
    dotColor: GREEN,
    pulse: true,
    pct: 62,
    fillColor: GREEN,
    timing: "62% done",
  },
  {
    id: "harbor",
    name: "harbor",
    icon: LifeBuoy,
    category: "support",
    statusLine: "paused — waiting on your reply to the refund policy question",
    statusWord: "needs you",
    statusColor: AMBER,
    dotColor: AMBER,
    pulse: false,
    pct: 45,
    fillColor: AMBER,
    timing: "idle 12 min",
  },
  {
    id: "quill",
    name: "quill",
    icon: PenLine,
    category: "content",
    statusLine: "writing the q1 logistics trends post — 2nd draft",
    statusWord: "running",
    statusColor: GREEN,
    dotColor: GREEN,
    pulse: true,
    pct: 35,
    fillColor: GREEN,
    timing: "ready in 8 min",
  },
];

const INITIAL_APPROVALS: Approval[] = [
  {
    id: "scout-draft",
    card: true,
    status: "pending",
    eyebrowIcon: Mail,
    eyebrowText: "draft reply · scout",
    eyebrowClay: true,
    clayBorder: true,
    title: "reply to acme corp re: pricing",
    body:
      "“thanks for the proposal — can you clarify the per-seat pricing for the 50+ tier before we move forward?”",
    voiceMatch: 94,
    primaryLabel: "approve & send",
    secondaryLabel: "edit",
    primaryResolution: { label: "sent", tone: "success" },
  },
  {
    id: "ledger-approval",
    card: true,
    status: "pending",
    eyebrowIcon: BadgeDollarSign,
    eyebrowText: "approval · ledger",
    eyebrowClay: false,
    clayBorder: false,
    title: "refund — globex, $1,240",
    body: "over the $1,000 auto-approve limit.",
    primaryLabel: "approve",
    secondaryLabel: "deny",
    primaryResolution: { label: "approved", tone: "success" },
  },
  // a third pending item that isn't surfaced as a card (the "+1 more" link).
  { id: "extra", card: false, status: "pending" },
];

const DEMO_URL = "northwind.agentdash.app";

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

function AgentTile({ agent, meterDelay, reduced }: { agent: Agent; meterDelay: number; reduced: boolean }) {
  const Icon = agent.icon;
  return (
    <div
      className={`bg-card border border-border rounded-2xl hover:border-border-strong ease-[${"cubic-bezier(0.22,1,0.36,1)"}]`}
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
    </div>
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
  approval: Approval;
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

        {/* voice match meter (card 1 only) */}
        {typeof approval.voiceMatch === "number" ? (
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <span className="text-muted-foreground" style={{ fontSize: 11.5, fontWeight: 600 }}>
                voice match
              </span>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: GREEN }}>
                {approval.voiceMatch}%
              </span>
            </div>
            <Meter pct={approval.voiceMatch} color={GREEN} delay={320} height={5} reduced={reduced} />
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
                  // "edit" is a no-op in the demo; "deny" resolves as declined.
                  if (approval.secondaryLabel === "deny") {
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

/* ---------------------------------------------------------------- page */

export function Overview() {
  const reduced = usePrefersReducedMotion();
  const [approvals, setApprovals] = useState<Approval[]>(INITIAL_APPROVALS);
  const [copied, setCopied] = useState(false);
  const resolvingIds = useRef<Set<string>>(new Set());
  const copyTimer = useRef<number | null>(null);

  // Single source of truth: pending approvals drive BOTH the "needs your call"
  // badge and the "awaiting you" stat, so they always agree.
  const awaitingCount = approvals.filter((a) => a.status === "pending").length;
  const visibleCards = approvals.filter((a) => a.card);
  const extraPending = approvals.filter((a) => a.status === "pending" && !a.card).length;

  // static stat count-ups
  const agentsActive = useCountUp(8, 0, reduced);
  const tasksDone = useCountUp(214, 70, reduced);
  const hoursSaved = useCountUp(47, 210, reduced);

  useEffect(() => {
    return () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, []);

  function resolveApproval(id: string, resolution: Resolution) {
    if (resolvingIds.current.has(id)) return; // guard double-resolve
    resolvingIds.current.add(id);

    setApprovals((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: "resolving", resolution } : a)),
    );
    // collapse after the confirmation has been seen
    window.setTimeout(
      () => {
        setApprovals((prev) => prev.map((a) => (a.id === id ? { ...a, status: "collapsing" } : a)));
      },
      reduced ? 400 : 720,
    );
    // remove after the collapse animation completes
    window.setTimeout(
      () => {
        setApprovals((prev) => prev.filter((a) => a.id !== id));
      },
      reduced ? 440 : 720 + 440,
    );
  }

  function handleCopy() {
    const url = `https://${DEMO_URL}`;
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url).catch(() => {});
    }
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  // reveal index counter for staggered entrance
  let idx = 0;
  const next = () => idx++;

  return (
    <div className="mx-auto w-full max-w-[1080px]" style={{ padding: "32px 28px 80px" }}>
      {/* scoped keyframes — all guarded under prefers-reduced-motion */}
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
              tuesday · march 18
            </div>
            <h1
              className="text-foreground"
              style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.05, marginTop: 8 }}
            >
              good morning, maya
            </h1>
            <p className="text-muted-foreground" style={{ fontSize: 15, marginTop: 8 }}>
              your fleet handled 214 tasks overnight. 3 things need a look.
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
            <span style={{ fontSize: 12, fontWeight: 700, color: GREEN }}>all systems live</span>
          </div>
        </div>
      </Reveal>

      {/* 2. STAT ROW */}
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: 12, marginTop: 28 }}>
        <Reveal index={next()} reduced={reduced}>
          <StatCard
            eyebrow="agents active"
            big={<PopNumber value={agentsActive} reduced={reduced} />}
            delta={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: GREEN, fontWeight: 600 }}>
                <TrendingUp size={13} />
                +2 this week
              </span>
            }
          />
        </Reveal>
        <Reveal index={next()} reduced={reduced}>
          <StatCard
            eyebrow="tasks done"
            big={<PopNumber value={tasksDone} reduced={reduced} />}
            delta={<span className="text-muted-foreground">past 24 hours</span>}
          />
        </Reveal>
        <Reveal index={next()} reduced={reduced}>
          <StatCard
            eyebrow="awaiting you"
            big={<AwaitingNumber count={awaitingCount} reduced={reduced} />}
            delta={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: CLAY, fontWeight: 600 }}>
                <StatusDot color={CLAY} pulse={false} reduced={reduced} size={7} />
                needs review
              </span>
            }
          />
        </Reveal>
        <Reveal index={next()} reduced={reduced}>
          <StatCard
            eyebrow="hours saved"
            big={
              <span>
                <PopNumber value={hoursSaved} reduced={reduced} />
                <span className="text-muted-foreground" style={{ fontSize: 18, fontWeight: 700 }}>
                  h
                </span>
              </span>
            }
            delta={<span className="text-muted-foreground">this week</span>}
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
              <button
                type="button"
                style={{ fontSize: 12.5, fontWeight: 600, color: CLAY }}
                className="hover:underline"
              >
                view all 8 →
              </button>
            </div>
          </Reveal>
          <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 12 }}>
            {INITIAL_AGENTS.map((agent, i) => (
              <Reveal key={agent.id} index={next()} reduced={reduced}>
                <AgentTile agent={agent} meterDelay={i * 80} reduced={reduced} />
              </Reveal>
            ))}
          </div>
        </div>

        {/* RIGHT — needs your call */}
        <div>
          <Reveal index={next()} reduced={reduced}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <h2 className="text-foreground" style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>
                needs your call
              </h2>
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
            </div>
          </Reveal>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {visibleCards.map((approval) => (
              <Reveal key={approval.id} index={next()} reduced={reduced}>
                <ApprovalCard approval={approval} reduced={reduced} onResolve={resolveApproval} />
              </Reveal>
            ))}

            {extraPending > 0 ? (
              <Reveal index={next()} reduced={reduced}>
                <div style={{ textAlign: "center" }}>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    style={{ fontSize: 12.5, transition: `color 120ms ${EASE}` }}
                  >
                    + {extraPending} more in approvals
                  </button>
                </div>
              </Reveal>
            ) : null}
          </div>
        </div>
      </div>

      {/* 4. FLOATING DEMO CHIP */}
      <div
        className="bg-foreground"
        style={{
          position: "fixed",
          bottom: 22,
          right: 26,
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderRadius: 999,
          padding: "9px 9px 9px 15px",
          boxShadow: "0 8px 24px -8px rgba(0,0,0,0.35)",
        }}
      >
        <StatusDot color={GREEN} pulse reduced={reduced} />
        <span className="text-background" style={{ fontSize: 12.5, fontWeight: 600 }}>
          {DEMO_URL}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="bg-background text-foreground active:scale-[0.96]"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            borderRadius: 999,
            padding: "4px 9px",
            fontSize: 11.5,
            fontWeight: 600,
            transition: `transform 120ms ${EASE}`,
          }}
        >
          {copied ? (
            <>
              <Check size={12} style={{ color: GREEN }} />
              <span style={{ color: GREEN }}>copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export default Overview;
