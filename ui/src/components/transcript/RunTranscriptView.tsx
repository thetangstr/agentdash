import { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../../adapters";
import { cn, formatTokens } from "../../lib/utils";
import { formatToolPayload } from "../../lib/transcriptPresentation";
import { ReadableTranscriptView } from "./ReadableTranscript";

// AgentDash: "readable" is the Claude-Code-style default (see
// ReadableTranscript.tsx). "nice" is kept as an alias for older callers and
// renders the readable view; "raw" is the unchanged per-entry log view.
export type TranscriptMode = "readable" | "raw" | "nice";
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

function rawEntryContent(entry: TranscriptEntry): string {
  if (entry.kind === "tool_call") {
    return `${entry.name}\n${formatToolPayload(entry.input)}`;
  }
  if (entry.kind === "tool_result") {
    return formatToolPayload(entry.content);
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
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
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

  const visibleEntries = shouldVirtualize ? entries.slice(range.start, range.end) : entries;
  const topSpacer = shouldVirtualize ? range.start * RAW_ESTIMATED_ROW_HEIGHT : 0;
  const bottomSpacer = shouldVirtualize ? Math.max(0, entries.length - range.end) * RAW_ESTIMATED_ROW_HEIGHT : 0;

  return (
    <div ref={listRef} className={cn("font-mono", compact ? "space-y-1 text-[11px]" : "space-y-1.5 text-xs")}>
      {topSpacer > 0 && <div aria-hidden="true" style={{ height: topSpacer }} />}
      {visibleEntries.map((entry, idx) => (
        <div
          key={`${entry.kind}-${entry.ts}-${range.start + idx}`}
          className={cn(
            "grid gap-x-3",
            "grid-cols-[auto_1fr]",
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
  mode = "readable",
  density = "comfortable",
  limit,
  streaming = false,
  emptyMessage = "No transcript yet.",
  className,
  thinkingClassName,
}: RunTranscriptViewProps) {
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
        <RawTranscriptView entries={visibleEntries} density={density} />
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
    />
  );
}
