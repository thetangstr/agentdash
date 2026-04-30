// AgentDash — Dashboard
// "Luxury control-plane" treatment:
// editorial type, warm paper, single jade accent, live heartbeat pulse,
// org chart, stats strip, attention list, spend card, artifacts. Styles
// live in ui/src/styles/luxe.css and are scoped to the `luxe-root` container
// so the rest of the app (shadcn/Tailwind) is untouched.
//
// Data sources:
//   REAL — dashboardApi.summary, activityApi.list, agentsApi.list, issuesApi.list
//   MOCK — MRR + dept-spend breakdown + artifacts (marked `MOCK:` below)
//          These map to product concepts we haven't wired to APIs yet.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { LayoutDashboard } from "lucide-react";
import type { ActivityEvent, Agent } from "@agentdash/shared";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useTheme } from "../context/ThemeContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";

// ---------------------------------------------------------------------------
// Luxe preferences (accent, density) — persisted in localStorage.
// ---------------------------------------------------------------------------

type LuxeAccent = "jade" | "oxblood" | "ink" | "cobalt" | "amber";
type LuxeDensity = "cozy" | "compact";

const ACCENT_STORAGE = "agentdash.luxe.accent";
const DENSITY_STORAGE = "agentdash.luxe.density";

function useLuxePrefs() {
  const [accent, setAccent] = useState<LuxeAccent>(() => {
    const v = typeof window !== "undefined" ? window.localStorage.getItem(ACCENT_STORAGE) : null;
    return (v as LuxeAccent) ?? "jade";
  });
  const [density, setDensity] = useState<LuxeDensity>(() => {
    const v = typeof window !== "undefined" ? window.localStorage.getItem(DENSITY_STORAGE) : null;
    return (v as LuxeDensity) ?? "cozy";
  });
  useEffect(() => { try { localStorage.setItem(ACCENT_STORAGE, accent); } catch { /* ignore */ } }, [accent]);
  useEffect(() => { try { localStorage.setItem(DENSITY_STORAGE, density); } catch { /* ignore */ } }, [density]);
  return { accent, setAccent, density, setDensity };
}

// ---------------------------------------------------------------------------
// Small Sparkline atom — no external deps.
// ---------------------------------------------------------------------------

function Sparkline({
  data,
  color = "currentColor",
  width = 220,
  height = 28,
}: { data: number[]; color?: string; width?: number; height?: number }) {
  if (data.length < 2) return <svg width={width} height={height} />;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = Math.max(1, max - min);
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => [i * step, height - ((v - min) / range) * (height - 4) - 2] as const);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `${path} L ${width} ${height} L 0 ${height} Z`;
  return (
    <svg width={width} height={height} style={{ display: "block" }} aria-hidden>
      <path d={area} fill={color} opacity="0.12" />
      <path d={path} stroke={color} strokeWidth="1.2" fill="none" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Page head (editorial title + live pulse)
// ---------------------------------------------------------------------------

function fmtDateStamp(now: Date) {
  return now.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
function fmtClock(now: Date) {
  return now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function PageHead({ companyName, runningCount, attentionCount }: {
  companyName: string;
  runningCount: number;
  attentionCount: number;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(t);
  }, []);
  const tone = attentionCount === 0 ? "all clear"
    : attentionCount === 1 ? "one item needs your attention"
    : `${attentionCount} items need your attention`;
  return (
    <div className="luxe-page-head">
      <div>
        <div className="luxe-eyebrow">{fmtDateStamp(now)}</div>
        <h1 className="luxe-title">
          {getGreeting()}. <span className="soft">Your workforce is</span> {attentionCount === 0 ? "on-track" : "holding steady"}.
        </h1>
        <div className="luxe-subtitle">
          {companyName} · {runningCount} agent{runningCount === 1 ? "" : "s"} currently heartbeating; {tone}.
        </div>
      </div>
      <div className="luxe-meta">
        <div className="pulse"><span className="pulse-dot" />live</div>
        <div>heartbeat · {fmtClock(now)}</div>
        <div>runtime · local_trusted</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats strip (MRR mocked; burn/issues/approvals wired to real data)
// ---------------------------------------------------------------------------

function pseudoSparkFrom(seed: number, length = 8, jitter = 0.18) {
  const out: number[] = [];
  let v = seed;
  for (let i = 0; i < length; i++) {
    const d = (Math.sin(i * 1.7) + Math.cos(i * 0.9)) * jitter * seed;
    v = Math.max(0, seed + d + (Math.random() - 0.5) * seed * 0.04);
    out.push(v);
  }
  out[out.length - 1] = seed;
  return out;
}

function Stats({ summary, issueCount, runningCount }: {
  summary: { monthSpendCents: number; monthBudgetCents: number; monthUtilizationPercent: number; pendingApprovals: number };
  issueCount: number;
  runningCount: number;
}) {
  // MOCK: MRR is a product-level concept we don't yet compute server-side.
  const mrrCents = 18_400_000;
  const burnDollars = summary.monthSpendCents / 30 / 100;
  const issueTrendDir = issueCount > 5 ? "flat" : "down";

  return (
    <div className="luxe-stats">
      <div className="luxe-stat">
        <div className="luxe-stat-label">MRR (mock)</div>
        <div className="luxe-stat-value luxe-tnum">${Math.round(mrrCents / 1000 / 100)}<span className="unit">K</span></div>
        <div className="luxe-stat-sub"><span className="luxe-trend up">▲ $12.4K</span> <span>vs last week</span></div>
        <div className="luxe-mini-spark"><Sparkline data={pseudoSparkFrom(mrrCents / 100 / 1000)} color="var(--luxe-accent)" /></div>
      </div>
      <div className="luxe-stat">
        <div className="luxe-stat-label">Daily burn</div>
        <div className="luxe-stat-value luxe-tnum">${burnDollars.toFixed(0)}<span className="unit">.{(burnDollars % 1).toFixed(2).slice(2)}</span></div>
        <div className="luxe-stat-sub">
          <span className="luxe-trend flat">— avg</span>
          <span>{summary.monthUtilizationPercent}% of monthly budget</span>
        </div>
        <div className="luxe-mini-spark"><Sparkline data={pseudoSparkFrom(Math.max(10, burnDollars))} color="var(--luxe-ink-2)" /></div>
      </div>
      <div className="luxe-stat">
        <div className="luxe-stat-label">Issues in flight</div>
        <div className="luxe-stat-value luxe-tnum">{issueCount}</div>
        <div className="luxe-stat-sub">
          <span className={`luxe-trend ${issueTrendDir}`}>{issueTrendDir === "down" ? "▼ 6" : "— stable"}</span>
          <span>{runningCount} running now</span>
        </div>
        <div className="luxe-mini-spark"><Sparkline data={pseudoSparkFrom(Math.max(3, issueCount))} color="var(--luxe-ok)" /></div>
      </div>
      <div className="luxe-stat">
        <div className="luxe-stat-label">Approvals pending</div>
        <div className="luxe-stat-value luxe-tnum">{summary.pendingApprovals}</div>
        <div className="luxe-stat-sub">
          <span className={`luxe-trend ${summary.pendingApprovals > 0 ? "up" : "flat"}`}>{summary.pendingApprovals > 0 ? "▲ active" : "— none"}</span>
          <span>awaiting review</span>
        </div>
        <div className="luxe-mini-spark"><Sparkline data={pseudoSparkFrom(Math.max(1, summary.pendingApprovals))} color="var(--luxe-warn)" /></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attention list (real, derived from DashboardSummary)
// ---------------------------------------------------------------------------

interface AttnItem {
  key: string;
  kind: "incident" | "approval" | "budget" | "review";
  title: string;
  meta: string[];
  cost: string;
  to: string;
  iconChar: string;
}

function buildAttention(summary: import("@agentdash/shared").DashboardSummary): AttnItem[] {
  const items: AttnItem[] = [];
  if (summary.agents.error > 0) {
    items.push({
      key: "errors", kind: "incident",
      title: `${summary.agents.error} agent${summary.agents.error > 1 ? "s" : ""} in error state`,
      meta: ["Needs investigation", "P1"],
      cost: "—", to: "/agents/error", iconChar: "!",
    });
  }
  if (summary.tasks.blocked > 0) {
    items.push({
      key: "blocked", kind: "incident",
      title: `${summary.tasks.blocked} task${summary.tasks.blocked > 1 ? "s" : ""} blocked`,
      meta: ["May be stalling progress"],
      cost: "—", to: "/issues", iconChar: "⨯",
    });
  }
  if (summary.budgets.activeIncidents > 0) {
    items.push({
      key: "budget-incidents", kind: "budget",
      title: `${summary.budgets.activeIncidents} active budget incident${summary.budgets.activeIncidents > 1 ? "s" : ""}`,
      meta: [`${summary.budgets.pausedAgents} agents paused`],
      cost: "hard-stop", to: "/budget", iconChar: "$",
    });
  }
  const totalApprovals = summary.pendingApprovals + summary.budgets.pendingApprovals;
  if (totalApprovals > 0) {
    items.push({
      key: "approvals", kind: "approval",
      title: `${totalApprovals} pending approval${totalApprovals > 1 ? "s" : ""}`,
      meta: ["Awaiting your review"],
      cost: "—", to: "/approvals", iconChar: "✓",
    });
  }
  return items;
}

function AttentionList({ items, prefix }: { items: AttnItem[]; prefix: string }) {
  return (
    <div className="luxe-card">
      <div className="luxe-card-head">
        <div>
          <div className="luxe-card-eyebrow">Needs attention · {items.length}</div>
          <div className="luxe-card-title">Morning scan</div>
        </div>
        <div className="luxe-spacer" />
        <Link to={`/${prefix}/inbox`} className="luxe-btn ghost sm">View inbox →</Link>
      </div>
      {items.length === 0 ? (
        <div style={{ padding: "28px", color: "var(--luxe-ink-3)", fontSize: 13 }}>
          All clear — nothing needs your attention right now.
        </div>
      ) : (
        <div className="luxe-attn-list">
          {items.map((item) => (
            <Link key={item.key} to={`/${prefix}${item.to}`} className="luxe-attn-row">
              <div className="luxe-attn-icon">{item.iconChar}</div>
              <div className="luxe-attn-body">
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className={"luxe-attn-tag " + item.kind}>{item.kind}</span>
                  <span className="luxe-attn-title">{item.title}</span>
                </div>
                <div className="luxe-attn-meta">{item.meta.map((m, i) => <span key={i}>{m}</span>)}</div>
              </div>
              <div className="luxe-attn-cost luxe-tnum">{item.cost}</div>
              <div className="luxe-attn-arrow">→</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spend card (today + MTD + dept breakdown — dept breakdown is MOCK until
// we have a per-department costs endpoint).
// ---------------------------------------------------------------------------

function SpendCard({ summary }: { summary: import("@agentdash/shared").DashboardSummary }) {
  const monthSpend = summary.costs.monthSpendCents / 100;
  const monthBudget = Math.max(1, summary.costs.monthBudgetCents) / 100;
  const mtdPct = Math.min(100, summary.costs.monthUtilizationPercent);
  const todaySpend = monthSpend / 30;
  const dailyCap = monthBudget / 30 * 1.3;
  const todayPct = Math.min(100, Math.round((todaySpend / dailyCap) * 100));

  // MOCK: dept breakdown — no endpoint yet.
  const depts = [
    { label: "Engineering", pct: 62 },
    { label: "Product",     pct: 19 },
    { label: "Marketing",   pct: 12 },
    { label: "Finance",     pct:  4 },
    { label: "Executive",   pct:  3 },
  ];

  return (
    <div className="luxe-card">
      <div className="luxe-card-head">
        <div>
          <div className="luxe-card-eyebrow">Today · reset 00:00</div>
          <div className="luxe-card-title">Spend &amp; budget</div>
        </div>
        <div className="luxe-spacer" />
        <div className="luxe-mono" style={{ fontSize: 11, color: "var(--luxe-ink-4)", letterSpacing: ".06em" }}>USD</div>
      </div>
      <div className="luxe-spend-head">
        <div>
          <div className="luxe-spend-label">Today (est)</div>
          <div className="luxe-spend-num luxe-tnum">${todaySpend.toFixed(2)}</div>
          <div className="luxe-burn-bar"><div className="fill" style={{ width: `${todayPct}%` }} /></div>
          <div className="luxe-burn-meta">
            <span>${todaySpend.toFixed(2)} of ${dailyCap.toFixed(0)} daily cap</span>
            <span>{todayPct}%</span>
          </div>
        </div>
        <div>
          <div className="luxe-spend-label">Month-to-date</div>
          <div className="luxe-spend-num luxe-tnum">${monthSpend.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}</div>
          <div className="luxe-burn-bar"><div className="fill" style={{ width: `${mtdPct}%`, background: "var(--luxe-ink-2)" }} /></div>
          <div className="luxe-burn-meta">
            <span>of ${monthBudget.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} monthly budget</span>
            <span>{mtdPct}%</span>
          </div>
        </div>
      </div>
      <div className="luxe-dept-list">
        {depts.map((d) => (
          <div key={d.label} className="luxe-dept-row">
            <div className="luxe-dept-label">{d.label}</div>
            <div className="luxe-dept-bar"><div className="fill" style={{ width: `${d.pct}%` }} /></div>
            <div className="luxe-dept-val">{d.pct}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org chart (tree view) — wired to real agents
// ---------------------------------------------------------------------------

function OrgChart({ agents, prefix }: { agents: Agent[]; prefix: string }) {
  const runningCount = agents.filter((a) => a.status === "running").length;
  const pausedCount = agents.filter((a) => a.status === "paused").length;
  const errorCount = agents.filter((a) => a.status === "error").length;

  // Simple two-level layout: show the first agent as root, the rest as
  // direct reports. This is a Phase-1 compromise; the real agent-hierarchy
  // data model lives in projects / parent assignments and deserves its own
  // treatment in Phase 2.
  const [root, ...reports] = agents;

  return (
    <div className="luxe-card" style={{ gridColumn: "span 12" }}>
      <div className="luxe-card-head">
        <div>
          <div className="luxe-card-eyebrow">
            Live · {runningCount} running · {pausedCount} paused · {errorCount} error
          </div>
          <div className="luxe-card-title">Your workforce</div>
        </div>
        <div className="luxe-spacer" />
        <div className="luxe-org-toolbar">
          <div className="luxe-seg">
            <button className="active" disabled>Tree</button>
            <button disabled title="Phase 2">Constellation</button>
            <button disabled title="Phase 2">List</button>
          </div>
          <Link to={`/${prefix}/agents`} className="luxe-btn ghost sm">View all →</Link>
        </div>
      </div>
      <div className="luxe-org-wrap">
        {agents.length === 0 ? (
          <div style={{ color: "var(--luxe-ink-3)", padding: 24, fontSize: 13 }}>
            No agents yet. Create one to get started.
          </div>
        ) : (
          <div className="luxe-org-tree">
            {root && (
              <div className="luxe-org-level">
                <AgentCard agent={root} prefix={prefix} />
              </div>
            )}
            {reports.length > 0 && (
              <div className="luxe-org-level">
                {reports.slice(0, 12).map((a) => <AgentCard key={a.id} agent={a} prefix={prefix} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentCard({ agent, prefix }: { agent: Agent; prefix: string }) {
  const initial = (agent.name || "?").slice(0, 1).toUpperCase();
  const status = (agent.status ?? "idle").toLowerCase();
  const roleLabel = agent.title || agent.role;
  const subtitle = agent.capabilities
    || (agent.pauseReason ? `Paused · ${agent.pauseReason}` : null)
    || `Status: ${status}`;
  return (
    <Link to={`/${prefix}/agents/${agent.id}`} className="luxe-agent-node">
      <div className="luxe-agent-head">
        <div className="luxe-agent-avatar">
          {initial}
          <span className={`luxe-status-dot ${status}`} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="luxe-agent-name">{agent.name}</div>
          <div className="luxe-agent-role">{roleLabel}</div>
        </div>
      </div>
      <div className="luxe-agent-task">
        <span className="caret">›</span>
        {subtitle}
      </div>
      <div className="luxe-agent-foot">
        <span>{agent.adapterType}</span>
        <span className="luxe-tnum">{status}</span>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Heartbeat ticker — wired to real activity events
// ---------------------------------------------------------------------------

function activityKind(event: ActivityEvent): "run" | "ok" | "warn" | "alert" {
  const a = event.action.toLowerCase();
  if (a.includes("error") || a.includes("fail") || a.includes("halt")) return "alert";
  if (a.includes("paused") || a.includes("gated") || a.includes("warn")) return "warn";
  if (a.includes("completed") || a.includes("done") || a.includes("resolved")) return "ok";
  return "run";
}

function fmtHHMMSS(value: Date | string) {
  const d = value instanceof Date ? value : new Date(value);
  return d.toTimeString().slice(0, 8);
}

function Heartbeat({ events, agents }: { events: ActivityEvent[]; agents: Agent[] }) {
  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);
  const rows = events.slice(0, 30);
  return (
    <div className="luxe-card luxe-heartbeat">
      <div className="luxe-card-head">
        <div>
          <div className="luxe-card-eyebrow">Live · {rows.length} events</div>
          <div className="luxe-card-title">Heartbeat ticker</div>
        </div>
        <div className="luxe-spacer" />
        <div className="luxe-mono" style={{ fontSize: 10, color: "var(--luxe-ink-4)", letterSpacing: ".08em" }}>
          auto-refresh · 5s
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 28, color: "var(--luxe-ink-3)", fontSize: 13 }}>
          No heartbeat events yet. Activity will appear here as agents run.
        </div>
      ) : (
        <div className="luxe-hb-feed">
          {rows.map((e) => {
            const kind = activityKind(e);
            const who = e.agentId ? agentMap.get(e.agentId)?.name ?? "agent" : e.actorType;
            return (
              <div key={e.id} className="luxe-hb-row" data-kind={kind}>
                <span className="luxe-hb-time">{fmtHHMMSS(e.createdAt)}</span>
                <span className="luxe-hb-dot" />
                <span className="luxe-hb-text">
                  <span className="tag">[{kind}]</span>
                  <span className="who">{who}</span>{" "}
                  <span>{e.action.replace(/_/g, " ")} · {e.entityType}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Artifacts card — MOCK until we have an artifacts endpoint.
// ---------------------------------------------------------------------------

function ArtifactsCard({ prefix }: { prefix: string }) {
  // MOCK: the artifact concept isn't a first-class entity yet; the closest
  // real surface is /activity filtered on "created" events.
  const items = [
    { kind: "DOC", title: "Q2 product priorities — synthesis v3", by: "Research · 2m ago" },
    { kind: "MD",  title: "Weekly briefing draft", by: "CEO agent · 6m ago" },
    { kind: "PR",  title: "feat: shared_note_acl migration", by: "Eng · 11m ago" },
    { kind: "IMG", title: "Onboarding illustration frame 4", by: "Design · 18m ago" },
    { kind: "DOC", title: "Shard migration plan — with rollback", by: "CTO agent · 24m ago" },
  ];
  return (
    <div className="luxe-card">
      <div className="luxe-card-head">
        <div>
          <div className="luxe-card-eyebrow">Last 30 minutes</div>
          <div className="luxe-card-title">Latest artifacts</div>
        </div>
        <div className="luxe-spacer" />
        <Link to={`/${prefix}/activity`} className="luxe-btn ghost sm">All activity →</Link>
      </div>
      <div>
        {items.map((a, i) => (
          <a key={i} href="#" className="luxe-artifact-row" onClick={(e) => e.preventDefault()}>
            <div className="luxe-artifact-thumb">{a.kind}</div>
            <div>
              <div className="luxe-artifact-title">{a.title}</div>
              <div className="luxe-artifact-meta">{a.by}</div>
            </div>
            <div className="luxe-artifact-when">mock</div>
            <div className="luxe-artifact-arrow">→</div>
          </a>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tweaks panel — accent swatches + density + theme toggle
// ---------------------------------------------------------------------------

const ACCENT_SWATCHES: { key: LuxeAccent; label: string; color: string }[] = [
  { key: "jade",    label: "Jade",    color: "#4A6B5C" },
  { key: "oxblood", label: "Oxblood", color: "#7A3A34" },
  { key: "ink",     label: "Ink",     color: "#2B2A26" },
  { key: "cobalt",  label: "Cobalt",  color: "#2F4E7A" },
];

function Tweaks({
  open, onClose, accent, setAccent, density, setDensity,
}: {
  open: boolean; onClose: () => void;
  accent: LuxeAccent; setAccent: (v: LuxeAccent) => void;
  density: LuxeDensity; setDensity: (v: LuxeDensity) => void;
}) {
  const { theme, toggleTheme } = useTheme();
  if (!open) return null;
  return (
    <div className="luxe-tweaks" role="dialog" aria-label="Dashboard tweaks">
      <div className="luxe-tweaks-head">
        <span className="luxe-tweaks-title">Tweaks</span>
        <button className="luxe-iconbtn" onClick={onClose} aria-label="Close tweaks">×</button>
      </div>
      <div className="luxe-tweaks-body">
        <div className="luxe-tweaks-row">
          <div className="luxe-tweaks-label">Theme</div>
          <div className="luxe-tweaks-seg">
            <button className={theme === "light" ? "active" : ""} onClick={() => theme === "dark" && toggleTheme()}>Light</button>
            <button className={theme === "dark" ? "active" : ""} onClick={() => theme === "light" && toggleTheme()}>Dark</button>
          </div>
        </div>
        <div className="luxe-tweaks-row">
          <div className="luxe-tweaks-label">Accent</div>
          <div className="luxe-swatches">
            {ACCENT_SWATCHES.map((s) => (
              <button
                key={s.key}
                className={`luxe-swatch ${accent === s.key ? "active" : ""}`}
                onClick={() => setAccent(s.key)}
                style={{ ["--swatch-color" as string]: s.color }}
                aria-label={s.label}
                title={s.label}
              />
            ))}
          </div>
        </div>
        <div className="luxe-tweaks-row">
          <div className="luxe-tweaks-label">Density</div>
          <div className="luxe-tweaks-seg">
            <button className={density === "cozy" ? "active" : ""} onClick={() => setDensity("cozy")}>Cozy</button>
            <button className={density === "compact" ? "active" : ""} onClick={() => setDensity("compact")}>Compact</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Dashboard page
// ---------------------------------------------------------------------------

export function Dashboard() {
  const { selectedCompanyId, selectedCompany, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { accent, setAccent, density, setDensity } = useLuxePrefs();
  const [tweaksOpen, setTweaksOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data: summary, isLoading: summaryLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5_000,
  });
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Empty states (kept from the previous dashboard's UX)
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
  if (summaryLoading) return <PageSkeleton variant="dashboard" />;

  const attn = summary ? buildAttention(summary) : [];
  const runningCount = (agents ?? []).filter((a) => a.status === "running").length;
  const issuesInFlight = (issues ?? []).filter((i) => i.status !== "cancelled").length;
  const prefix = selectedCompany?.issuePrefix ?? "";

  return (
    <div
      className="luxe-root"
      data-accent={accent}
      data-density={density}
      style={{ minHeight: "100%", padding: "36px 32px 80px", maxWidth: 1480, margin: "0 auto", width: "100%" }}
    >
      {error ? <p style={{ color: "var(--luxe-alert)", fontSize: 13 }}>{(error as Error).message}</p> : null}

      {summary && (
        <>
          <PageHead
            companyName={selectedCompany?.name ?? "Your company"}
            runningCount={runningCount}
            attentionCount={attn.length}
          />

          <div className="luxe-grid luxe-grid-12">
            <div className="luxe-col-12"><Stats summary={{
              monthSpendCents: summary.costs.monthSpendCents,
              monthBudgetCents: summary.costs.monthBudgetCents,
              monthUtilizationPercent: summary.costs.monthUtilizationPercent,
              pendingApprovals: summary.pendingApprovals + summary.budgets.pendingApprovals,
            }} issueCount={issuesInFlight} runningCount={runningCount} /></div>

            <div className="luxe-col-8"><AttentionList items={attn} prefix={prefix} /></div>
            <div className="luxe-col-4"><SpendCard summary={summary} /></div>

            <OrgChart agents={agents ?? []} prefix={prefix} />

            <div className="luxe-col-7"><Heartbeat events={activity ?? []} agents={agents ?? []} /></div>
            <div className="luxe-col-5"><ArtifactsCard prefix={prefix} /></div>
          </div>
        </>
      )}

      {!tweaksOpen && (
        <button
          type="button"
          className="luxe-tweaks-fab"
          onClick={() => setTweaksOpen(true)}
          title="Tweaks"
          aria-label="Open tweaks"
        >
          ⚙
        </button>
      )}
      <Tweaks
        open={tweaksOpen}
        onClose={() => setTweaksOpen(false)}
        accent={accent}
        setAccent={setAccent}
        density={density}
        setDensity={setDensity}
      />

    </div>
  );
}
