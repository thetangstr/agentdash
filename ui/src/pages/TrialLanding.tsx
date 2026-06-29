// AgentDash (Test Drive v2): the PUBLIC no-signup "autonomous company" trial.
//
// The whole story: the user describes their company in one line, a Chief of
// Staff asks 2-3 quick questions, then an autonomous company assembles itself —
// a tailored team of 3-4 agents appears on a live dashboard and each does a real
// first task, producing a real markdown deliverable. The wow is "an AI built my
// whole team and they're already working."
//
// States: LAND -> INTAKE (CoS questions) -> DESIGNING (POST /design) -> FLEET
// (assemble + run each agent) -> DELIVERABLE (modal). Plus a friendly EXHAUSTED
// takeover when the build itself runs out of credit.
//
// Routed at /trial OUTSIDE CloudAccessGate (see ui/src/App.tsx) — no sidebar, no
// auth, no company context. The trial token is the only credential; it lives in
// sessionStorage so a refresh resumes the built company + deliverables.
//
// The app shell sets `body { overflow: hidden }`, so this full-screen public
// page owns its OWN scroll region: the top-level wrapper is `h-screen
// overflow-y-auto` so every state (especially the long fleet + deliverables)
// scrolls properly.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  ArrowLeft,
  BadgeDollarSign,
  BarChart3,
  Bot,
  Briefcase,
  Calendar,
  Check,
  Code2,
  Copy,
  LifeBuoy,
  Loader2,
  Mail,
  Megaphone,
  Package,
  PenLine,
  Receipt,
  Scale,
  Search,
  Send,
  Share2,
  Rocket,
  ShoppingBag,
  Sparkles,
  Store,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Link } from "@/lib/router";

// Starting-point templates: one click pre-fills the intake (what you do + goal +
// blocker) and jumps to the CoS questions, where the visitor can tweak before
// building. Each is written to produce a distinctly different company.
type TrialTemplate = {
  id: string;
  label: string;
  icon: LucideIcon;
  blurb: string;
  intake: { whatYouDo: string; goal: string; blocker: string };
};

const TRIAL_TEMPLATES: TrialTemplate[] = [
  {
    id: "b2b_saas",
    label: "B2B SaaS startup",
    icon: Rocket,
    blurb: "fintech platform for mid-market finance teams",
    intake: {
      whatYouDo:
        "we're a 20-person B2B SaaS company selling a fintech reconciliation platform to mid-market finance teams",
      goal: "book 30 qualified demos and close 8 new logos this quarter",
      blocker: "our 2 SDRs can't cover the list and the founders are still running every demo",
    },
  },
  {
    id: "dtc_ecom",
    label: "DTC e-commerce brand",
    icon: ShoppingBag,
    blurb: "$2M/yr skincare brand on Shopify + Meta",
    intake: {
      whatYouDo:
        "we're a direct-to-consumer skincare brand doing about $2M a year, mostly through Shopify and Meta ads",
      goal: "reach $3.5M this year by lifting repeat-purchase rate and lowering blended CAC",
      blocker: "ad costs keep climbing and we have no real retention, email, or SMS program",
    },
  },
  {
    id: "agency",
    label: "Marketing agency",
    icon: Megaphone,
    blurb: "12-person performance agency for consumer brands",
    intake: {
      whatYouDo: "we run a 12-person performance-marketing agency for DTC and consumer brands",
      goal: "sign 5 new retainer clients at $10k+/mo this quarter without hurting delivery",
      blocker: "the founders do all the sales and the team is already maxed on client work",
    },
  },
  {
    id: "recruiting",
    label: "Recruiting firm",
    icon: Users,
    blurb: "boutique tech recruiting for Series A-C startups",
    intake: {
      whatYouDo:
        "we're a boutique recruiting firm placing engineers and product managers at Series A-C startups",
      goal: "fill 12 open roles and win 4 new client accounts this quarter",
      blocker:
        "sourcing is all manual, candidate follow-up slips, and new-business outreach is inconsistent",
    },
  },
  {
    id: "advisory",
    label: "Accounting / advisory",
    icon: Briefcase,
    blurb: "15-person accounting + fractional-CFO firm",
    intake: {
      whatYouDo:
        "we're a 15-person accounting and fractional-CFO firm serving small businesses and startups",
      goal: "add 20 monthly-retainer clients before tax season and cut churn",
      blocker:
        "the partners spend all their time on delivery, so marketing and client onboarding fall through the cracks",
    },
  },
  {
    id: "local_services",
    label: "Local services",
    icon: Store,
    blurb: "3-location med spa (injectables, facials, laser)",
    intake: {
      whatYouDo: "we own three med spa locations offering injectables, facials, and laser treatments",
      goal: "book the calendar out three weeks ahead and grow membership signups 40%",
      blocker:
        "the front desk can't keep up with leads, and no-shows and lapsed clients eat into revenue",
    },
  },
];
import { ApiError } from "../api/client";
import {
  trialApi,
  type TrialCompanyMeta,
  type TrialIntake,
} from "../api/trial";
import {
  clearTrialStorage,
  readPersistedState,
  readStoredToken,
  writePersistedState,
  writeStoredToken,
} from "../lib/trial-storage";
import { MarkdownBody } from "../components/MarkdownBody";

type View = "land" | "intake" | "designing" | "fleet" | "exhausted";

// Per-agent run lifecycle on the live fleet board.
type RunStatus = "queued" | "working" | "done" | "error";

type FleetAgent = {
  id: string;
  ref?: string;
  name: string;
  role: string;
  category: string;
  charter: string;
  firstTaskTitle: string;
  firstTaskBrief?: string;
  runStatus: RunStatus;
  artifactTitle?: string;
  artifactMarkdown?: string;
};

const EASE = "cubic-bezier(0.22,1,0.36,1)";
const CLAY = "var(--accent-500)";
const GREEN = "var(--success-500)";

// The conversion CTA carries the trial token (already in sessionStorage) through
// signup: /auth signs the user in/up, then routes to /trial/claim which binds
// the trial workspace to the new account.
const CLAIM_AUTH_HREF = "/auth?mode=sign_up&next=%2Ftrial%2Fclaim";

const DESIGNING_LINES = [
  "sizing the problem…",
  "choosing the right roles…",
  "writing each charter…",
  "assembling the team…",
];

// ---------------------------------------------------------------------------
// history + format helpers
// ---------------------------------------------------------------------------

// The trial is a single-route (/trial) state machine. We reflect the view in a
// `?step=` query param and push one history entry per forward transition so the
// browser Back/Forward buttons move WITHIN the flow instead of exiting /trial.
// Views collapse to three history "steps": land, intake, and building (the whole
// designing -> fleet -> exhausted build phase shares one entry).
export type HistoryStep = "land" | "intake" | "building";

export function stepForView(view: View): HistoryStep {
  if (view === "intake") return "intake";
  if (view === "designing" || view === "fleet" || view === "exhausted") return "building";
  return "land";
}

export function urlForView(view: View): string {
  const step = stepForView(view);
  const base = typeof window !== "undefined" ? window.location.pathname : "/trial";
  return step === "land" ? base : `${base}?step=${step}`;
}

function formatDollars(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

// Map a designed agent's category/role to a fleet icon (mirrors Overview's
// icon-chip language). Keyword match, generous fallbacks, Bot as default.
function iconForAgent(category: string, role: string): LucideIcon {
  const s = `${category} ${role}`.toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => s.includes(k));
  if (has("email", "inbox")) return Mail;
  if (has("sales", "outbound", "gtm", "bizdev", "revenue", "pipeline", "lead")) return Send;
  if (has("finance", "account", "invoice", "billing", "payroll", "bookkeep")) return Receipt;
  if (has("support", "success", "customer", "service", "help")) return LifeBuoy;
  if (has("content", "writ", "copy", "blog", "editor", "social")) return PenLine;
  if (has("market", "brand", "growth", "demand", "seo", "ads", "campaign")) return Megaphone;
  if (has("research", "insight", "discover", "intel")) return Search;
  if (has("analy", "data", "metric", "report", "bi")) return BarChart3;
  if (has("recruit", "people", "hr", "talent", "hiring")) return Users;
  if (has("legal", "compliance", "contract", "policy", "risk")) return Scale;
  if (has("eng", "dev", "product", "tech", "build", "code")) return Code2;
  if (has("ops", "operation", "logistics", "supply", "fulfil", "inventory")) return Package;
  if (has("schedul", "calendar", "admin", "exec", "coordinat", "project")) return Calendar;
  if (has("pay", "spend", "budget")) return BadgeDollarSign;
  return Bot;
}

// ---------------------------------------------------------------------------
// small primitives
// ---------------------------------------------------------------------------

// Fade-in + rise on mount, staggered by index. Steady state is driven by React
// state (not CSS fill-mode) so it can never stall hidden. Same pattern as
// Overview.tsx's Reveal.
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
  const [shown, setShown] = useState(reduced);
  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const t = window.setTimeout(() => setShown(true), index * 110);
    return () => window.clearTimeout(t);
  }, [reduced, index]);
  return (
    <div
      className={className}
      style={{
        ...style,
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(14px)",
        transition: reduced ? undefined : `opacity 520ms ${EASE}, transform 520ms ${EASE}`,
        willChange: reduced ? undefined : "opacity, transform",
        // While still faded-in (opacity 0 + translated down) the block can overlap
        // the element below it and silently eat the first click. Disable hit-testing
        // until it is actually visible so primary CTAs register on the first click.
        pointerEvents: shown ? undefined : "none",
      }}
    >
      {children}
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
      className={pulse && !reduced ? "tdl-pulse-dot" : undefined}
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

function CoSAvatar({ size = 32 }: { size?: number }) {
  return (
    <span
      className="flex items-center justify-center rounded-full text-white"
      style={{ width: size, height: size, background: CLAY, flex: "none" }}
    >
      <Sparkles style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}

function CreditMeter({
  remainingCents,
  totalCents,
}: {
  remainingCents: number;
  totalCents: number;
}) {
  const pct =
    totalCents > 0 ? Math.max(0, Math.min(100, (remainingCents / totalCents) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-[var(--success-500)] transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground">
        {formatDollars(remainingCents)} of {formatDollars(totalCents)} free credit left
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// fleet tile — reuses Overview.tsx's tile visual language (icon-chip + name +
// category + status dot + a status line + progress meter + footer).
// ---------------------------------------------------------------------------

function statusMeta(s: RunStatus): { word: string; color: string; dot: string; pulse: boolean; pct: number } {
  switch (s) {
    case "working":
      return { word: "working…", color: CLAY, dot: CLAY, pulse: true, pct: 70 };
    case "done":
      return { word: "done", color: GREEN, dot: GREEN, pulse: false, pct: 100 };
    case "error":
      return { word: "hit a snag", color: "var(--warn-500)", dot: "var(--warn-500)", pulse: false, pct: 100 };
    default:
      return { word: "queued", color: "var(--muted-foreground)", dot: "var(--muted-foreground)", pulse: false, pct: 8 };
  }
}

function FleetTile({
  agent,
  reduced,
  onOpen,
  onRetry,
}: {
  agent: FleetAgent;
  reduced: boolean;
  onOpen: (a: FleetAgent) => void;
  onRetry: (a: FleetAgent) => void;
}) {
  const Icon = iconForAgent(agent.category, agent.role);
  const meta = statusMeta(agent.runStatus);
  const clickable = agent.runStatus === "done";
  const isError = agent.runStatus === "error";

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen(agent) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(agent);
              }
            }
          : undefined
      }
      className="bg-card border border-border rounded-2xl"
      style={{
        padding: 16,
        cursor: clickable ? "pointer" : "default",
        transition: reduced
          ? undefined
          : `transform 200ms ${EASE}, box-shadow 200ms ${EASE}, border-color 200ms ${EASE}`,
      }}
      onMouseEnter={(e) => {
        if (reduced || !clickable) return;
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
            {agent.category || agent.role}
          </div>
        </div>
        <StatusDot color={meta.dot} pulse={meta.pulse} reduced={reduced} />
      </div>

      {/* charter as the status line */}
      <div
        className="text-muted-foreground"
        style={{ fontSize: 13, lineHeight: 1.35, minHeight: 38, marginTop: 12 }}
      >
        {agent.charter}
      </div>

      {/* progress */}
      <div style={{ marginTop: 10 }}>
        <div className="bg-secondary" style={{ height: 4, borderRadius: 999, overflow: "hidden", width: "100%" }}>
          <div
            className={agent.runStatus === "working" && !reduced ? "tdl-indeterminate" : undefined}
            style={{
              width: `${meta.pct}%`,
              height: "100%",
              background: meta.color,
              borderRadius: 999,
              transition: reduced ? undefined : `width 900ms ${EASE}`,
            }}
          />
        </div>
      </div>

      {/* footer */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: meta.color }}>{meta.word}</span>
        {agent.runStatus === "done" ? (
          <span style={{ fontSize: 12, fontWeight: 600, color: CLAY }}>view deliverable →</span>
        ) : isError ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(agent);
            }}
            className="hover:underline"
            style={{ fontSize: 12, fontWeight: 600, color: CLAY }}
          >
            retry
          </button>
        ) : (
          <span className="text-muted-foreground" style={{ fontSize: 12 }}>
            {agent.firstTaskTitle}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// designing state — "your Chief of Staff is designing your company…"
// ---------------------------------------------------------------------------

function DesigningState({ reduced }: { reduced: boolean }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => {
      setStep((s) => Math.min(s + 1, DESIGNING_LINES.length - 1));
    }, 2200);
    return () => window.clearInterval(id);
  }, [reduced]);

  const progress = reduced ? 60 : Math.round(((step + 1) / DESIGNING_LINES.length) * 88);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 py-20 text-center">
      <div className="relative">
        {!reduced ? (
          <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent-500)]/25" />
        ) : null}
        <span className="relative flex size-16 items-center justify-center rounded-full bg-[var(--accent-500)] text-white">
          <Sparkles className="size-7" />
        </span>
      </div>
      <div>
        <p className="text-lg font-semibold text-foreground">
          your chief of staff is designing your company
        </p>
        {reduced ? (
          <p className="mt-1 flex items-center justify-center gap-2 text-base text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-[var(--accent-500)]" />
            assembling the team…
          </p>
        ) : (
          <p
            key={step}
            className="mt-1 text-base text-muted-foreground transition-opacity duration-500"
          >
            {DESIGNING_LINES[step]}
          </p>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-[var(--accent-500)] transition-all duration-700 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        this is a real team being staffed — give it a few seconds
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// deliverable modal — renders the agent's real markdown deliverable.
// ---------------------------------------------------------------------------

function DeliverableModal({
  agent,
  onClose,
}: {
  agent: FleetAgent;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, [onClose]);

  const markdown = agent.artifactMarkdown ?? "";

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select text manually */
    }
  }

  const Icon = iconForAgent(agent.category, agent.role);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-10"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-3xl rounded-2xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div className="flex items-start gap-3">
            <span
              className="bg-secondary flex size-10 items-center justify-center rounded-xl"
              style={{ flex: "none" }}
            >
              <Icon size={18} className="text-foreground" />
            </span>
            <div>
              <h2 className="text-lg font-bold tracking-[-0.02em] text-foreground">
                {agent.artifactTitle || agent.firstTaskTitle}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {agent.name} delivered this on its own — no human wrote it
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-[var(--accent-500)]"
            >
              {copied ? (
                <>
                  <Check className="size-3.5 text-[var(--success-500)]" />
                  copied
                </>
              ) : (
                <>
                  <Copy className="size-3.5" />
                  copy
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="close"
              className="inline-flex size-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* body */}
        <div className="max-h-[70vh] overflow-y-auto p-6">
          {markdown ? (
            <MarkdownBody linkIssueReferences={false}>{markdown}</MarkdownBody>
          ) : (
            <p className="text-sm text-muted-foreground">this deliverable is empty — try re-running this agent.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export function TrialLandingPage() {
  const reduced = usePrefersReducedMotion();

  const [view, setView] = useState<View>("land");
  const [token, setToken] = useState<string | null>(null);

  // intake
  const [whatYouDo, setWhatYouDo] = useState("");
  const [goal, setGoal] = useState("");
  const [blocker, setBlocker] = useState("");

  // company + fleet
  const [company, setCompany] = useState<TrialCompanyMeta | null>(null);
  const [agents, setAgents] = useState<FleetAgent[]>([]);
  const [openAgent, setOpenAgent] = useState<FleetAgent | null>(null);

  // credit
  const [creditCents, setCreditCents] = useState(0);
  const [creditRemainingCents, setCreditRemainingCents] = useState(0);
  const [midBuildExhausted, setMidBuildExhausted] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const shareTimer = useRef<number | null>(null);
  const runningRef = useRef(false);
  const resumedRef = useRef(false);
  const submittingRef = useRef(false);

  // History integration: refs the popstate handler reads (it closes over the
  // mount-time render, so it must read live values through refs).
  const viewRef = useRef<View>(view);
  const companyRef = useRef<TrialCompanyMeta | null>(company);
  // First Back out of a built/in-progress fleet is "absorbed" (we keep the team
  // visible) so a single Back press never strands the user on a blank page or
  // hard-exits /trial. A second consecutive Back is allowed through.
  const backLeaveArmedRef = useRef(false);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    companyRef.current = company;
  }, [company]);

  // Forward transition: push a new browser-history entry so Back returns here.
  const pushView = useCallback((next: View) => {
    backLeaveArmedRef.current = false;
    try {
      window.history.pushState({ trialView: next }, "", urlForView(next));
    } catch {
      /* history unavailable — view still changes via React state */
    }
    setView(next);
  }, []);

  // In-place transition: update the current entry without growing the stack
  // (e.g. designing -> fleet, both live in the "building" step).
  const replaceView = useCallback((next: View) => {
    try {
      window.history.replaceState({ trialView: next }, "", urlForView(next));
    } catch {
      /* history unavailable — view still changes via React state */
    }
    setView(next);
  }, []);

  const setAgentStatus = useCallback((id: string, runStatus: RunStatus) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, runStatus } : a)));
  }, []);

  const resetToLand = useCallback(
    (message: string) => {
      clearTrialStorage();
      setToken(null);
      setCompany(null);
      setAgents([]);
      setOpenAgent(null);
      setMidBuildExhausted(false);
      setError(message);
      replaceView("land");
    },
    [replaceView],
  );

  // Run the fleet: each agent does its first task, with small concurrency, so
  // the board comes alive (working… -> done) one tile at a time.
  const runFleet = useCallback(
    async (activeToken: string, ids: string[]) => {
      if (runningRef.current || ids.length === 0) return;
      runningRef.current = true;
      const queue = [...ids];
      let stop = false;

      const worker = async () => {
        while (queue.length > 0 && !stop) {
          const id = queue.shift()!;
          setAgentStatus(id, "working");
          try {
            const res = await trialApi.runAgent(activeToken, id);
            setCreditCents(res.creditCents);
            setCreditRemainingCents(res.creditRemainingCents);
            setAgents((prev) =>
              prev.map((a) =>
                a.id === id
                  ? {
                      ...a,
                      runStatus: "done",
                      artifactTitle: res.artifact.title,
                      artifactMarkdown: res.artifact.content.markdown,
                    }
                  : a,
              ),
            );
          } catch (err) {
            if (err instanceof ApiError) {
              if (err.status === 402) {
                stop = true;
                setMidBuildExhausted(true);
                setAgentStatus(id, "queued");
                break;
              }
              if (err.status === 410) {
                stop = true;
                resetToLand("your trial session expired — start a fresh one below.");
                break;
              }
              if (err.status === 404) {
                stop = true;
                resetToLand("we lost track of that session — start a fresh one below.");
                break;
              }
            }
            setAgentStatus(id, "error");
          }
        }
      };

      const lanes = Math.min(2, queue.length);
      await Promise.all(Array.from({ length: lanes }, () => worker()));
      runningRef.current = false;
    },
    [resetToLand, setAgentStatus],
  );

  // Initialize browser history + restore an in-progress intake on mount. Runs
  // before the token-resume effect so the history base entry exists first.
  useEffect(() => {
    // Tag the current entry as the "land" base so Back always has a defined
    // target inside /trial (never an immediate hard-exit on the first press).
    try {
      window.history.replaceState({ trialView: "land" }, "", urlForView("land"));
    } catch {
      /* history unavailable */
    }

    const persisted = readPersistedState();
    if (!persisted) return;
    if (persisted.whatYouDo) setWhatYouDo(persisted.whatYouDo);
    if (persisted.goal) setGoal(persisted.goal);
    if (persisted.blocker) setBlocker(persisted.blocker);
    // A refresh mid-intake/mid-designing returns the visitor to the intake form
    // with their text intact (the design request itself did not survive reload).
    if (persisted.view === "intake" || persisted.view === "designing") {
      pushView("intake");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the in-progress intake + current view so a refresh never wipes what
  // the visitor typed. The company itself is server-side (resumed via the token).
  useEffect(() => {
    writePersistedState({ view, whatYouDo, goal, blocker });
  }, [view, whatYouDo, goal, blocker]);

  // Browser Back/Forward: step WITHIN the flow instead of leaving /trial.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const current = viewRef.current;
      const raw = (event.state as { trialView?: View } | null)?.trialView ?? "land";
      // The build phase collapses to a single history step; normalize to fleet.
      const target: View = raw === "designing" || raw === "exhausted" ? "fleet" : raw;

      const inBuild =
        current === "fleet" || current === "designing" || current === "exhausted";
      const leavingBuild = inBuild && target !== "fleet";

      // Absorb the FIRST Back out of a built/in-progress build: keep it visible
      // and re-push the current entry so the company is never lost and the page
      // never blanks or hard-exits. A second consecutive Back is allowed through.
      if (leavingBuild && !backLeaveArmedRef.current) {
        backLeaveArmedRef.current = true;
        setError(null);
        try {
          window.history.pushState({ trialView: current }, "", urlForView(current));
        } catch {
          /* history unavailable */
        }
        return;
      }

      backLeaveArmedRef.current = false;
      setOpenAgent(null);
      setError(null);
      setView(target);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Warn before leaving ONLY while a build is actually in flight. Removed the
  // moment the work is idle/complete so it never nags after delivery.
  useEffect(() => {
    const buildInFlight =
      view === "designing" ||
      (view === "fleet" &&
        agents.some((a) => a.runStatus === "working" || a.runStatus === "queued"));
    if (!buildInFlight) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [view, agents]);

  // Resume a prior session on refresh (best-effort): restore the built company,
  // each agent's status + its deliverable, and resume any unfinished runs.
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    const stored = readStoredToken();
    if (!stored) return;
    setToken(stored);
    let cancelled = false;

    trialApi
      .getCompany(stored)
      .then((snap) => {
        if (cancelled) return;
        setCreditCents(snap.session.creditCents);
        setCreditRemainingCents(snap.session.creditRemainingCents);
        if (!snap.company) return; // session exists but no company designed yet

        setCompany(snap.company);
        const artifactByAgent = new Map<string, { title: string; markdown: string }>();
        for (const art of snap.artifacts) {
          if (art.agentId && typeof art.content?.markdown === "string" && !artifactByAgent.has(art.agentId)) {
            artifactByAgent.set(art.agentId, { title: art.title, markdown: art.content.markdown });
          }
        }

        const restored: FleetAgent[] = snap.agents.map((a) => {
          const art = artifactByAgent.get(a.id);
          return {
            id: a.id,
            ref: a.ref,
            name: a.name,
            role: a.role,
            category: a.category,
            charter: a.charter,
            firstTaskTitle: a.firstTaskTitle,
            firstTaskBrief: a.firstTaskBrief,
            runStatus: a.hasArtifact ? "done" : "queued",
            artifactTitle: art?.title,
            artifactMarkdown: art?.markdown,
          };
        });
        setAgents(restored);
        // Push a history entry so the first Back press has somewhere to land and
        // the restored team is never lost on a single Back. popView absorbs it.
        pushView("fleet");

        // Resume any agents that never produced a deliverable, if credit remains.
        const pending = restored.filter((a) => a.runStatus !== "done").map((a) => a.id);
        if (pending.length > 0 && snap.session.creditRemainingCents > 0) {
          void runFleet(stored, pending);
        } else if (pending.length > 0) {
          setMidBuildExhausted(true);
        }
      })
      .catch(() => {
        // Stale/expired token — drop it and stay on the landing form.
        writeStoredToken(null);
        setToken(null);
      });

    return () => {
      cancelled = true;
    };
  }, [runFleet, pushView]);

  useEffect(
    () => () => {
      if (shareTimer.current) window.clearTimeout(shareTimer.current);
    },
    [],
  );

  // LAND -> INTAKE
  function handleStart(e: React.FormEvent) {
    e.preventDefault();
    if (whatYouDo.trim().length === 0) return;
    setError(null);
    pushView("intake");
  }

  // INTAKE -> DESIGNING -> FLEET
  async function handleBuild(e: React.FormEvent) {
    e.preventDefault();
    if (goal.trim().length === 0) return;
    // Guard against a double-submit racing two designs onto one session.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError(null);
    pushView("designing");

    try {
      let activeToken = token;
      if (!activeToken) {
        const session = await trialApi.createSession();
        activeToken = session.token;
        setToken(activeToken);
        setCreditCents(session.creditCents);
        setCreditRemainingCents(session.creditCents);
        writeStoredToken(activeToken);
      }

      const intake: TrialIntake = {
        whatYouDo: whatYouDo.trim(),
        goal: goal.trim(),
        blocker: blocker.trim() || undefined,
      };
      const result = await trialApi.design(activeToken, intake);

      setCompany(result.company);
      setCreditCents(result.creditCents);
      setCreditRemainingCents(result.creditRemainingCents);
      const fleet: FleetAgent[] = result.agents.map((a) => ({
        id: a.id,
        ref: a.ref,
        name: a.name,
        role: a.role,
        category: a.category,
        charter: a.charter,
        firstTaskTitle: a.firstTaskTitle,
        firstTaskBrief: a.firstTaskBrief,
        runStatus: "queued",
      }));
      setAgents(fleet);
      setMidBuildExhausted(false);
      // designing -> fleet share the "building" history step, so replace in place.
      replaceView("fleet");

      // Let the tiles "assemble" (staggered reveal) before they go to work.
      const ids = fleet.map((a) => a.id);
      const delay = reduced ? 0 : fleet.length * 110 + 500;
      window.setTimeout(() => {
        void runFleet(activeToken!, ids);
      }, delay);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 402) {
          // build itself ran out of credit, no company yet — stays in the
          // "building" step so Back behaves consistently.
          replaceView("exhausted");
          return;
        }
        if (err.status === 410) {
          resetToLand("your trial session expired — start a fresh one below.");
          return;
        }
        if (err.status === 404) {
          resetToLand("we lost track of that session — try again below.");
          return;
        }
        setError(
          err.status === 0
            ? "couldn't reach the server — check your connection and try again."
            : err.message || "something went wrong — give it another go.",
        );
      } else {
        setError("something went wrong — give it another go.");
      }
      // Return to the intake form (in place) so the visitor can retry; their
      // typed answers are preserved and the inline error explains what happened.
      replaceView("intake");
    } finally {
      submittingRef.current = false;
    }
  }

  function handleStartOver() {
    clearTrialStorage();
    backLeaveArmedRef.current = false;
    setToken(null);
    setCompany(null);
    setAgents([]);
    setOpenAgent(null);
    setMidBuildExhausted(false);
    setWhatYouDo("");
    setGoal("");
    setBlocker("");
    setError(null);
    replaceView("land");
  }

  async function handleShare() {
    const url = `${window.location.origin}/trial`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* clipboard blocked — nothing else to do */
    }
    setShared(true);
    if (shareTimer.current) window.clearTimeout(shareTimer.current);
    shareTimer.current = window.setTimeout(() => setShared(false), 1500);
  }

  const heroTitleClass =
    "text-4xl font-bold leading-[1.05] tracking-[-0.04em] text-foreground sm:text-5xl";

  const allDone = agents.length > 0 && agents.every((a) => a.runStatus === "done");
  const anyDone = agents.some((a) => a.runStatus === "done");

  return (
    // OWN scroll region — the app shell's `body { overflow: hidden }` would
    // otherwise clip the long fleet + deliverable states.
    <div className="h-screen overflow-y-auto bg-background text-foreground">
      <style>{`
        @keyframes tdl-dot-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(0,0,0,0.18); }
          70%  { box-shadow: 0 0 0 5px rgba(0,0,0,0); }
          100% { box-shadow: 0 0 0 0 rgba(0,0,0,0); }
        }
        .tdl-pulse-dot { animation: tdl-dot-pulse 1.6s ${EASE} infinite; }
        @keyframes tdl-shimmer { 0% { opacity: .55; } 50% { opacity: 1; } 100% { opacity: .55; } }
        .tdl-indeterminate { animation: tdl-shimmer 1.2s ${EASE} infinite; }
        @media (prefers-reduced-motion: reduce) {
          .tdl-pulse-dot, .tdl-indeterminate { animation: none !important; }
        }
      `}</style>

      {/* ===================================================== LAND / INTAKE / DESIGNING / EXHAUSTED */}
      {view === "land" || view === "intake" || view === "designing" || view === "exhausted" ? (
        <div className="mx-auto w-full max-w-2xl px-6 py-12">
          {/* LAND */}
          {view === "land" ? (
            <div className="flex flex-col items-center text-center">
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                <Sparkles className="size-3.5 text-[var(--accent-500)]" />
                no signup · 60 seconds
              </span>
              <h1 className={`mt-6 ${heroTitleClass}`}>
                describe your company.
                <br />
                watch it build itself.
              </h1>
              <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
                a chief of staff will design and staff an autonomous team for you —
                and they&apos;ll get to work right away. no account, no card.
              </p>

              <form onSubmit={handleStart} className="mt-8 w-full max-w-xl space-y-4 text-left">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">
                    what does your company do?
                  </span>
                  <textarea
                    value={whatYouDo}
                    onChange={(e) => setWhatYouDo(e.target.value)}
                    rows={3}
                    required
                    autoFocus
                    placeholder="we run a 30-person freight brokerage moving full-truckload freight across the midwest"
                    className="w-full resize-none rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[var(--accent-500)]"
                  />
                </label>

                {error ? (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={whatYouDo.trim().length === 0}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3.5 text-base font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  start
                  <ArrowRight className="size-5" />
                </button>
              </form>

              <div className="mt-10 w-full max-w-xl">
                <div className="mb-3 flex items-center gap-3 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  or start from a template
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {TRIAL_TEMPLATES.map((t) => {
                    const Icon = t.icon;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setWhatYouDo(t.intake.whatYouDo);
                          setGoal(t.intake.goal);
                          setBlocker(t.intake.blocker);
                          setError(null);
                          pushView("intake");
                        }}
                        className="group flex items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-[var(--accent-500)]"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground transition-colors group-hover:text-[var(--accent-500)]">
                          <Icon className="size-[18px]" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-foreground">{t.label}</span>
                          <span className="block text-xs leading-snug text-muted-foreground">{t.blurb}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <p className="mt-10 text-xs text-muted-foreground">
                already have an account?{" "}
                <Link
                  to="/auth"
                  className="text-foreground underline underline-offset-2 hover:text-[var(--accent-500)]"
                >
                  sign in
                </Link>
                <span className="px-2 text-border">·</span>
                <a
                  href="/pricing"
                  className="text-foreground underline underline-offset-2 hover:text-[var(--accent-500)]"
                >
                  pricing
                </a>
                <span className="px-2 text-border">·</span>
                <a
                  href="/investors"
                  className="text-foreground underline underline-offset-2 hover:text-[var(--accent-500)]"
                >
                  for investors
                </a>
              </p>
            </div>
          ) : null}

          {/* INTAKE — the CoS's quick questions */}
          {view === "intake" ? (
            <div className="flex flex-col gap-6 py-4">
              <button
                type="button"
                onClick={() => window.history.back()}
                className="inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-4" />
                back
              </button>

              {/* CoS intro bubble */}
              <div className="flex items-start gap-3">
                <CoSAvatar />
                <div className="rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3 text-sm leading-6 text-foreground">
                  <p className="font-medium">hey — i&apos;m your chief of staff.</p>
                  <p className="mt-1 text-muted-foreground">
                    got it: <span className="text-foreground">{whatYouDo.trim()}</span>. two
                    quick questions and i&apos;ll assemble your team.
                  </p>
                </div>
              </div>

              <form onSubmit={handleBuild} className="space-y-5">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">
                    what&apos;s the #1 thing you want to get done right now?
                  </span>
                  <textarea
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    rows={2}
                    required
                    autoFocus
                    placeholder="book more loaded miles with new shippers this quarter"
                    className="w-full resize-none rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[var(--accent-500)]"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">
                    what&apos;s slowing you down most?{" "}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </span>
                  <input
                    value={blocker}
                    onChange={(e) => setBlocker(e.target.value)}
                    placeholder="too much time on manual carrier follow-ups"
                    className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[var(--accent-500)]"
                  />
                </label>

                {error ? (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={goal.trim().length === 0}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3.5 text-base font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  build my company
                  <ArrowRight className="size-5" />
                </button>
              </form>
            </div>
          ) : null}

          {/* DESIGNING */}
          {view === "designing" ? <DesigningState reduced={reduced} /> : null}

          {/* EXHAUSTED (build itself ran out of credit, no company yet) */}
          {view === "exhausted" ? (
            <div className="mx-auto flex max-w-md flex-col items-center gap-5 py-16 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-[var(--accent-500)] text-white">
                <Sparkles className="size-6" />
              </span>
              <div>
                <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
                  you&apos;ve used your free build
                </h1>
                <p className="mt-2 text-base leading-7 text-muted-foreground">
                  sign up to keep your company, get more credit, and put your team to
                  work on your real business.
                </p>
              </div>
              <Link
                to={CLAIM_AUTH_HREF}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3 text-base font-semibold text-white transition-opacity hover:opacity-90"
              >
                sign up to keep your company
                <ArrowRight className="size-5" />
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ===================================================== FLEET */}
      {view === "fleet" ? (
        <div className="mx-auto w-full max-w-[1080px] px-6 py-10 sm:px-7">
          {/* company header */}
          <Reveal index={0} reduced={reduced}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                  <CoSAvatar size={20} />
                  your chief of staff built this
                </div>
                <h1 className="mt-3 text-3xl font-extrabold leading-[1.05] tracking-[-0.04em] text-foreground sm:text-4xl">
                  {company?.name ?? "your company"}
                </h1>
                {company?.mission ? (
                  <p className="mt-2 max-w-2xl text-base leading-7 text-muted-foreground">
                    {company.mission}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5">
                  <StatusDot color={GREEN} pulse={!allDone} reduced={reduced} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: GREEN }}>
                    {allDone ? "all delivered" : "team is working"}
                  </span>
                </div>
                <CreditMeter remainingCents={creditRemainingCents} totalCents={creditCents} />
              </div>
            </div>
          </Reveal>

          {/* fleet heading */}
          <Reveal index={1} reduced={reduced}>
            <h2
              className="text-foreground"
              style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 32, marginBottom: 12 }}
            >
              your team{agents.length ? ` · ${agents.length} agents` : ""}
            </h2>
          </Reveal>

          {/* fleet grid — tiles assemble in one-by-one, then go to work */}
          <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 12 }}>
            {agents.map((agent, i) => (
              <Reveal key={agent.id} index={i + 2} reduced={reduced}>
                <FleetTile
                  agent={agent}
                  reduced={reduced}
                  onOpen={setOpenAgent}
                  onRetry={(a) => {
                    if (token) void runFleet(token, [a.id]);
                  }}
                />
              </Reveal>
            ))}
          </div>

          {/* mid-build credit-exhausted banner (company already built) */}
          {midBuildExhausted ? (
            <div className="mt-8 rounded-2xl border border-[var(--accent-500)]/40 bg-card p-5">
              <p className="text-base font-semibold text-foreground">
                you&apos;ve used your free build
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                your company is built and {anyDone ? "your first deliverables are ready" : "ready"} —
                sign up to finish staffing it and get more credit.
              </p>
            </div>
          ) : null}

          {error ? (
            <p className="mt-6 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          {/* CTAs */}
          <Reveal index={agents.length + 3} reduced={reduced}>
            <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-border pt-6">
              <Link
                to={CLAIM_AUTH_HREF}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                <Sparkles className="size-4" />
                keep this company + get free credit
              </Link>
              <button
                type="button"
                onClick={handleShare}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-[var(--accent-500)]"
              >
                {shared ? (
                  <>
                    <Check className="size-4 text-[var(--success-500)]" />
                    link copied
                  </>
                ) : (
                  <>
                    <Share2 className="size-4" />
                    share
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleStartOver}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-[var(--accent-500)]"
              >
                build another
              </button>
            </div>
          </Reveal>
        </div>
      ) : null}

      {/* DELIVERABLE modal */}
      {openAgent ? (
        <DeliverableModal agent={openAgent} onClose={() => setOpenAgent(null)} />
      ) : null}
    </div>
  );
}

export default TrialLandingPage;
