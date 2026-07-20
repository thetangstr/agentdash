import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  ShieldCheck,
  CheckCircle2,
  Clock,
  XCircle,
  Loader2,
  Play,
  RotateCcw,
  Info,
  KeyRound,
  Activity,
  ChevronRight,
  Quote,
  Link2,
  Fingerprint,
  Copy,
  Check,
  AlertTriangle,
  Timer,
  Users,
  Sparkles,
  FlaskConical,
  ListChecks,
  HelpCircle,
  ExternalLink,
  ScrollText,
} from "lucide-react";
import {
  handshakeDemoApi,
  type HandshakeStep,
  type HandshakeStepStatus,
  type ClockchainCall,
  type ZkPermissionProof,
  type StepMeta,
  type AnchoringEvidence,
} from "../api/handshakeDemo";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

// Link context sourced once from the SEED step's evidence: company route
// prefixes + agent IDs, used to build native AgentDash links for every step.
type StepLinkCtx = {
  payerPrefix?: string;
  payeePrefix?: string;
  grantorAgentId?: string;
  granteeAgentId?: string;
  payeeAgentId?: string;
};

// Build an AgentDash agent-detail path with an EXPLICIT company prefix. The
// app's <Link> (from @/lib/router) runs applyCompanyPrefix, which leaves an
// already-prefixed path untouched — so this works cross-company (payee lives in
// a different company than the payer) exactly like the app's own agent links.
function agentDashPath(prefix: string, agentId: string, tab?: string): string {
  return `/${prefix}/agents/${agentId}${tab ? `/${tab}` : ""}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Agent Trust Handshake — live demo surface.
// Drives POST /handshake-demo/go (step-based, idempotent), pausing at the two
// human-in-the-loop approval gates, and renders every live Clockchain MCP call
// the gateway returned. Honest framing: single-validator testnet.
// ────────────────────────────────────────────────────────────────────────────

type Phase = "idle" | "running" | "awaiting_approval" | "blocked" | "done" | "error";

const MAX_ADVANCES = 25;
const ANCHOR_SETTLE_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The canonical script — shown as a skeleton before/while the run fills it in.
const STEP_ORDER: { key: string; title: string; human?: boolean }[] = [
  { key: "seed", title: "Seed two companies + their agents" },
  { key: "discover", title: "Discover the Clockchain MCP" },
  { key: "onboard", title: "Payer approves Clockchain use", human: true },
  { key: "mandate", title: "CEO grants + anchors the mandate" },
  { key: "accept", title: "Payee accepts the mandate", human: true },
  { key: "transact", title: "Agent attests the payment on-chain" },
];

// While a /go request is in flight, the step being processed is the first
// pending, non-human step after the last completed one. (Human steps resolve
// at the approval gate, so the flow is never in-flight on one.)
function computeRunningStepKey(known: HandshakeStep[]): string | null {
  const byKey = new Map(known.map((s) => [s.key, s]));
  for (const order of STEP_ORDER) {
    if (order.human) continue;
    const st = byKey.get(order.key);
    if (!st || st.status !== "done") return order.key;
  }
  return null;
}

// One-line "what this step demonstrates" blurbs for the About legend.
const STEP_LEGEND: Record<string, string> = {
  seed: "Two companies and their agents come into being, each with an on-chain identity.",
  discover: "The payer's agent finds the Clockchain MCP and its verifiable-trust tools.",
  onboard: "A human at the payer approves using Clockchain — the first consent gate.",
  mandate: "Atlas reasons, then grants a scoped, spend-capped, time-bound mandate, anchored on-chain.",
  accept: "Billie verifies the mandate + counterparty identity (KYA), then accepts — the second gate.",
  transact: "Iris releases the payment and anchors a tamper-evident receipt to a block.",
};

const STATUS_META: Record<
  HandshakeStepStatus,
  { label: string; Icon: ComponentType<{ className?: string }>; color: string; spin?: boolean }
> = {
  done: { label: "Done", Icon: CheckCircle2, color: "var(--success-500)" },
  waiting_approval: { label: "Waiting for you", Icon: Clock, color: "var(--warn-500)" },
  ready: { label: "In progress", Icon: Loader2, color: "var(--accent-500)", spin: true },
  blocked: { label: "Blocked", Icon: XCircle, color: "var(--danger-500)" },
};

// ─────────────────────────────────────────────────────────── small helpers

function tint(color: string, pct = 12): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

function truncMiddle(s: string, head = 10, tail = 8): string {
  if (!s) return "";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// The agent reasoning comes back with \r\n and a box-drawing "Reasoning ──┐"
// banner (and is sometimes duplicated/truncated by the model). Clean it for
// display without losing the substance.
function cleanReasoning(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized
    .split("\n")
    .filter((line) => {
      const stripped = line.replace(/[\s─┐└│┘┌├┤┬┴┼]/g, "");
      // drop pure box-drawing / banner lines like "Reasoning ─────┐"
      if (/^Reasoning$/i.test(stripped)) return false;
      return stripped.length > 0;
    })
    .map((l) => l.trimEnd());
  return lines.join("\n").trim();
}

function formatUnixSeconds(sec: number): string {
  try {
    return new Date(sec * 1000).toLocaleString();
  } catch {
    return String(sec);
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center text-muted-foreground/60 hover:text-foreground transition-colors"
      title="Copy"
      aria-label="Copy value"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// ─────────────────────────────────────────────────────────── status pill

function StatusPill({ status }: { status: HandshakeStepStatus }) {
  const meta = STATUS_META[status];
  const { Icon } = meta;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ color: meta.color, borderColor: tint(meta.color, 35), backgroundColor: tint(meta.color, 10) }}
    >
      <Icon className={cn("h-3 w-3", meta.spin && "animate-spin")} />
      {meta.label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────── evidence fields

function EvidenceField({
  label,
  value,
  mono,
  copy,
  pending,
}: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
  copy?: boolean;
  pending?: boolean;
}) {
  const isEmpty = value === undefined || value === null || value === "";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      {isEmpty ? (
        pending ? (
          <span className="inline-flex w-fit items-center gap-1 rounded bg-warn-500/10 px-1.5 py-0.5 text-[11px] font-medium text-warn-500">
            <Loader2 className="h-3 w-3 animate-spin" /> anchoring…
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/60">—</span>
        )
      ) : (
        <span className={cn("flex items-center gap-1.5 text-xs text-foreground", mono && "font-mono")}>
          <span className="break-all">{mono ? truncMiddle(String(value), 12, 10) : String(value)}</span>
          {copy ? <CopyButton value={String(value)} /> : null}
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── reasoning block

// Fuller (sometimes rambly) model reasoning — collapsed by default when a clean
// one-line decision already leads the card, expanded when there's no headline.
function ReasoningDisclosure({
  agent,
  reasoning,
  defaultOpen,
}: {
  agent: string;
  reasoning: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const text = useMemo(() => cleanReasoning(reasoning), [reasoning]);
  return (
    <div className="overflow-hidden rounded-md border border-border-soft bg-surface-sunken/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] font-medium text-accent-600 hover:bg-surface-sunken"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <Quote className="h-3.5 w-3.5 shrink-0" />
        Full reasoning — why {agent} decided this
      </button>
      {open ? (
        <p className="whitespace-pre-wrap border-t border-border-soft px-3 py-2.5 text-xs leading-relaxed text-text-secondary">
          {text}
        </p>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── timing helpers

// The clean one-line verdict, led prominently: green for APPROVE, red for DECLINE.
function DecisionHeadline({ decision }: { decision: string }) {
  const isDecline = /^\s*DECLINE/i.test(decision);
  const isApprove = /^\s*APPROVE/i.test(decision);
  const color = isDecline ? "var(--danger-500)" : isApprove ? "var(--success-500)" : "var(--accent-600)";
  const Icon = isDecline ? XCircle : CheckCircle2;
  return (
    <div
      className="flex items-start gap-2 rounded-md border px-3 py-2"
      style={{ borderColor: tint(color, 35), backgroundColor: tint(color, 8) }}
    >
      <Icon className="mt-px h-4 w-4 shrink-0" style={{ color }} />
      <span className="text-sm font-semibold leading-snug" style={{ color }}>
        {decision}
      </span>
    </div>
  );
}

// Subtle "expected time" chip on a pending, agent-driven step.
function EstimateChip({ meta }: { meta?: StepMeta }) {
  const secs = meta?.estimateSeconds;
  const label = meta?.label;
  if (secs == null && !label) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border-soft bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      <Timer className="h-3 w-3" />
      {secs != null ? <span className="tabular-nums">~{secs}s</span> : null}
      {secs != null && label ? <span aria-hidden>·</span> : null}
      {label ? <span>{label}</span> : null}
    </span>
  );
}

// Live "not stuck" counter for the step a /go request is currently running.
function LiveStepIndicator({ meta, elapsed }: { meta?: StepMeta; elapsed: number }) {
  const est = meta?.estimateSeconds;
  const over = est != null && elapsed > est;
  const pct = est != null ? Math.min(100, (elapsed / est) * 100) : null;
  return (
    <div className="mt-2 rounded-md border border-accent-500/30 bg-accent-500/[0.06] px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-accent-700">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="tabular-nums">
          {over
            ? `still working… ${elapsed}s (real model + on-chain, can run long)`
            : `reasoning… ${elapsed}s${est != null ? ` / ~${est}s` : ""}`}
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-accent-500/15">
        {pct != null ? (
          <div
            className={cn("h-full rounded-full bg-accent-500 transition-all duration-500", over && "animate-pulse")}
            style={{ width: `${over ? 100 : pct}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent-500" />
        )}
      </div>
    </div>
  );
}

// The on-chain anchoring lifecycle as a legible 3-item checklist.
function AnchoringPanel({ anchoring }: { anchoring: AnchoringEvidence }) {
  return (
    <div className="rounded-md border border-border-soft bg-surface-sunken/60 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-accent-600">
        <Link2 className="h-3.5 w-3.5" />
        Anchoring on the Clockchain
        {anchoring.confirmed ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-success-500/12 px-2 py-0.5 text-[10px] font-medium text-success-500">
            <CheckCircle2 className="h-3 w-3" /> confirmed
            {anchoring.blockHeight != null ? ` · block ${anchoring.blockHeight}` : ""}
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-warn-500/12 px-2 py-0.5 text-[10px] font-medium text-warn-500">
            <Loader2 className="h-3 w-3 animate-spin" /> anchoring…
          </span>
        )}
      </div>
      <ol className="space-y-1.5">
        {anchoring.lifecycle.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            {item.done ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-500" />
            ) : (
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-warn-500" />
            )}
            <span className="min-w-0">
              <span className={item.done ? "text-text-primary" : "text-text-secondary"}>{item.label}</span>
              {item.detail ? (
                <span className="ml-1 break-all font-mono text-[10px] text-muted-foreground">{item.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {anchoring.note ? <p className="mt-2 text-[11px] italic leading-relaxed text-muted-foreground">{anchoring.note}</p> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── ZK proof panel

function ZkProofPanel({ proof }: { proof: ZkPermissionProof }) {
  return (
    <div
      className="rounded-lg border p-3.5"
      style={{ borderColor: tint("var(--accent-500)", 40), backgroundColor: tint("var(--accent-500)", 7) }}
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-accent-700">
          <KeyRound className="h-4 w-4" />
          Zero-knowledge permission proof
        </span>
        <span className="rounded-full border border-accent-200 bg-accent-50 px-2 py-0.5 font-mono text-[10px] text-accent-700">
          {proof.scheme}
        </span>
        {proof.anchored ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success-500/12 px-2 py-0.5 text-[10px] font-medium text-success-500">
            <CheckCircle2 className="h-3 w-3" /> anchored on-chain
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-warn-500/12 px-2 py-0.5 text-[10px] font-medium text-warn-500">
            <Clock className="h-3 w-3" /> not anchored
          </span>
        )}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-text-secondary">
        Proves the agent holds the <span className="font-medium text-foreground">{proof.publicSignals.scope}</span>{" "}
        permission — without revealing the underlying credential. Only the 32-byte proof hash touches the chain.
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <EvidenceField label="Scope" value={proof.publicSignals.scope} mono />
        <EvidenceField label="Valid at" value={formatUnixSeconds(proof.publicSignals.validAt)} />
        <EvidenceField label="Proof hash" value={proof.proofHash} mono copy />
        <EvidenceField label="Nullifier" value={proof.publicSignals.nullifier} mono copy />
        <div className="col-span-2">
          <EvidenceField label="Authority (root)" value={proof.publicSignals.authority} mono copy />
        </div>
      </div>
      {proof.note ? <p className="mt-2.5 text-[11px] italic text-muted-foreground">{proof.note}</p> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── drill-down bits

// "View in AgentDash ↗" — routed through the app's prefix-aware <Link>.
function AgentDashLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 rounded-md border border-accent-500/30 bg-accent-500/[0.06] px-2.5 py-1 text-[11px] font-medium text-accent-700 transition-colors hover:bg-accent-500/12"
    >
      {label}
      <ExternalLink className="h-3 w-3" />
    </Link>
  );
}

// The complete cleaned model transcript — scrollable, monospace.
function TranscriptBlock({ agent, transcript }: { agent: string; transcript: string }) {
  const text = useMemo(() => cleanReasoning(transcript), [transcript]);
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        <ScrollText className="h-3 w-3" /> Full transcript — {agent}
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-soft bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed text-text-secondary">
        {text}
      </pre>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── step card

function StepCard({
  index,
  order,
  live,
  stepMeta,
  running,
  elapsedSec,
  linkCtx,
  stepCalls,
  pendingApprovalId,
  onApprove,
  approving,
  busy,
}: {
  index: number;
  order: { key: string; title: string; human?: boolean };
  live?: HandshakeStep;
  stepMeta?: StepMeta;
  running: boolean;
  elapsedSec: number;
  linkCtx: StepLinkCtx;
  stepCalls: ClockchainCall[];
  pendingApprovalId: string | null;
  onApprove: () => void;
  approving: boolean;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const status: HandshakeStepStatus | "pending" = live?.status ?? "pending";
  const meta = status === "pending" ? null : STATUS_META[status];
  const ev = live?.evidence;
  const gateActive = status === "waiting_approval" && !!live?.approvalId && live.approvalId === pendingApprovalId;
  const isHuman = !!order.human || !!stepMeta?.human;

  const hasEvidenceBody =
    !!ev &&
    (ev.mandateId != null ||
      ev.ledgerId != null ||
      ev.eventHash != null ||
      ev.counterpartyDid != null ||
      ev.decision != null ||
      ev.anchoring != null ||
      ev.grantorReasoning != null ||
      ev.granteeReasoning != null ||
      ev.zkPermissionProof != null);

  // Records produced by this step (recapped in the drill-down for legibility).
  const hasRecords =
    !!ev &&
    (ev.mandateId != null ||
      ev.ledgerId != null ||
      ev.eventHash != null ||
      ev.blockHeight != null ||
      ev.zkPermissionProof != null);

  // Native AgentDash links for this step. Agent IDs prefer this step's own
  // evidence, falling back to the once-read seed context. Prefixes are explicit
  // so the payee link (a different company) resolves the same way.
  const grantorAgentId = ev?.grantorAgentId ?? linkCtx.grantorAgentId;
  const granteeAgentId = ev?.granteeAgentId ?? linkCtx.granteeAgentId;
  const payeeAgentId = ev?.payeeAgentId ?? linkCtx.payeeAgentId;
  const grantorName = ev?.grantorAgent ?? "grantor agent";
  const granteeName = ev?.granteeAgent ?? "payments agent";

  const stepLinks: { to: string; label: string }[] = [];
  if (order.key === "mandate") {
    if (linkCtx.payerPrefix && grantorAgentId)
      stepLinks.push({ to: agentDashPath(linkCtx.payerPrefix, grantorAgentId), label: `${grantorName} in AgentDash` });
    if (linkCtx.payerPrefix && granteeAgentId)
      stepLinks.push({ to: agentDashPath(linkCtx.payerPrefix, granteeAgentId, "mandates"), label: "Mandate & receipts" });
  } else if (order.key === "transact") {
    if (linkCtx.payerPrefix && granteeAgentId)
      stepLinks.push({ to: agentDashPath(linkCtx.payerPrefix, granteeAgentId), label: `${granteeName} in AgentDash` });
    if (linkCtx.payerPrefix && granteeAgentId)
      stepLinks.push({ to: agentDashPath(linkCtx.payerPrefix, granteeAgentId, "mandates"), label: "Mandate & receipts" });
  } else if (order.key === "accept") {
    if (linkCtx.payeePrefix && payeeAgentId)
      stepLinks.push({ to: agentDashPath(linkCtx.payeePrefix, payeeAgentId), label: "Payee agent in AgentDash" });
  }

  const fullTranscripts: { agent: string; transcript: string }[] = [];
  if (ev?.grantorFullReasoning) fullTranscripts.push({ agent: grantorName, transcript: ev.grantorFullReasoning });
  if (ev?.granteeFullReasoning) fullTranscripts.push({ agent: granteeName, transcript: ev.granteeFullReasoning });

  const hasDrilldown = fullTranscripts.length > 0 || stepCalls.length > 0 || hasRecords || stepLinks.length > 0;

  return (
    <div
      className={cn(
        "relative rounded-lg border bg-surface-raised p-4 transition-colors",
        status === "pending" ? "border-border-soft/60 opacity-70" : "border-border-soft shadow-sm",
        gateActive && "ring-2 ring-warn-500/40",
      )}
    >
      <div className="flex items-start gap-3">
        {/* index / status dot */}
        <div
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
          style={
            meta
              ? { color: meta.color, backgroundColor: tint(meta.color, 14), border: `1px solid ${tint(meta.color, 40)}` }
              : { color: "var(--text-tertiary)", backgroundColor: "var(--surface-sunken)", border: "1px solid var(--border-soft)" }
          }
        >
          {meta ? <meta.Icon className={cn("h-3.5 w-3.5", meta.spin && "animate-spin")} /> : index + 1}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={cn("text-sm font-medium", status === "pending" ? "text-muted-foreground" : "text-text-primary")}>
              {live?.title ?? order.title}
            </h3>
            {order.human ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-border-soft bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                <ShieldCheck className="h-3 w-3" /> human consent
              </span>
            ) : null}
            {status === "done" && ev?.reasoningSeconds != null ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-success-500/30 bg-success-500/10 px-1.5 py-0.5 text-[10px] font-medium text-success-500">
                <Timer className="h-3 w-3" /> decided in <span className="tabular-nums">{ev.reasoningSeconds}s</span>
              </span>
            ) : null}
            <span className="ml-auto">
              {status === "pending" ? (
                <span className="rounded-full border border-border-soft px-2 py-0.5 text-[11px] text-muted-foreground">Pending</span>
              ) : (
                <StatusPill status={status} />
              )}
            </span>
          </div>

          {/* Timing: live "not stuck" counter while running, else the estimate. */}
          {running ? (
            <LiveStepIndicator meta={stepMeta} elapsed={elapsedSec} />
          ) : status === "pending" ? (
            <div className="mt-2">
              {isHuman ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-warn-500/30 bg-warn-500/10 px-2 py-0.5 text-[10px] font-medium text-warn-500">
                  <Clock className="h-3 w-3" /> waiting for you
                </span>
              ) : (
                <EstimateChip meta={stepMeta} />
              )}
            </div>
          ) : null}

          {live?.detail ? <p className="mt-1 text-xs text-muted-foreground">{live.detail}</p> : null}

          {/* Human-in-the-loop approval gate */}
          {gateActive ? (
            <div className="mt-3 flex flex-col gap-2 rounded-md border border-warn-500/40 bg-warn-500/[0.07] p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-text-secondary">
                A human must approve before the flow continues. This is the consent gate — nothing proceeds until you click.
              </p>
              <Button size="sm" onClick={onApprove} disabled={approving || busy} className="shrink-0">
                {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {approving ? "Approving…" : "Approve"}
              </Button>
            </div>
          ) : null}

          {/* Evidence */}
          {hasEvidenceBody ? (
            <div className="mt-3 space-y-3">
              {/* Lead with the clean one-line verdict. */}
              {ev?.decision ? <DecisionHeadline decision={ev.decision} /> : null}

              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                {ev?.mandateId != null ? <EvidenceField label="Mandate ID" value={ev.mandateId} mono copy /> : null}
                {ev?.ledgerId != null ? <EvidenceField label="Ledger ID" value={ev.ledgerId} mono copy /> : null}
                {/* When the anchoring lifecycle is present it owns the block height. */}
                {"blockHeight" in (ev ?? {}) && !ev?.anchoring ? (
                  <EvidenceField label="Block height" value={ev?.blockHeight ?? null} mono pending />
                ) : null}
                {ev?.eventHash != null ? <EvidenceField label="Event hash" value={ev.eventHash} mono copy /> : null}
                {ev?.counterpartyDid != null ? (
                  <div className="col-span-2">
                    <EvidenceField label="Counterparty DID" value={ev.counterpartyDid} mono copy />
                  </div>
                ) : null}
              </div>

              {ev?.anchoring ? <AnchoringPanel anchoring={ev.anchoring} /> : null}

              {ev?.grantorReasoning ? (
                <ReasoningDisclosure
                  agent={ev.grantorAgent ?? "the CEO agent"}
                  reasoning={ev.grantorReasoning}
                  defaultOpen={!ev.decision}
                />
              ) : null}
              {ev?.granteeReasoning ? (
                <ReasoningDisclosure
                  agent={ev.granteeAgent ?? "the payments agent"}
                  reasoning={ev.granteeReasoning}
                  defaultOpen={!ev.decision}
                />
              ) : null}

              {ev?.zkPermissionProof ? <ZkProofPanel proof={ev.zkPermissionProof} /> : null}
            </div>
          ) : null}

          {/* Drill-down: what ACTUALLY happened in this step. */}
          {hasDrilldown ? (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-accent-600 hover:underline"
                aria-expanded={expanded}
              >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
                {expanded ? "Hide step detail" : "See what actually happened"}
              </button>

              {expanded ? (
                <div className="mt-2.5 space-y-3 rounded-md border border-border-soft bg-surface-sunken/40 p-3">
                  {/* Full model transcript(s) */}
                  {fullTranscripts.map((t, i) => (
                    <TranscriptBlock key={i} agent={t.agent} transcript={t.transcript} />
                  ))}

                  {/* Records produced */}
                  {hasRecords ? (
                    <div>
                      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        <Fingerprint className="h-3 w-3" /> Records produced
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-md border border-border-soft bg-surface-raised p-3">
                        {ev?.mandateId != null ? <EvidenceField label="Mandate ID" value={ev.mandateId} mono copy /> : null}
                        {ev?.ledgerId != null ? <EvidenceField label="Ledger ID" value={ev.ledgerId} mono copy /> : null}
                        {ev?.blockHeight != null ? <EvidenceField label="Block height" value={ev.blockHeight} mono /> : null}
                        {ev?.eventHash != null ? <EvidenceField label="Event hash" value={ev.eventHash} mono copy /> : null}
                        {ev?.zkPermissionProof != null ? (
                          <div className="col-span-2">
                            <EvidenceField label="ZK proof hash" value={ev.zkPermissionProof.proofHash} mono copy />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {/* The Clockchain calls made during this step */}
                  {stepCalls.length > 0 ? (
                    <div>
                      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        <Activity className="h-3 w-3" /> Clockchain calls in this step ({stepCalls.length})
                      </div>
                      <div className="space-y-2">
                        {stepCalls.map((c, i) => (
                          <CallRow key={`${c.tool}-${i}`} call={c} index={i} />
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* Native links into the real AgentDash records */}
                  {stepLinks.length > 0 ? (
                    <div>
                      <div className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Open in AgentDash
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {stepLinks.map((l, i) => (
                          <AgentDashLink key={i} to={l.to} label={l.label} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── MCP call row

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <pre className="max-h-64 overflow-auto rounded-md border border-border-soft bg-surface-sunken p-2.5 font-mono text-[11px] leading-relaxed text-text-primary">
        {text}
      </pre>
    </div>
  );
}

function CallRow({ call, index }: { call: ClockchainCall; index: number }) {
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const ok = call.status === "ok";
  const host = useMemo(() => {
    try {
      return new URL(call.endpoint).host;
    } catch {
      return call.endpoint;
    }
  }, [call.endpoint]);

  return (
    <div className="overflow-hidden rounded-md border border-border-soft bg-surface-raised">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-sunken/60"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="text-[11px] tabular-nums text-muted-foreground/70">{String(index + 1).padStart(2, "0")}</span>
        <span className="truncate font-mono text-xs font-medium text-text-primary">{call.tool}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{call.latencyMs} ms</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              ok ? "bg-success-500/12 text-success-500" : "bg-danger-500/12 text-danger-500",
            )}
          >
            {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
            {ok ? "ok" : "error"}
          </span>
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border-soft px-3 py-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Link2 className="h-3 w-3" />
            <span className="font-mono">{host}</span>
          </div>
          <JsonBlock label="Request args" value={call.requestArgs} />
          {call.error ? (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-danger-500">Error</div>
              <pre className="overflow-auto rounded-md border border-danger-500/30 bg-danger-500/[0.06] p-2.5 font-mono text-[11px] leading-relaxed text-danger-500">
                {call.error}
              </pre>
            </div>
          ) : null}
          {call.response !== undefined ? <JsonBlock label="Gateway response" value={call.response} /> : null}
          {call.rawResponse ? (
            <div>
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="text-[11px] font-medium text-accent-600 hover:underline"
              >
                {showRaw ? "Hide" : "Show"} raw gateway payload (SSE)
              </button>
              {showRaw ? (
                <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border border-border-soft bg-surface-sunken p-2.5 font-mono text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap break-all">
                  {call.rawResponse}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── about / context

function CastMember({ name, role }: { name: string; role: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-medium text-text-primary">{name}</span>
      <span className="text-[11px] text-muted-foreground">{role}</span>
    </span>
  );
}

// Collapsible narrative: what this demo is, the idea, the cast, and what's real.
function AboutDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border-soft bg-surface-raised shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-sunken/50"
        aria-expanded={open}
      >
        <HelpCircle className="h-4 w-4 shrink-0 text-accent-600" />
        <span className="text-sm font-semibold text-text-primary">What this demo is</span>
        <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
          the problem, the idea, the cast, and what's real vs simulated
        </span>
        <ChevronRight className={cn("ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>

      {open ? (
        <div className="space-y-4 border-t border-border-soft px-4 py-4">
          {/* Problem */}
          <section>
            <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-text-primary">
              <AlertTriangle className="h-3.5 w-3.5 text-warn-500" /> The problem
            </h3>
            <p className="text-xs leading-relaxed text-text-secondary">
              When an AI agent at one company needs to transact with an AI agent at another, how does either side{" "}
              <span className="font-medium text-text-primary">trust</span> the other — that the paying agent is actually
              authorized, that the counterparty is who it claims to be, and that what happened can't be denied later?
              Today that trust simply doesn't exist between autonomous agents.
            </p>
          </section>

          {/* Idea */}
          <section>
            <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-text-primary">
              <Sparkles className="h-3.5 w-3.5 text-accent-600" /> The idea
            </h3>
            <p className="text-xs leading-relaxed text-text-secondary">
              Clockchain is the neutral, verifiable record. Authority is granted as a{" "}
              <span className="font-medium text-text-primary">scoped, spend-capped, time-bound mandate</span> that's
              cryptographically anchored; the counterparty is checked with{" "}
              <span className="font-medium text-text-primary">Know-Your-Agent (KYA)</span> identity verification valid at
              that instant; and every action produces a{" "}
              <span className="font-medium text-text-primary">tamper-evident, independently-verifiable receipt</span>{" "}
              anchored to a block. No one has to take anyone's word.
            </p>
          </section>

          {/* Cast */}
          <section>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-text-primary">
              <Users className="h-3.5 w-3.5 text-accent-600" /> The cast
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-md border border-border-soft bg-surface-sunken/50 p-2.5">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  Meridian Pay <span className="font-normal normal-case text-muted-foreground">· payer</span>
                </div>
                <ul className="space-y-0.5 text-xs text-text-secondary">
                  <li><CastMember name="Atlas" role="— CEO, grants the mandate" /></li>
                  <li><CastMember name="Iris" role="— payments agent, releases funds" /></li>
                </ul>
              </div>
              <div className="rounded-md border border-border-soft bg-surface-sunken/50 p-2.5">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  Trellis Freight <span className="font-normal normal-case text-muted-foreground">· payee</span>
                </div>
                <ul className="space-y-0.5 text-xs text-text-secondary">
                  <li><CastMember name="Billie" role="— accepts the mandate" /></li>
                </ul>
              </div>
            </div>
          </section>

          {/* Real vs demo */}
          <section>
            <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-text-primary">
              <FlaskConical className="h-3.5 w-3.5 text-accent-600" /> What's real here vs simulated
            </h3>
            <ul className="space-y-1 text-xs leading-relaxed text-text-secondary">
              <li className="flex items-start gap-1.5">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-500" />
                <span>
                  The agents' decisions are <span className="font-medium text-text-primary">real, live-model reasoning</span> — not scripted.
                </span>
              </li>
              <li className="flex items-start gap-1.5">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-500" />
                <span>
                  The mandate anchor, KYA, attestation, receipt, and the zero-knowledge permission proof are all{" "}
                  <span className="font-medium text-text-primary">real Clockchain calls</span> — shown live in the calls panel.
                </span>
              </li>
              <li className="flex items-start gap-1.5">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn-500" />
                <span>
                  It runs on a <span className="font-medium text-text-primary">single-validator testnet</span> (every receipt
                  self-discloses this) — a demonstration of the trust flow, not a mainnet or court-grade attestation.
                </span>
              </li>
              <li className="flex items-start gap-1.5">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn-500" />
                <span>Money movement (x402) is <span className="font-medium text-text-primary">simulated</span>.</span>
              </li>
            </ul>
          </section>

          {/* Step legend */}
          <section>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-text-primary">
              <ListChecks className="h-3.5 w-3.5 text-accent-600" /> What each step demonstrates
            </h3>
            <ol className="space-y-1">
              {STEP_ORDER.map((order, i) => (
                <li key={order.key} className="flex items-start gap-2 text-xs text-text-secondary">
                  <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-semibold text-text-tertiary">
                    {i + 1}
                  </span>
                  <span>
                    <span className="font-medium text-text-primary">{order.title}</span>
                    {STEP_LEGEND[order.key] ? <span className="text-muted-foreground"> — {STEP_LEGEND[order.key]}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── main page

export function HandshakeDemo() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [steps, setSteps] = useState<HandshakeStep[]>([]);
  const [stepMeta, setStepMeta] = useState<Record<string, StepMeta>>({});
  const [calls, setCalls] = useState<ClockchainCall[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusyState] = useState(false);

  // Live "not stuck" counter for the step a /go request is currently running.
  const [inFlightStep, setInFlightStep] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agent Trust Handshake" }]);
  }, [setBreadcrumbs]);

  // Never leak the ticking interval across unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const setBusy = (v: boolean) => {
    busyRef.current = v;
    setBusyState(v);
  };

  function startTimer(key: string | null) {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (!key) {
      setInFlightStep(null);
      setElapsedSec(0);
      return;
    }
    setInFlightStep(key);
    setElapsedSec(0);
    const start = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedSec(Math.max(0, Math.round((Date.now() - start) / 1000)));
    }, 500);
  }

  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setInFlightStep(null);
    setElapsedSec(0);
  }

  const liveByKey = useMemo(() => {
    const map = new Map<string, HandshakeStep>();
    for (const s of steps) map.set(s.key, s);
    return map;
  }, [steps]);

  // Advance repeatedly until the flow pauses (gate), finishes, blocks, or errors.
  // `initialKnown` seeds the "which step is running" computation (steps state
  // lags a render behind the loop's local view).
  async function drive(initialKnown: HandshakeStep[]): Promise<void> {
    let known = initialKnown;
    for (let i = 0; i < MAX_ADVANCES; i++) {
      // The step this /go will process — start its live counter before awaiting.
      const runningKey = computeRunningStepKey(known);
      startTimer(runningKey);
      let res;
      try {
        res = await handshakeDemoApi.go();
      } catch (e) {
        stopTimer();
        setErrorMsg(e instanceof Error ? e.message : "Advance failed");
        setPhase("error");
        return;
      }
      stopTimer();
      setSteps(res.steps);
      if (res.stepMeta) setStepMeta(res.stepMeta);

      // Attribute this batch's Clockchain calls to the step(s) it completed:
      // any step that flipped to "done" in this response. If none flipped (e.g.
      // an anchor-pending interim), fall back to the step this batch was running.
      if (res.clockchainCalls?.length) {
        const prevDone = new Set(known.filter((s) => s.status === "done").map((s) => s.key));
        const newlyDone = res.steps.filter((s) => s.status === "done" && !prevDone.has(s.key)).map((s) => s.key);
        const stepKeys = newlyDone.length > 0 ? newlyDone : runningKey ? [runningKey] : [];
        const tagged = res.clockchainCalls.map((c) => ({ ...c, stepKeys }));
        setCalls((prev) => [...prev, ...tagged]);
      }
      known = res.steps;

      const last = res.steps[res.steps.length - 1];
      if (res.done) {
        setPhase("done");
        return;
      }
      if (last?.status === "waiting_approval" && last.approvalId) {
        setPendingApprovalId(last.approvalId);
        setPhase("awaiting_approval");
        return;
      }
      if (last?.status === "blocked") {
        setPhase("blocked");
        return;
      }
      // status "ready"/interim (e.g. anchor pending) → let it settle, re-run Go.
      await sleep(ANCHOR_SETTLE_MS);
    }
    setErrorMsg("The handshake did not converge — try again or check the server logs.");
    setPhase("error");
  }

  async function handleRun(reset: boolean) {
    if (busyRef.current) return;
    setBusy(true);
    setErrorMsg(null);
    setPendingApprovalId(null);
    let known = steps;
    if (reset) {
      // Snap the timeline back to the 6-step Pending skeleton immediately,
      // before the (possibly slow) server reset + fresh run begin.
      setSteps([]);
      setCalls([]);
      setStepMeta({});
      known = [];
      setPhase("running");
      // Clear the server's prior run so /go re-derives from step 1 rather than
      // replaying an already-completed handshake. Companies + agents persist.
      try {
        await handshakeDemoApi.reset();
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : "Could not reset the demo");
        setPhase("error");
        setBusy(false);
        return;
      }
    } else {
      setPhase("running");
    }
    await drive(known);
    setBusy(false);
  }

  async function handleApprove() {
    if (busyRef.current || !pendingApprovalId) return;
    setBusy(true);
    setPhase("running");
    try {
      await handshakeDemoApi.approve(pendingApprovalId);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Approval failed");
      setPhase("error");
      setBusy(false);
      return;
    }
    setPendingApprovalId(null);
    // steps still reflects the just-approved gate; drive() skips human steps.
    await drive(steps);
    setBusy(false);
  }

  const started = steps.length > 0 || phase !== "idle";
  const okCalls = calls.filter((c) => c.status === "ok").length;

  // Read the link context (company prefixes + agent IDs) once from the seed step.
  const linkCtx = useMemo<StepLinkCtx>(() => {
    const seedEv = liveByKey.get("seed")?.evidence;
    return {
      payerPrefix: seedEv?.payerPrefix,
      payeePrefix: seedEv?.payeePrefix,
      grantorAgentId: seedEv?.grantorAgentId,
      granteeAgentId: seedEv?.granteeAgentId,
      payeeAgentId: seedEv?.payeeAgentId,
    };
  }, [liveByKey]);

  // Group Clockchain calls by the step key(s) they were attributed to in drive().
  const callsByStep = useMemo(() => {
    const map = new Map<string, ClockchainCall[]>();
    for (const c of calls) {
      for (const k of c.stepKeys ?? []) {
        const arr = map.get(k) ?? [];
        arr.push(c);
        map.set(k, arr);
      }
    }
    return map;
  }, [calls]);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Header */}
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-50 text-accent-600">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <h1 className="text-xl font-semibold text-text-primary">Agent Trust Handshake</h1>
        </div>
        <p className="max-w-3xl text-sm text-text-secondary">
          Two companies, two agents. A CEO agent grants a scoped, capped payment mandate; the payee accepts; the
          payments agent releases the money — every decision authored by a real model, every receipt anchored on the
          Clockchain. Two human consent gates keep a person in the loop.
        </p>
        <div className="flex items-start gap-1.5 rounded-md border border-border-soft bg-surface-sunken/60 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Runs on the single-validator Clockchain <span className="font-medium text-text-secondary">testnet</span> —
            receipts self-disclose it. This is a demonstration of the trust flow, not a mainnet or court-grade
            attestation.
          </span>
        </div>
      </header>

      {/* Context / narrative — what this demo actually is */}
      <AboutDemo />

      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-soft bg-surface-raised p-4 shadow-sm">
        {phase === "awaiting_approval" ? (
          <Button size="lg" onClick={handleApprove} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Approve &amp; continue
          </Button>
        ) : phase === "done" ? (
          <Button size="lg" variant="outline" onClick={() => handleRun(true)} disabled={busy}>
            <RotateCcw className="h-4 w-4" /> Run again
          </Button>
        ) : (
          <Button size="lg" onClick={() => handleRun(!started || phase === "error" || phase === "blocked")} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {busy ? "Running…" : started && (phase === "blocked" || phase === "error") ? "Retry the handshake" : "Run the Handshake"}
          </Button>
        )}

        <div className="min-w-0 flex-1 text-sm">
          {phase === "idle" ? (
            <span className="text-muted-foreground">Press run to drive the full flow end-to-end.</span>
          ) : phase === "running" ? (
            <span className="inline-flex items-center gap-2 text-text-secondary">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-500 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-500" />
              </span>
              Working — real model inference + on-chain anchoring run ~15–20s per step.
            </span>
          ) : phase === "awaiting_approval" ? (
            <span className="inline-flex items-center gap-1.5 text-warn-500">
              <Clock className="h-4 w-4" /> Paused for human approval — approve to continue.
            </span>
          ) : phase === "done" ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-success-500">
              <CheckCircle2 className="h-4 w-4" /> Handshake complete — payment attested and anchored.
            </span>
          ) : phase === "blocked" ? (
            <span className="inline-flex items-center gap-1.5 text-danger-500">
              <XCircle className="h-4 w-4" /> Flow blocked — see the step below.
            </span>
          ) : phase === "error" ? (
            <span className="inline-flex items-center gap-1.5 text-danger-500">
              <AlertTriangle className="h-4 w-4" /> {errorMsg ?? "Something went wrong."}
            </span>
          ) : null}
        </div>

        {calls.length > 0 ? (
          <span className="shrink-0 rounded-full border border-border-soft bg-surface-sunken px-2.5 py-1 font-mono text-[11px] text-text-secondary">
            {okCalls}/{calls.length} MCP calls ok
          </span>
        ) : null}
      </div>

      {/* Two-column: timeline + live MCP calls */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Timeline */}
        <div className="space-y-3 lg:col-span-7">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
            <Fingerprint className="h-4 w-4 text-accent-600" /> Handshake timeline
          </h2>
          {STEP_ORDER.map((order, i) => (
            <StepCard
              key={order.key}
              index={i}
              order={order}
              live={liveByKey.get(order.key)}
              stepMeta={stepMeta[order.key]}
              running={busy && inFlightStep === order.key}
              elapsedSec={elapsedSec}
              linkCtx={linkCtx}
              stepCalls={callsByStep.get(order.key) ?? []}
              pendingApprovalId={pendingApprovalId}
              onApprove={handleApprove}
              approving={busy && phase === "running"}
              busy={busy}
            />
          ))}
          {busy && phase === "running" ? (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-border-soft bg-surface-sunken/40 px-4 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-500" />
              Advancing the next step… (agents deciding + anchoring on-chain)
            </div>
          ) : null}
        </div>

        {/* Live MCP calls */}
        <div className="lg:col-span-5">
          <div className="lg:sticky lg:top-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                <Activity className="h-4 w-4 text-accent-600" /> Clockchain MCP — live calls
              </h2>
              <span className="font-mono text-[11px] text-muted-foreground">{calls.length}</span>
            </div>
            <p className="mb-2.5 text-[11px] text-muted-foreground">
              Every request the demo made to <span className="font-mono">mcp.clockchain.network</span> during this run —
              exact args and the raw JSON the gateway returned. Nothing mocked.
            </p>
            {calls.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border-soft bg-surface-sunken/40 px-4 py-10 text-center text-xs text-muted-foreground">
                No calls yet — run the handshake to see live gateway traffic.
              </div>
            ) : (
              <div className="space-y-2">
                {calls.map((call, i) => (
                  <CallRow key={`${call.tool}-${i}`} call={call} index={i} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
