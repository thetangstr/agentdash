// AgentDash: the "Business" run-transcript view, the run page's default.
// Two sources, one view for every company (no per-company branching):
//   - a harness-published milestone timeline for this run, when one exists
//     (doc/RUN-BUSINESS-VIEW.md), rendered as the six deal stages;
//   - otherwise a plain-language summary of AgentDash's own transcript
//     (lib/businessSummary.ts): steps, result, outcome and cost.
import { useId, useMemo, useState } from "react";
import type { TranscriptEntry } from "../../adapters";
import { MarkdownBody } from "../MarkdownBody";
import { cn, formatTokens } from "../../lib/utils";
import { buildBusinessSummary, type BusinessStep, type BusinessSummary } from "../../lib/businessSummary";
import { formatRunDuration } from "../../lib/readableTranscript";
import {
  TIMELINE_MILESTONES,
  timelineSimulatedLabels,
  type MilestoneTimeline,
  type TimelineAnchor,
  type TimelineEvent,
  type TimelineMilestone,
  type TimelineMilestoneLog,
} from "../../lib/milestoneTimeline";
import { useReadableTranscript, type ReadableRunUsage } from "./ReadableTranscript";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  Link2,
  Loader2,
  MessageSquare,
  Square,
  User,
  Wrench,
  X,
} from "lucide-react";

// Stage colours: the top edge of a stage card, the left edge of a section.
const MILESTONE_ACCENT_TOP: Record<TimelineMilestone, string> = {
  discover: "border-t-sky-500",
  proposal: "border-t-lime-600",
  negotiation: "border-t-amber-500",
  agreement: "border-t-teal-500",
  execution: "border-t-violet-500",
  settlement: "border-t-rose-500",
};

const MILESTONE_ACCENT_LEFT: Record<TimelineMilestone, string> = {
  discover: "border-l-sky-500",
  proposal: "border-l-lime-600",
  negotiation: "border-l-amber-500",
  agreement: "border-l-teal-500",
  execution: "border-l-violet-500",
  settlement: "border-l-rose-500",
};

const KIND_LABEL: Record<string, string> = {
  narration: "Note",
  "tool-call": "Action",
  "server-receipt": "Confirmed",
  "signer-decision": "Approval",
  "clockchain-anchor": "Clockchain",
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function formatClock(ts: string): string | null {
  const value = Date.parse(ts);
  if (!Number.isFinite(value)) return null;
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function stepCount(n: number): string {
  return n === 0 ? "nothing yet" : `${n} step${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Cost / outcome line (both sources)
// ---------------------------------------------------------------------------

function costParts(summary: BusinessSummary): string[] {
  const cost = summary.cost;
  if (!cost) return [];
  const parts: string[] = [];
  const duration = formatRunDuration(cost.durationMs);
  if (duration) parts.push(`took ${duration}`);
  if (cost.inputTokens > 0 || cost.outputTokens > 0) {
    parts.push(`${formatTokens(cost.inputTokens)} tokens in, ${formatTokens(cost.outputTokens)} out`);
  }
  if (cost.costUsd > 0) parts.push(`cost $${cost.costUsd.toFixed(4)}`);
  return parts;
}

function BusinessOutcomeLine({ summary }: { summary: BusinessSummary }) {
  const { outcome } = summary;
  const tone = outcome.state === "failed" ? "error" : "default";
  const parts = [outcome.label, ...costParts(summary)];
  return (
    <div
      data-business-outcome={outcome.state}
      className={cn(
        "rounded-xl border px-3 py-2 text-xs",
        tone === "error"
          ? "border-red-500/25 bg-red-500/[0.05] text-red-700 dark:text-red-300"
          : "border-border/60 bg-muted/30 text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-1.5">
        {outcome.state === "working" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : outcome.state === "stopped" ? (
          <Square className="h-3.5 w-3.5 shrink-0" />
        ) : outcome.state === "failed" ? (
          <X className="h-3.5 w-3.5 shrink-0" />
        ) : outcome.state === "done" ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : null}
        <span className={cn(tone === "default" && "text-foreground/80")}>{parts.join(" · ")}</span>
      </div>
      {outcome.note && <p className="mt-1 break-words">{outcome.note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fallback: plain summary of AgentDash's own transcript
// ---------------------------------------------------------------------------

const STEP_ICON = {
  said: MessageSquare,
  did: Wrench,
  changed: FileText,
  problem: CircleAlert,
  received: User,
} as const;

function BusinessStepRow({ step }: { step: BusinessStep }) {
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICON[step.kind];
  const problem = step.kind === "problem";
  const expandable = step.detail.length > 0;
  return (
    <li data-business-step={step.kind} className="flex items-start gap-2">
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          problem ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("break-words text-sm", problem ? "text-red-700 dark:text-red-300" : "text-foreground/90")}>
          {step.title}
          {step.failed > 0 && !problem && (
            <span className="text-xs text-red-700 dark:text-red-300"> · {step.failed} failed</span>
          )}
        </p>
        {expandable && (
          <>
            <button
              type="button"
              aria-expanded={open}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground max-sm:min-h-11"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {open ? "Hide details" : step.kind === "did" ? `Show the ${step.detail.length} actions` : "Show details"}
            </button>
            {open && (
              <ul className="mt-1 space-y-0.5 border-l border-border/50 pl-3 font-mono text-xs text-foreground/70">
                {step.detail.map((line, index) => (
                  <li key={index} className="break-words">{line}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function BusinessSummaryView({ summary, notice }: { summary: BusinessSummary; notice: string | null }) {
  return (
    <div className="space-y-3" data-transcript-mode="business" data-business-source="summary">
      {notice && (
        <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{notice}</p>
      )}
      {summary.steps.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">What the agent did</h3>
          <ol className="space-y-2">
            {summary.steps.map((step) => (
              <BusinessStepRow key={step.key} step={step} />
            ))}
          </ol>
        </div>
      )}
      {summary.finalMessage && (
        <div className="rounded-xl border border-border/60 bg-background/60 p-3" data-business-result>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Result</h3>
          <MarkdownBody className="text-sm text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            {summary.finalMessage}
          </MarkdownBody>
        </div>
      )}
      {(summary.cost || summary.outcome.state !== "unknown" || summary.steps.length === 0) && (
        <BusinessOutcomeLine summary={summary} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Milestone timeline
// ---------------------------------------------------------------------------

function clockchainText(log: TimelineMilestoneLog): string {
  const status = log.status === "not-yet-logged" ? "not logged yet" : log.status.replace(/[-_]+/g, " ");
  const parts = [`Clockchain: ${status}`];
  if (log.ledgerId) parts.push(`ledger ${log.ledgerId}`);
  if (log.blockHeight) parts.push(`block ${log.blockHeight}`);
  return parts.join(" · ");
}

function anchorText(anchor: TimelineAnchor): string {
  const ids = [anchor.ledgerId ? `ledger ${anchor.ledgerId}` : null, anchor.blockHeight ? `block ${anchor.blockHeight}` : null]
    .filter(Boolean)
    .join(", ");
  return ids ? `${anchor.summary} (${ids})` : anchor.summary;
}

function TimelineEventRow({
  event,
  onOpenLogLine,
}: {
  event: TimelineEvent;
  onOpenLogLine?: (seq: number) => void;
}) {
  const clock = formatClock(event.ts);
  const problem = event.outcome === "refused" || event.outcome === "error";
  return (
    <li
      data-business-event={event.id}
      data-basis={event.basis}
      className={cn(
        "rounded-lg border bg-background/60 px-3 py-2",
        event.inferred ? "border-dashed border-border" : "border-border/60",
        problem && "border-red-500/30",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        {clock && <time dateTime={event.ts} className="tabular-nums">{clock}</time>}
        {clock && <span aria-hidden="true">·</span>}
        <span>{kindLabel(event.kind)}</span>
        {event.inferred && (
          <span
            data-business-inferred
            title="The harness placed this in its stage from the nearest action, not from a server record."
            className="italic"
          >
            · stage inferred
          </span>
        )}
        {event.simulated && (
          <span
            data-business-simulated-label
            className="rounded bg-violet-500/10 px-1.5 py-px font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300"
          >
            {event.simulated}
          </span>
        )}
        {problem && (
          <span
            data-business-outcome-label={event.outcome}
            className="rounded bg-red-500/10 px-1.5 py-px font-semibold text-red-700 dark:text-red-300"
          >
            {event.outcome === "refused" ? "Refused" : "Error"}
          </span>
        )}
      </div>
      <p className={cn("mt-0.5 break-words text-sm", event.inferred ? "italic text-foreground/80" : "text-foreground")}>
        {event.summary}
      </p>
      {(event.detail || (event.sourceSeq !== null && onOpenLogLine)) && (
        <div className="mt-1 flex flex-wrap items-start gap-x-3">
          {event.detail && (
            <details className="group min-w-0 flex-1 text-xs text-muted-foreground">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium hover:text-foreground max-sm:min-h-11">
                <ChevronRight className="h-3.5 w-3.5 group-open:rotate-90" /> More
              </summary>
              <p className="mt-1 whitespace-pre-wrap break-words text-foreground/80">{event.detail}</p>
            </details>
          )}
          {event.sourceSeq !== null && onOpenLogLine && (
            <button
              type="button"
              data-business-log-link={event.sourceSeq}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline max-sm:min-h-11"
              onClick={() => onOpenLogLine(event.sourceSeq!)}
            >
              <Link2 className="h-3.5 w-3.5" /> Log line {event.sourceSeq}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function BusinessTimelineView({
  timeline,
  summary,
  hasTranscript,
  onOpenLogLine,
}: {
  timeline: MilestoneTimeline;
  summary: BusinessSummary;
  hasTranscript: boolean;
  onOpenLogLine?: (seq: number) => void;
}) {
  const baseId = useId();
  const simulatedLabels = useMemo(() => timelineSimulatedLabels(timeline), [timeline]);
  const byMilestone = useMemo(() => {
    const map = new Map<TimelineMilestone, { agency: TimelineEvent[]; other: TimelineEvent[]; anchors: TimelineAnchor[] }>();
    for (const milestone of TIMELINE_MILESTONES) map.set(milestone, { agency: [], other: [], anchors: [] });
    for (const event of timeline.events) {
      const bucket = map.get(event.milestone)!;
      if (event.lane === "agency") bucket.agency.push(event);
      else bucket.other.push(event);
    }
    for (const anchor of timeline.anchors) map.get(anchor.milestone)!.anchors.push(anchor);
    return map;
  }, [timeline]);
  const lastActive = [...TIMELINE_MILESTONES].reverse().find((m) => byMilestone.get(m)!.agency.length > 0) ?? null;
  const sectionId = (milestone: TimelineMilestone) => `${baseId}-${milestone}`;

  return (
    <div className="space-y-4" data-transcript-mode="business" data-business-source="timeline">
      {timeline.label && <p className="text-sm font-medium text-foreground">{timeline.label}</p>}

      {simulatedLabels.length > 0 && (
        <p
          data-business-simulated-banner
          className="rounded-lg border border-violet-500/30 bg-violet-500/[0.06] px-3 py-2 text-xs text-violet-800 dark:text-violet-200"
        >
          Parts of this run were not real:{" "}
          <span className="font-semibold uppercase tracking-wide">{simulatedLabels.join(" · ")}</span>. Those steps are marked
          below.
        </p>
      )}

      <ol className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" aria-label="Deal stages">
        {timeline.milestones.map((entry) => {
          const count = byMilestone.get(entry.milestone)!.agency.length;
          return (
            <li key={entry.milestone}>
              <button
                type="button"
                data-business-stage={entry.milestone}
                aria-current={entry.milestone === lastActive ? "step" : undefined}
                className={cn(
                  "w-full min-w-0 rounded-lg border border-t-4 border-border/60 bg-background/60 px-2 py-1.5 text-left max-sm:min-h-11",
                  MILESTONE_ACCENT_TOP[entry.milestone],
                  count === 0 && "opacity-60",
                  entry.milestone === lastActive && "ring-1 ring-foreground/20",
                )}
                onClick={() => document.getElementById(sectionId(entry.milestone))?.scrollIntoView({ block: "start", behavior: "smooth" })}
              >
                <span className="block truncate text-xs font-semibold text-foreground">{entry.label}</span>
                <span className="block text-xs text-muted-foreground">{stepCount(count)}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {timeline.milestones.map((entry) => {
        const bucket = byMilestone.get(entry.milestone)!;
        return (
          <section key={entry.milestone} id={sectionId(entry.milestone)} data-milestone={entry.milestone} className="space-y-2">
            <div className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-1 border-l-4 pl-2", MILESTONE_ACCENT_LEFT[entry.milestone])}>
              <h3 className="text-sm font-semibold text-foreground">{entry.label}</h3>
              <span className="text-xs text-muted-foreground">{stepCount(bucket.agency.length)}</span>
              {entry.log && (
                <span data-business-clockchain={entry.log.status} className="text-xs text-teal-700 dark:text-teal-300">
                  {clockchainText(entry.log)}
                </span>
              )}
            </div>
            {bucket.anchors.map((anchor, index) => (
              <p key={index} className="pl-3 text-xs text-teal-700 dark:text-teal-300">
                {anchorText(anchor)}
              </p>
            ))}
            {bucket.agency.length > 0 ? (
              <ul className="space-y-1.5">
                {bucket.agency.map((event) => (
                  <TimelineEventRow key={event.id} event={event} onOpenLogLine={onOpenLogLine} />
                ))}
              </ul>
            ) : (
              <p className="pl-3 text-xs text-muted-foreground">Nothing happened in this stage.</p>
            )}
            {bucket.other.length > 0 && (
              <details className="group pl-3 text-xs" data-business-other-side={bucket.other.length}>
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-muted-foreground hover:text-foreground max-sm:min-h-11">
                  <ChevronRight className="h-3.5 w-3.5 group-open:rotate-90" />
                  What the other side did ({bucket.other.length})
                </summary>
                <ul className="mt-1.5 space-y-1.5">
                  {bucket.other.map((event) => (
                    <TimelineEventRow key={event.id} event={event} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}

      {timeline.droppedEvents > 0 && (
        <p className="text-xs text-muted-foreground">
          {timeline.droppedEvents} entr{timeline.droppedEvents === 1 ? "y" : "ies"} could not be read and {timeline.droppedEvents === 1 ? "is" : "are"} not shown.
        </p>
      )}

      {timeline.honesty.length > 0 && (
        <details className="group text-xs text-muted-foreground">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium hover:text-foreground max-sm:min-h-11">
            <ChevronRight className="h-3.5 w-3.5 group-open:rotate-90" /> About this log
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {timeline.honesty.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      {hasTranscript && <BusinessOutcomeLine summary={summary} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function BusinessTranscriptView({
  entries,
  streaming = false,
  usage,
  stoppedReason,
  timeline,
  timelineNotice,
  onOpenLogLine,
  className,
}: {
  entries: readonly TranscriptEntry[];
  streaming?: boolean;
  usage?: ReadableRunUsage | null;
  stoppedReason?: string | null;
  /** The run's harness-published milestone timeline, when there is one. */
  timeline?: MilestoneTimeline | null;
  /** Shown above the plain summary, e.g. when a timeline exists in a newer format. */
  timelineNotice?: string | null;
  /** Open the Raw view at the run-log row with this `seq`. */
  onOpenLogLine?: (seq: number) => void;
  className?: string;
}) {
  const readable = useReadableTranscript(entries, streaming);
  const summary = useMemo(
    () => buildBusinessSummary(readable, { streaming, usage, stoppedReason }),
    [readable, streaming, usage, stoppedReason],
  );
  return (
    <div className={className}>
      {timeline ? (
        <BusinessTimelineView
          timeline={timeline}
          summary={summary}
          hasTranscript={entries.length > 0}
          onOpenLogLine={onOpenLogLine}
        />
      ) : (
        <BusinessSummaryView summary={summary} notice={timelineNotice ?? null} />
      )}
    </div>
  );
}
