import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActorRow, CompositeResult, EvaluationConfidenceTier, EvaluationExceptionSeverity, EvaluationMetricKey, MetricResult } from "@paperclipai/shared";
import { EVALUATION_CONFIDENCE_LABELS, EVALUATION_METRIC_FORMULAS, EVALUATION_METRIC_NAMES } from "@paperclipai/shared";
import { evaluationApi } from "@/api/evaluation";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * AgentDash: Company Evaluator — Milestone 4 building blocks. Every number a
 * reader sees here comes with its confidence, its formula and the events behind
 * it; nothing is shown at the Insufficient tier except the words that say so.
 */

/** The §7 words for a tier, from the shared constant the server uses; a metric's own `confidenceLabel` wins when given. */
export function ConfidenceBadge({ tier, label }: { tier: EvaluationConfidenceTier | null | undefined; label?: string | null }) {
  if (!tier) return <Badge variant="ghost">no evidence yet</Badge>;
  const variant = tier === "high" ? "default" : tier === "medium" ? "secondary" : tier === "low" ? "outline" : "destructive";
  return <Badge variant={variant}>{label ?? EVALUATION_CONFIDENCE_LABELS[tier]}</Badge>;
}

/** Actor rows carry a name only for agents on the roster; the company row and an unrostered agent get words, never an id. */
export function actorDisplayName(row: Pick<ActorRow, "actorType" | "name">): string {
  if (row.name) return row.name;
  return row.actorType === "agent" ? "an agent not on the roster" : "Company and platform";
}

/** The one sentence every composite shares, with the implementation version that produced the number. */
export function compositeDescription(c: CompositeResult | null | undefined, kind: "outcome" | "operating"): string {
  return `Coverage-weighted mean of the included ${kind} metrics, 0–100 (each metric's weight times its coverage, divided by the sum of those products); withheld when a guard fails. Composite ${c?.formulaVersion ?? "—"}.`;
}

/** A metric's name for prose; keys stay in the Key column where they are the lookup. */
export function metricName(key: EvaluationMetricKey): string {
  return EVALUATION_METRIC_NAMES[key] ?? key;
}

/** What a composite included and left out, in names. */
export function includedLine(c: CompositeResult): string {
  return c.included.map((i) => `${metricName(i.key)} (weight ${i.weight} × coverage ${fmtPct(i.coverage)} = ${Math.round(i.weight * i.coverage * 1000) / 1000}, value ${Math.round(i.scaled)})`).join("; ");
}
export function excludedLine(c: CompositeResult): string {
  return c.excluded.map((x) => `${metricName(x.key)} — ${x.reason}`).join("; ");
}

/** Exception routes in words (spec §9.1), from the reader's seat. */
export function routeWords(routes: readonly string[], seat: "founder" | "milestone"): string {
  const word = (r: string) => {
    switch (r) {
      case "founder_view":
        return seat === "founder" ? "your view" : "the founder's view";
      case "accountable_owner":
        return "the accountable owner";
      case "manager":
        return "the manager";
      default:
        return r.replace(/_/g, " ");
    }
  };
  return [...new Set(routes.map(word))].join(", ");
}

export function SeverityBadge({ severity }: { severity: EvaluationExceptionSeverity }) {
  const variant = severity === "immediate" ? "destructive" : severity === "material" ? "default" : "secondary";
  return <Badge variant={variant}>{severity}</Badge>;
}

export function fmtScore(score: number | null | undefined): string {
  return score == null ? "—" : String(Math.round(score));
}
export function fmtPct(share: number | null | undefined): string {
  return share == null ? "—" : `${Math.round(share * 100)}%`;
}
export function fmtCents(cents: number | null | undefined): string {
  return cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;
}
export function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}
/** Rendered from the kind the engine declared — never inferred from the key or the unit text. A card without a kind renders value and unit. */
export function fmtValue(m: MetricResult): string {
  if (m.value == null) return "—";
  switch (m.valueKind) {
    case "share":
      return fmtPct(m.value);
    case "count": {
      const n = Math.round(m.value);
      // the unit is a noun phrase whose plural noun may lead ("questions unanswered past 48 h") or trail
      // ("detected violations"); one of them drops the s from the first word that carries it
      const unit = n === 1 ? m.unit.replace(/\b(\w+?)s\b/, "$1") : m.unit;
      return `${n} ${unit}`.trim();
    }
    case "currency":
      return `$${(m.value / 100).toFixed(2)} ${m.unit.replace(/^cents\s+/, "")}`.trim();
    case "status":
      return m.unit;
    case "duration":
    case "index":
    default:
      return `${Math.round(m.value * 100) / 100} ${m.unit}`.trim();
  }
}

/** Primitive entries of a metric's detail (medians, counts, caveats); nested objects are left to the ledger. */
export function detailEntries(detail: Record<string, unknown> | undefined): Array<[string, string]> {
  return Object.entries(detail ?? {})
    .filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => [k.replace(/([A-Z])/g, " $1").toLowerCase(), v === null ? "none" : typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v)]);
}

/** A score, or the words for why it is withheld. */
export function ScoreValue({ score, reason, className }: { score: number | null | undefined; reason?: string | null; className?: string }) {
  if (score == null) {
    return (
      <span className={cn("text-sm text-muted-foreground", className)} title={reason ?? undefined}>
        withheld{reason ? ` — ${reason}` : ""}
      </span>
    );
  }
  return <span className={cn("text-3xl font-semibold tabular-nums", className)}>{fmtScore(score)}</span>;
}

/** Outcome score over stored versions, as a small inline line; gaps where a version had no score. */
export function Sparkline({ points, width = 120, height = 28 }: { points: Array<{ version: number; score: number | null }>; width?: number; height?: number }) {
  const scored = points.filter((p) => p.score != null);
  if (scored.length === 0) return <span className="text-xs text-muted-foreground">no scored versions yet</span>;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const y = (s: number) => height - 2 - (Math.max(0, Math.min(100, s)) / 100) * (height - 4);
  let d = "";
  points.forEach((p, i) => {
    if (p.score == null) return;
    const x = points.length > 1 ? i * step : width / 2;
    d += `${d.length === 0 || points[i - 1]?.score == null ? "M" : "L"}${x.toFixed(1)},${y(p.score).toFixed(1)} `;
  });
  const title = points.map((p) => `v${p.version}: ${p.score == null ? "withheld" : Math.round(p.score)}`).join(", ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Outcome score by version: ${title}`} className="text-accent-500">
      <title>{title}</title>
      <path d={d.trim()} fill="none" stroke="currentColor" strokeWidth={1.5} />
      {points.map((p, i) =>
        p.score == null ? null : <circle key={p.version} cx={points.length > 1 ? i * step : width / 2} cy={y(p.score)} r={2} fill="currentColor" />,
      )}
    </svg>
  );
}

/** The formula behind a metric key, and the implementation version that produced the number. */
export function FormulaNote({ metricKey, formulaVersion }: { metricKey: EvaluationMetricKey; formulaVersion: string }) {
  return (
    <p className="text-xs text-muted-foreground" data-testid={`formula-${metricKey}`}>
      <span className="font-medium text-text-primary">Formula.</span> {EVALUATION_METRIC_FORMULAS[metricKey]} <span className="whitespace-nowrap">Implementation {formulaVersion}.</span>
    </p>
  );
}

/** Event ids behind a number or an exception, each opening the event; the count is the truth when the list is capped. */
export function EvidenceRefs({ refs, count, onOpen, max = 6 }: { refs: string[]; count?: number; onOpen: (eventId: string) => void; max?: number }) {
  const total = count ?? refs.length;
  if (total === 0) return <span className="text-xs text-muted-foreground">no events cited</span>;
  const shown = refs.slice(0, max);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground">{total} {total === 1 ? "event" : "events"}:</span>
      {shown.map((id) => (
        <button key={id} type="button" onClick={() => onOpen(id)} className="rounded border border-border-soft px-1.5 py-0.5 font-mono text-[11px] hover:bg-surface-sunken" title={id} aria-label={`open event ${id.slice(0, 8)}`}>
          {id.slice(0, 8)}
        </button>
      ))}
      {total > shown.length ? <span className="text-xs text-muted-foreground">+{total - shown.length} more</span> : null}
    </span>
  );
}

/** One ledger event, opened from any number or exception that cites it. */
export function EventDrawer({ companyId, eventId, onClose }: { companyId: string; eventId: string | null; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.evaluation.event(companyId, eventId ?? ""),
    queryFn: () => evaluationApi.event(companyId, eventId!),
    enabled: !!eventId,
  });
  const e = data?.event;
  return (
    <Sheet open={!!eventId} onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent className="w-[520px] max-w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">{eventId}</SheetTitle>
          <SheetDescription>A fact from the evaluation ledger. Insert-only; this is the record the number rests on.</SheetDescription>
        </SheetHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading event…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load the event."}</p>
        ) : e ? (
          <dl className="mt-4 grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Type</dt>
            <dd className="font-mono">{e.eventType}</dd>
            <dt className="text-muted-foreground">Event time</dt>
            <dd>{fmtDate(e.eventTime)}</dd>
            <dt className="text-muted-foreground">Ingested</dt>
            <dd>{fmtDate(e.ingestTime)}</dd>
            <dt className="text-muted-foreground">Actor</dt>
            <dd className="font-mono">{e.actorType}{e.actorId ? ` ${e.actorId}` : ""}</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="font-mono break-all">{e.sourceTable} / {e.sourceId}</dd>
            <dt className="text-muted-foreground">Sequence</dt>
            <dd className="font-mono">{String(e.seq)}</dd>
            <dt className="text-muted-foreground">Payload</dt>
            <dd>
              <pre className="max-h-[50vh] overflow-auto rounded bg-surface-sunken p-2 text-[11px] leading-snug">{JSON.stringify(e.payload, null, 2)}</pre>
            </dd>
          </dl>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** Hook: which event the reader is looking at. */
export function useEventDrawer() {
  const [eventId, setEventId] = useState<string | null>(null);
  return { eventId, open: setEventId, close: () => setEventId(null) };
}

/** A metric row that expands into its notes, breakdown, evidence and formula. */
export function MetricRow({ metric, onOpenEvent }: { metric: MetricResult; onOpenEvent: (eventId: string) => void }) {
  const [open, setOpen] = useState(false);
  const und = metric.breakdown?.undecidable ?? [];
  return (
    <div className="border-b border-border-soft last:border-b-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="grid w-full grid-cols-[56px_1fr_120px_150px_80px] items-center gap-3 px-2 py-2 text-left text-sm hover:bg-surface-sunken" aria-expanded={open} data-testid={`metric-${metric.key}`}>
        <span className="font-mono text-xs text-muted-foreground">{metric.key}</span>
        <span>
          <span className="font-medium">{metric.name}</span>
          <span className="block text-xs text-muted-foreground">{metric.headline}</span>
        </span>
        <span className="tabular-nums">
          {fmtValue(metric)}
          {metric.lowerIsBetter && metric.value != null ? <span className="block text-[11px] text-muted-foreground">lower is better</span> : null}
          {metric.displayOnly ? <Badge variant="ghost" className="mt-0.5">not scored</Badge> : null}
        </span>
        <span><ConfidenceBadge tier={metric.confidence} label={metric.confidenceLabel} /></span>
        <span className="text-xs text-muted-foreground tabular-nums" title="share of the population that was decidable">{fmtPct(metric.coverage)}</span>
      </button>
      {open ? (
        <div className="space-y-2 px-2 pb-3 pl-[68px] text-sm">
          <FormulaNote metricKey={metric.key} formulaVersion={metric.formulaVersion} />
          <p className="text-xs text-muted-foreground">
            Population {metric.n}; satisfied {metric.breakdown?.satisfied ?? 0}, failed {metric.breakdown?.failed ?? 0}
            {und.length > 0 ? `, undecidable ${und.reduce((s, u) => s + u.count, 0)}` : ""}.
            {metric.tiers?.length ? ` Sources: ${metric.tiers.join(", ")}.` : ""}
          </p>
          {und.length > 0 ? (
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {und.map((u) => (
                <li key={u.reason}>{u.count} undecidable: {u.reason}</li>
              ))}
            </ul>
          ) : null}
          {metric.notes?.length ? (
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {metric.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          {detailEntries(metric.detail).length > 0 ? (
            <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground" data-testid={`detail-${metric.key}`}>
              {detailEntries(metric.detail).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt>{k}</dt>
                  <dd className="text-text-primary">{v}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <EvidenceRefs refs={metric.evidenceRefs ?? []} count={metric.evidenceRefCount} onOpen={onOpenEvent} />
        </div>
      ) : null}
    </div>
  );
}

export function MetricsTable({ metrics, onOpenEvent }: { metrics: MetricResult[]; onOpenEvent: (eventId: string) => void }) {
  if (metrics.length === 0) return <p className="text-sm text-muted-foreground">No metrics on this card.</p>;
  return (
    <div className="rounded-md border border-border-soft">
      <div className="grid grid-cols-[56px_1fr_120px_150px_80px] gap-3 border-b border-border-soft px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>Key</span><span>Metric</span><span>Value</span><span>Confidence</span><span>Coverage</span>
      </div>
      {metrics.map((m) => (
        <MetricRow key={m.key} metric={m} onOpenEvent={onOpenEvent} />
      ))}
    </div>
  );
}

export function MarkerList({ markers }: { markers: string[] }) {
  if (markers.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {markers.map((m) => (
        <li key={m}>
          <Badge variant="outline" className="whitespace-normal text-left">{m}</Badge>
        </li>
      ))}
    </ul>
  );
}
