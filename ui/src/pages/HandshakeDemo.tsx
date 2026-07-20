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
} from "lucide-react";
import {
  handshakeDemoApi,
  type HandshakeStep,
  type HandshakeStepStatus,
  type ClockchainCall,
  type ZkPermissionProof,
} from "../api/handshakeDemo";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

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

function ReasoningBlock({ agent, reasoning }: { agent: string; reasoning: string }) {
  const text = useMemo(() => cleanReasoning(reasoning), [reasoning]);
  return (
    <div className="rounded-md border border-border-soft bg-surface-sunken/60 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-accent-600">
        <Quote className="h-3.5 w-3.5" />
        Why {agent} decided this
      </div>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">{text}</p>
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

// ─────────────────────────────────────────────────────────── step card

function StepCard({
  index,
  order,
  live,
  pendingApprovalId,
  onApprove,
  approving,
  busy,
}: {
  index: number;
  order: { key: string; title: string; human?: boolean };
  live?: HandshakeStep;
  pendingApprovalId: string | null;
  onApprove: () => void;
  approving: boolean;
  busy: boolean;
}) {
  const status: HandshakeStepStatus | "pending" = live?.status ?? "pending";
  const meta = status === "pending" ? null : STATUS_META[status];
  const ev = live?.evidence;
  const gateActive = status === "waiting_approval" && !!live?.approvalId && live.approvalId === pendingApprovalId;

  const hasEvidenceBody =
    !!ev &&
    (ev.mandateId != null ||
      ev.ledgerId != null ||
      ev.eventHash != null ||
      ev.counterpartyDid != null ||
      ev.grantorReasoning != null ||
      ev.granteeReasoning != null ||
      ev.zkPermissionProof != null);

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
            <span className="ml-auto">
              {status === "pending" ? (
                <span className="rounded-full border border-border-soft px-2 py-0.5 text-[11px] text-muted-foreground">Pending</span>
              ) : (
                <StatusPill status={status} />
              )}
            </span>
          </div>

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
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                {ev?.mandateId != null ? <EvidenceField label="Mandate ID" value={ev.mandateId} mono copy /> : null}
                {ev?.ledgerId != null ? <EvidenceField label="Ledger ID" value={ev.ledgerId} mono copy /> : null}
                {"blockHeight" in (ev ?? {}) ? (
                  <EvidenceField label="Block height" value={ev?.blockHeight ?? null} mono pending />
                ) : null}
                {ev?.eventHash != null ? <EvidenceField label="Event hash" value={ev.eventHash} mono copy /> : null}
                {ev?.counterpartyDid != null ? (
                  <div className="col-span-2">
                    <EvidenceField label="Counterparty DID" value={ev.counterpartyDid} mono copy />
                  </div>
                ) : null}
              </div>

              {ev?.grantorReasoning ? (
                <ReasoningBlock agent={ev.grantorAgent ?? "the CEO agent"} reasoning={ev.grantorReasoning} />
              ) : null}
              {ev?.granteeReasoning ? (
                <ReasoningBlock agent={ev.granteeAgent ?? "the payments agent"} reasoning={ev.granteeReasoning} />
              ) : null}

              {ev?.zkPermissionProof ? <ZkProofPanel proof={ev.zkPermissionProof} /> : null}
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

// ─────────────────────────────────────────────────────────── main page

export function HandshakeDemo() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [steps, setSteps] = useState<HandshakeStep[]>([]);
  const [calls, setCalls] = useState<ClockchainCall[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusyState] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agent Trust Handshake" }]);
  }, [setBreadcrumbs]);

  const setBusy = (v: boolean) => {
    busyRef.current = v;
    setBusyState(v);
  };

  const liveByKey = useMemo(() => {
    const map = new Map<string, HandshakeStep>();
    for (const s of steps) map.set(s.key, s);
    return map;
  }, [steps]);

  // Advance repeatedly until the flow pauses (gate), finishes, blocks, or errors.
  async function drive(): Promise<void> {
    for (let i = 0; i < MAX_ADVANCES; i++) {
      let res;
      try {
        res = await handshakeDemoApi.go();
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : "Advance failed");
        setPhase("error");
        return;
      }
      setSteps(res.steps);
      if (res.clockchainCalls?.length) setCalls((prev) => [...prev, ...res.clockchainCalls]);

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
    if (reset) {
      setSteps([]);
      setCalls([]);
    }
    setPhase("running");
    await drive();
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
    await drive();
    setBusy(false);
  }

  const started = steps.length > 0 || phase !== "idle";
  const okCalls = calls.filter((c) => c.status === "ok").length;

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
