import { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../../adapters";
import { cn, formatTokens } from "../../lib/utils";
import { formatToolPayload } from "../../lib/transcriptPresentation";
import { CREDENTIALS_HIDDEN_NOTE, redactSecrets, redactSecretsInValue } from "../../lib/redactSecrets";
import { ReadableTranscriptView, type ReadableRunUsage } from "./ReadableTranscript";
import { BusinessTranscriptView, type TimelineProvenance } from "./BusinessTranscript";
import type { MilestoneTimeline } from "../../lib/milestoneTimeline";

// AgentDash: "business" is the default (founder decision 2026-10-06): the
// harness's milestone timeline when one was posted for the run, otherwise a
// plain-language summary (BusinessTranscript.tsx). "readable" is the
// Claude-Code-style view (ReadableTranscript.tsx); "nice" is kept as an alias
// for older callers and renders the readable view; "raw" is the per-entry log.
export type TranscriptMode = "business" | "readable" | "raw" | "nice";

/** Raw-view row to bring into view and highlight; `token` re-triggers the same row. */
export interface RawTranscriptFocus {
  index: number;
  token: number;
}
export type TranscriptDensity = "comfortable" | "compact";

const RAW_VIRTUALIZATION_THRESHOLD = 300;
const RAW_OVERSCAN_ROWS = 40;
const RAW_ESTIMATED_ROW_HEIGHT = 36;
const RAW_INITIAL_ROWS = 180;

interface RunTranscriptViewProps {
  entries: TranscriptEntry[];
  mode?: TranscriptMode;
  density?: TranscriptDensity;
  limit?: number;
  streaming?: boolean;
  /** Retained for API compatibility; readable mode always tucks unparsed stdout into Details. */
  collapseStdout?: boolean;
  emptyMessage?: string;
  className?: string;
  thinkingClassName?: string;
  /** The run's metered usage, so the readable footer matches the run's own figures. */
  usage?: ReadableRunUsage | null;
  /** AgentDash (c3): cancelled-run stop reason; the readable footer renders "Stopped" neutrally instead of the killed process's "Failed". */
  stoppedReason?: string | null;
  /** AgentDash: the run's harness-published milestone timeline (Business mode). */
  timeline?: MilestoneTimeline | null;
  /** AgentDash: Business-mode note shown above the plain summary. */
  timelineNotice?: string | null;
  /** AgentDash: a Business-mode "Log line" link was clicked. */
  onOpenLogLine?: (seq: number) => void;
  /** AgentDash: Raw-mode row to scroll to and highlight. */
  rawFocus?: RawTranscriptFocus | null;
  /** AgentDash: who posted the timeline document and when (Business mode). */
  timelineProvenance?: TimelineProvenance | null;
  /** AgentDash: the run record's status and error (Business mode outcome). */
  runStatus?: string | null;
  runError?: string | null;
}

function findScrollParent(element: HTMLElement): HTMLElement | Window {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return window;
}

// AgentDash (scan 4 lane O1): every Raw entry (tool calls and results, stdout,
// stderr, assistant text) is redacted before display.
function rawEntryContent(entry: TranscriptEntry): string {
  return redactSecrets(rawEntryText(entry));
}

function rawEntryText(entry: TranscriptEntry): string {
  if (entry.kind === "tool_call") {
    return `${entry.name}\n${formatToolPayload(redactSecretsInValue(entry.input))}`;
  }
  if (entry.kind === "tool_result") {
    return formatToolPayload(redactSecretsInValue(entry.content));
  }
  if (entry.kind === "result") {
    return `${entry.text}\n${formatTokens(entry.inputTokens)} / ${formatTokens(entry.outputTokens)} / $${entry.costUsd.toFixed(6)}`;
  }
  if (entry.kind === "init") {
    return `model=${entry.model}${entry.sessionId ? ` session=${entry.sessionId}` : ""}`;
  }
  return entry.text;
}

function RawTranscriptView({
  entries,
  density,
  focus,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
  focus?: RawTranscriptFocus | null;
}) {
  const compact = density === "compact";
  const listRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = entries.length > RAW_VIRTUALIZATION_THRESHOLD;
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(entries.length, shouldVirtualize ? RAW_INITIAL_ROWS : entries.length),
  }));

  useEffect(() => {
    if (!shouldVirtualize) {
      setRange({ start: 0, end: entries.length });
      return;
    }

    const list = listRef.current;
    if (!list) return;

    const scrollParent = findScrollParent(list);
    const updateRange = () => {
      const scrollElement: HTMLElement | null = scrollParent === window ? null : (scrollParent as HTMLElement);
      const scrollerTop = scrollElement ? scrollElement.getBoundingClientRect().top : 0;
      const scrollerHeight = scrollElement ? scrollElement.clientHeight : window.innerHeight;
      const listTop = list.getBoundingClientRect().top;
      const visibleTop = Math.max(0, scrollerTop - listTop);
      const visibleBottom = Math.max(visibleTop + scrollerHeight, 0);
      const nextStart = Math.max(0, Math.floor(visibleTop / RAW_ESTIMATED_ROW_HEIGHT) - RAW_OVERSCAN_ROWS);
      const nextEnd = Math.min(
        entries.length,
        Math.ceil(visibleBottom / RAW_ESTIMATED_ROW_HEIGHT) + RAW_OVERSCAN_ROWS,
      );
      setRange((current) => (
        current.start === nextStart && current.end === nextEnd
          ? current
          : { start: nextStart, end: nextEnd }
      ));
    };

    updateRange();
    const frame = window.requestAnimationFrame(updateRange);
    scrollParent.addEventListener("scroll", updateRange, { passive: true });
    window.addEventListener("resize", updateRange);
    return () => {
      window.cancelAnimationFrame(frame);
      scrollParent.removeEventListener("scroll", updateRange);
      window.removeEventListener("resize", updateRange);
    };
  }, [entries.length, shouldVirtualize]);

  // AgentDash: bring a linked row (Business view "Log line n") into view. When
  // windowed, render around it first; the spacers keep its estimated offset.
  const focusIndex = focus && focus.index >= 0 && focus.index < entries.length ? focus.index : null;
  useEffect(() => {
    if (focusIndex === null) return;
    const list = listRef.current;
    if (shouldVirtualize && list) {
      setRange({
        start: Math.max(0, focusIndex - RAW_OVERSCAN_ROWS),
        end: Math.min(entries.length, focusIndex + RAW_OVERSCAN_ROWS),
      });
      // Scroll to the row's estimated offset too, so the windowing (which
      // follows the scroll position) keeps it rendered.
      const scrollParent = findScrollParent(list);
      const estimated = focusIndex * RAW_ESTIMATED_ROW_HEIGHT;
      if (scrollParent === window) {
        window.scrollTo({ top: list.getBoundingClientRect().top + window.scrollY + estimated - window.innerHeight / 2 });
      } else {
        const element = scrollParent as HTMLElement;
        const offset = list.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
        element.scrollTop = offset + estimated - element.clientHeight / 2;
      }
    }
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => {
        const row = listRef.current?.querySelector<HTMLElement>(`[data-raw-index="${focusIndex}"]`);
        row?.scrollIntoView?.({ block: "center" });
      });
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run per focus request only
  }, [focus?.token, focusIndex]);

  const visibleEntries = shouldVirtualize ? entries.slice(range.start, range.end) : entries;
  const topSpacer = shouldVirtualize ? range.start * RAW_ESTIMATED_ROW_HEIGHT : 0;
  const bottomSpacer = shouldVirtualize ? Math.max(0, entries.length - range.end) * RAW_ESTIMATED_ROW_HEIGHT : 0;

  return (
    <div ref={listRef} className={cn("font-mono", compact ? "space-y-1 text-[11px]" : "space-y-1.5 text-xs")}>
      {topSpacer > 0 && <div aria-hidden="true" style={{ height: topSpacer }} />}
      {visibleEntries.map((entry, idx) => (
        <div
          key={`${entry.kind}-${entry.ts}-${range.start + idx}`}
          data-raw-index={range.start + idx}
          data-raw-focused={focusIndex === range.start + idx ? "true" : undefined}
          className={cn(
            "grid gap-x-3",
            "grid-cols-[auto_1fr]",
            focusIndex === range.start + idx && "rounded-md bg-amber-500/10 ring-1 ring-amber-500/40",
          )}
        >
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {entry.kind}
          </span>
          <pre className="min-w-0 whitespace-pre-wrap break-words text-foreground/80">
            {rawEntryContent(entry)}
          </pre>
        </div>
      ))}
      {bottomSpacer > 0 && <div aria-hidden="true" style={{ height: bottomSpacer }} />}
    </div>
  );
}

export function RunTranscriptView({
  entries,
  mode = "business",
  density = "comfortable",
  limit,
  streaming = false,
  emptyMessage = "No transcript yet.",
  className,
  thinkingClassName,
  usage,
  stoppedReason,
  timeline,
  timelineNotice,
  onOpenLogLine,
  rawFocus,
  timelineProvenance,
  runStatus,
  runError,
}: RunTranscriptViewProps) {
  // A posted timeline renders even before the run's own log has loaded.
  // Business is a whole-run view; a `limit`ed preview (live widgets) shows
  // the latest Readable entries instead.
  if (mode === "business" && !limit && (entries.length > 0 || timeline)) {
    return (
      <BusinessTranscriptView
        entries={entries}
        streaming={streaming}
        usage={usage}
        stoppedReason={stoppedReason}
        timeline={timeline}
        timelineNotice={timelineNotice}
        onOpenLogLine={onOpenLogLine}
        timelineProvenance={timelineProvenance}
        runStatus={runStatus}
        runError={runError}
        className={className}
      />
    );
  }

  if (entries.length === 0) {
    return (
      <div className={cn("rounded-2xl border border-dashed border-border/70 bg-background/40 p-4 text-sm text-muted-foreground", className)}>
        {emptyMessage}
      </div>
    );
  }

  if (mode === "raw") {
    const visibleEntries = limit ? entries.slice(-limit) : entries;
    return (
      <div className={className} data-transcript-mode="raw">
        <p className="mb-2 text-xs text-muted-foreground" data-testid="raw-credentials-note">
          {CREDENTIALS_HIDDEN_NOTE}
        </p>
        <RawTranscriptView entries={visibleEntries} density={density} focus={limit ? null : rawFocus} />
      </div>
    );
  }

  return (
    <ReadableTranscriptView
      entries={entries}
      streaming={streaming}
      density={density}
      limit={limit}
      className={className}
      thinkingClassName={thinkingClassName}
      usage={usage}
      stoppedReason={stoppedReason}
    />
  );
}
