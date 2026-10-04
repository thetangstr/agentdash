// AgentDash: shared "Readable" transcript components. RunTranscriptView renders
// whole runs with them; the issue chat (and the LiveRunWidget /
// ActiveAgentsPanel surfaces built on it) reuses the tool row, details and
// mode toggle so a run looks the same everywhere.
import { useMemo, useRef, useState } from "react";
import type { TranscriptEntry } from "../../adapters";
import { MarkdownBody } from "../MarkdownBody";
import { cn, formatTokens } from "../../lib/utils";
import { formatToolPayload } from "../../lib/transcriptPresentation";
import { shortenInstancePaths } from "../../lib/instancePaths";
import { redactSecretsInValue } from "../../lib/redactSecrets";
import {
  formatRunDuration,
  redactSecrets,
  summarizeToolOutcome,
  toolGroupLabel,
  updateReadableTranscript,
  type ReadableBlock,
  type ReadableDetailLine,
  type ReadableResultFooter,
  type ReadableToolItem,
  type ReadableTranscript,
  type ReadableTranscriptCache,
} from "../../lib/readableTranscript";
import type { TranscriptViewMode } from "../../lib/transcriptModePreference";
import { Check, ChevronDown, ChevronRight, CircleAlert, CircleDashed, GitCompare, Loader2, Square, User, X } from "lucide-react";

/**
 * Readable model for a run, built incrementally: while a run streams, only the
 * entries added since the last render are processed (see
 * updateReadableTranscript).
 */
export function useReadableTranscript(entries: readonly TranscriptEntry[], streaming: boolean): ReadableTranscript {
  const cacheRef = useRef<ReadableTranscriptCache | null>(null);
  return useMemo(() => {
    const next = updateReadableTranscript(cacheRef.current, entries, streaming);
    cacheRef.current = next.cache;
    return next.transcript;
  }, [entries, streaming]);
}

export type ReadableDensity = "comfortable" | "compact";

const OUTPUT_PREVIEW_LINES = 12;
const OUTPUT_PREVIEW_CHARS = 1500;

function hasSelectedText() {
  if (typeof window === "undefined") return false;
  return (window.getSelection()?.toString().length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------------

export function TranscriptModeToggle({
  mode,
  onChange,
  className,
}: {
  mode: TranscriptViewMode;
  onChange: (mode: TranscriptViewMode) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Transcript view"
      className={cn("inline-flex rounded-lg border border-border/70 bg-background/70 p-0.5", className)}
    >
      {(["readable", "raw"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={mode === option}
          data-transcript-mode={option}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] max-sm:text-xs font-medium capitalize transition-colors max-sm:min-h-11 max-sm:px-3",
            mode === option ? "bg-accent text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onChange(option);
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Output with "show more"
// ---------------------------------------------------------------------------

export function CappedOutput({ text, tone = "default" }: { text: string; tone?: "default" | "error" }) {
  const [showAll, setShowAll] = useState(false);
  const lines = text.split(/\r?\n/);
  const overLines = lines.length > OUTPUT_PREVIEW_LINES;
  const overChars = text.length > OUTPUT_PREVIEW_CHARS;
  const capped = (overLines || overChars) && !showAll;
  const visible = capped
    ? lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n").slice(0, OUTPUT_PREVIEW_CHARS)
    : text;
  return (
    <div>
      <pre
        className={cn(
          "max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[11px] max-sm:text-xs leading-[1.15rem]",
          tone === "error" ? "text-red-700 dark:text-red-300" : "text-foreground/80",
        )}
      >
        {visible}
      </pre>
      {(overLines || overChars) && (
        <button
          type="button"
          className="mt-1 text-[11px] max-sm:text-xs font-medium text-muted-foreground hover:text-foreground max-sm:min-h-11"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Show less" : `Show more (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One tool call = one line
// ---------------------------------------------------------------------------

export interface ReadableToolRowItem {
  name: string;
  input: unknown;
  summary: ReadableToolItem["summary"];
  result?: string;
  status: ReadableToolItem["status"];
}

function ToolStatusIcon({ status }: { status: ReadableToolItem["status"] }) {
  if (status === "running") {
    return <Loader2 aria-label="Running" className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-600 dark:text-cyan-300" />;
  }
  if (status === "error") {
    return <X aria-label="Failed" className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />;
  }
  if (status === "no_result") {
    // Neutral: the call never reported back, so it is neither a success nor a failure.
    return <CircleDashed aria-label="No result" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />;
  }
  return <Check aria-label="Succeeded" className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
}

function hasUsefulInput(item: ReadableToolRowItem): boolean {
  // AgentDash (scan 3 lane L): a multi-statement script is labelled by one
  // line, so the script itself is shown when the row is opened.
  if (item.summary.isCommand) return Boolean(item.summary.script);
  if (item.input === null || item.input === undefined) return false;
  if (typeof item.input === "object" && Object.keys(item.input as object).length === 0) return false;
  return true;
}

export function ReadableToolRow({
  item,
  density = "comfortable",
  open: controlledOpen,
  onOpenChange,
}: {
  item: ReadableToolRowItem;
  density?: ReadableDensity;
  /** Controlled expanded state (used by ReadableToolGroup so it survives regrouping). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setLocalOpen(next);
  };
  const compact = density === "compact";
  const outcome = summarizeToolOutcome(item.result, item.status, item.input);

  return (
    <div data-readable-tool={item.status} className="min-w-0">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={item.summary.label}
        className="group flex min-w-0 cursor-pointer items-center gap-2 rounded-md py-0.5 hover:bg-accent/30 max-sm:min-h-11"
        onClick={() => {
          if (hasSelectedText()) return;
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <ToolStatusIcon status={item.status} />
        <span className={cn("flex min-w-0 flex-1 items-baseline gap-1.5", compact ? "text-xs" : "text-[13px]")}>
          <span className="shrink-0 font-medium text-foreground/90">{item.summary.verb}</span>
          {item.summary.target ? (
            <code className="min-w-0 truncate rounded bg-muted/50 px-1 font-mono text-[0.92em] max-sm:text-[12px] text-foreground/80">
              {item.summary.target}
            </code>
          ) : null}
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              item.status === "error"
                ? "text-red-700 dark:text-red-300"
                : item.status === "no_result"
                  ? "italic text-muted-foreground/60"
                  : "text-muted-foreground/80",
            )}
          >
            {outcome}
          </span>
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground" />
        )}
      </div>
      {open && (
        <div className="ml-5 mt-1 space-y-2 pb-1">
          {hasUsefulInput(item) && (
            <div>
              <div className="mb-0.5 text-[10px] max-sm:text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">Input</div>
              <CappedOutput text={redactSecrets(item.summary.script ?? formatToolPayload(redactSecretsInValue(item.input)))} />
            </div>
          )}
          {item.result ? (
            <div>
              {hasUsefulInput(item) && (
                <div className="mb-0.5 text-[10px] max-sm:text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">Output</div>
              )}
              <CappedOutput text={redactSecrets(formatToolPayload(redactSecretsInValue(item.result)))} tone={item.status === "error" ? "error" : "default"} />
            </div>
          ) : (
            <div className="text-[11px] max-sm:text-xs italic text-muted-foreground">
              {item.status === "running" ? "Waiting for output…" : item.status === "no_result" ? "No result was reported." : "No output."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Consecutive tool calls fold into "Ran N tools"
// ---------------------------------------------------------------------------

export interface ReadableToolGroupItem extends ReadableToolRowItem {
  key: string;
}

/**
 * Renders one or more consecutive calls. A single call uses the same container
 * and row key as a group, and row expansion lives here, so a row the viewer
 * opened stays open (and visible) when a second call joins the group.
 */
export function ReadableToolGroup({
  items,
  density = "comfortable",
}: {
  items: readonly ReadableToolGroupItem[];
  density?: ReadableDensity;
}) {
  const [open, setOpen] = useState(false);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const grouped = items.length > 1;

  const failed = items.filter((item) => item.status === "error").length;
  const running = items.some((item) => item.status === "running");
  const allSucceeded = items.every((item) => item.status === "completed");
  // Folded groups keep failed calls, the live call and any row the viewer opened visible.
  const visible = !grouped || open
    ? items
    : items.filter(
        (item, index) =>
          item.status === "error"
          || (item.status === "running" && index === items.length - 1)
          || openRows.has(item.key),
      );

  const setRowOpen = (key: string, next: boolean) => {
    setOpenRows((current) => {
      const copy = new Set(current);
      if (next) copy.add(key);
      else copy.delete(key);
      return copy;
    });
  };

  return (
    <div data-readable-tool-group={items.length}>
      {grouped && (
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          className="flex cursor-pointer items-center gap-2 rounded-md py-0.5 hover:bg-accent/30 max-sm:min-h-11"
          onClick={() => {
            if (hasSelectedText()) return;
            setOpen((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setOpen((value) => !value);
            }
          }}
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-600 dark:text-cyan-300" />
          ) : failed > 0 ? (
            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
          ) : allSucceeded ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <CircleDashed className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          )}
          <span className={cn("font-medium text-foreground/80", density === "compact" ? "text-xs" : "text-[13px]")}>
            {toolGroupLabel(items)}
          </span>
          {failed > 0 && (
            <span className="text-[11px] max-sm:text-xs text-red-700 dark:text-red-300">· {failed} failed</span>
          )}
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          )}
        </div>
      )}
      <div className={cn(grouped && visible.length > 0 && "ml-1.5 mt-0.5 space-y-0.5 border-l border-border/50 pl-3")}>
        {visible.map((item) => (
          <ReadableToolRow
            key={item.key}
            item={item}
            density={density}
            open={openRows.has(item.key)}
            onOpenChange={(next) => setRowOpen(item.key, next)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details: thinking / init / system / stderr / stdout, hidden by default
// ---------------------------------------------------------------------------

export function ReadableDetails({
  lines,
  density = "comfortable",
  thinkingClassName,
}: {
  lines: readonly ReadableDetailLine[];
  density?: ReadableDensity;
  thinkingClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  return (
    <div data-readable-details={lines.length}>
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] max-sm:text-xs font-medium text-muted-foreground hover:text-foreground max-sm:min-h-11"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Details ({lines.length})
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 border-l border-border/50 pl-3">
          {lines.map((line, index) => (
            <div key={`${line.kind}-${line.ts}-${index}`}>
              <div className="text-[10px] max-sm:text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                {line.kind}
              </div>
              {line.kind === "thinking" ? (
                <MarkdownBody
                  className={cn(
                    "italic text-foreground/70 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
                    density === "compact" ? "text-[11px] max-sm:text-xs leading-5" : "text-xs leading-5",
                    thinkingClassName,
                  )}
                >
                  {redactSecrets(line.text)}
                </MarkdownBody>
              ) : (
                <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] max-sm:text-xs text-foreground/70">
                  {redactSecrets(line.text)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result footer
// ---------------------------------------------------------------------------

/**
 * AgentDash (scan 4 lane O1): the run's metered usage, from the run record.
 * The transcript's own result line can disagree with it (the adapter reports
 * its own count, the run record is what was metered), and the run page showed
 * "Input 32.0k" above a footer reading "31.4k in". When the caller passes the
 * run's usage, the footer shows that, so both read from one source.
 */
export interface ReadableRunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** Run-record wall-clock duration; wins over the transcript's snapshot. */
  durationMs?: number | null;
}

// AgentDash (c3 review): a stopped run whose transcript has no result line
// still gets the neutral "Stopped" footer — the run record's reason is the
// whole story.
const STOPPED_FALLBACK_FOOTER: ReadableResultFooter = {
  ts: "",
  isError: false,
  outcome: "Stopped",
  text: null,
  errors: [],
  durationMs: null,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
};

export function ReadableFooter({
  footer,
  density = "comfortable",
  usage,
  stoppedReason,
}: {
  footer: ReadableResultFooter;
  density?: ReadableDensity;
  usage?: ReadableRunUsage | null;
  /** AgentDash (c3): set for a cancelled run — the transcript's own result
   * line reads "Failed · Interrupted" because the process was killed; the
   * footer renders the stop reason in neutral styling instead. */
  stoppedReason?: string | null;
}) {
  const stopped = stoppedReason != null;
  const isError = footer.isError && !stopped;
  const duration = formatRunDuration(usage?.durationMs ?? footer.durationMs);
  const inputTokens = usage ? usage.inputTokens : footer.inputTokens;
  const outputTokens = usage ? usage.outputTokens : footer.outputTokens;
  const costUsd = usage ? usage.costUsd ?? 0 : footer.costUsd;
  const hasTokens = inputTokens > 0 || outputTokens > 0;
  const parts = [
    stopped ? "Stopped" : footer.outcome,
    duration,
    hasTokens ? `${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out` : null,
    costUsd > 0 ? `$${costUsd.toFixed(4)}` : null,
  ].filter((part): part is string => Boolean(part));
  const footerText = stopped ? stoppedReason : footer.text;
  const footerErrors = stopped ? [] : footer.errors;

  return (
    <div
      data-readable-footer={isError ? "error" : "ok"}
      className={cn(
        "border-t border-border/50 pt-2",
        isError && "rounded-lg border border-red-500/20 bg-red-500/[0.05] p-2.5",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 text-[11px] max-sm:text-xs",
          isError ? "text-red-700 dark:text-red-300" : "text-muted-foreground",
        )}
      >
        {stopped ? (
          <Square className="h-3.5 w-3.5 shrink-0" />
        ) : isError ? (
          <X className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        )}
        <span>{parts.join(" · ")}</span>
      </div>
      {isError && footerErrors.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-red-700 dark:text-red-300">
          {footerErrors.map((error, index) => (
            <li key={index} className="break-words">{redactSecrets(error)}</li>
          ))}
        </ul>
      )}
      {footerText && !(isError && footerErrors.includes(footerText)) && (
        <MarkdownBody
          className={cn(
            "mt-1.5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            isError ? "text-red-700 dark:text-red-300" : "text-foreground/80",
            density === "compact" ? "text-[11px] max-sm:text-xs leading-5" : "text-xs leading-5",
          )}
        >
          {/* AgentDash (review #1016): redact first — a secret that is a path
              basename must never survive as the shortened file name. */}
          {shortenInstancePaths(redactSecrets(footerText))}
        </MarkdownBody>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function ReadableMessage({
  block,
  density,
}: {
  block: Extract<ReadableBlock, { type: "message" }>;
  density: ReadableDensity;
}) {
  const compact = density === "compact";
  return (
    <div>
      {block.role === "user" && (
        <div className="mb-1 flex items-center gap-1.5 text-[11px] max-sm:text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <User className="h-3.5 w-3.5" />
          <span>User</span>
        </div>
      )}
      <MarkdownBody
        className={cn(
          "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          compact ? "text-xs leading-5 text-foreground/90" : "text-sm text-foreground",
        )}
      >
        {redactSecrets(shortenInstancePaths(block.text))}
      </MarkdownBody>
      {block.streaming && (
        <div className="mt-1.5 inline-flex items-center gap-1 text-[10px] max-sm:text-xs font-medium italic text-muted-foreground">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
          </span>
          Streaming
        </div>
      )}
    </div>
  );
}

function ReadableErrorLines({ lines }: { lines: string[] }) {
  return (
    <div
      data-readable-error
      className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.05] px-2.5 py-1.5 text-red-700 dark:text-red-300"
    >
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] max-sm:text-xs">{redactSecrets(lines.join("\n"))}</pre>
    </div>
  );
}

function ReadableDiff({ block }: { block: Extract<ReadableBlock, { type: "diff" }> }) {
  const [open, setOpen] = useState(false);
  const adds = block.hunks.filter((hunk) => hunk.changeType === "add").length;
  const removes = block.hunks.filter((hunk) => hunk.changeType === "remove").length;
  const file = block.filePath ?? "diff";
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-2 py-0.5 text-[13px] hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <GitCompare className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-300" />
        <span className="font-medium text-foreground/90">Changed</span>
        <code className="truncate rounded bg-muted/50 px-1 font-mono text-[0.92em] max-sm:text-[12px] text-foreground/80">{file}</code>
        {(adds > 0 || removes > 0) && (
          <span className="text-[11px] max-sm:text-xs tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{adds}</span>{" "}
            <span className="text-red-600 dark:text-red-400">-{removes}</span>
          </span>
        )}
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <pre className="ml-5 mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[11px] max-sm:text-xs">
          {block.hunks.map((hunk, index) => (
            <span
              key={`${index}-${hunk.changeType}`}
              className={cn(
                "block",
                hunk.changeType === "add" && "bg-emerald-500/[0.10] text-emerald-700 dark:text-emerald-300",
                hunk.changeType === "remove" && "bg-red-500/[0.10] text-red-700 dark:text-red-300",
                hunk.changeType === "file_header" && "font-semibold text-blue-600 dark:text-blue-300",
                (hunk.changeType === "context" || hunk.changeType === "hunk") && "text-muted-foreground",
                hunk.changeType === "truncation" && "italic text-muted-foreground",
              )}
            >
              {hunk.changeType === "add" ? "+ " : hunk.changeType === "remove" ? "- " : "  "}
              {hunk.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

export function ReadableTranscriptView({
  entries,
  streaming = false,
  density = "comfortable",
  limit,
  className,
  thinkingClassName,
  usage,
  stoppedReason,
}: {
  entries: readonly TranscriptEntry[];
  streaming?: boolean;
  density?: ReadableDensity;
  limit?: number;
  className?: string;
  thinkingClassName?: string;
  /** The run's metered usage; when set, the footer shows it instead of the transcript's result line. */
  usage?: ReadableRunUsage | null;
  /** Cancelled-run stop reason; renders the footer as a neutral "Stopped". */
  stoppedReason?: string | null;
}) {
  const transcript = useReadableTranscript(entries, streaming);
  const blocks = limit ? transcript.blocks.slice(-limit) : transcript.blocks;

  return (
    <div className={cn(density === "compact" ? "space-y-2" : "space-y-3", className)} data-transcript-mode="readable">
      {blocks.map((block, index) => (
        <div
          key={block.key}
          className={cn(index === blocks.length - 1 && streaming && "animate-in fade-in slide-in-from-bottom-1 duration-300")}
        >
          {block.type === "message" && <ReadableMessage block={block} density={density} />}
          {block.type === "tools" && <ReadableToolGroup items={block.items} density={density} />}
          {block.type === "diff" && <ReadableDiff block={block} />}
          {/* AgentDash (c3 review): a stopped run shows no red error lines —
              the kill produced that noise; the reason is in the footer. */}
          {block.type === "error" && stoppedReason == null && <ReadableErrorLines lines={block.lines} />}
        </div>
      ))}
      <ReadableDetails lines={transcript.details} density={density} thinkingClassName={thinkingClassName} />
      {(transcript.footer || stoppedReason != null) && (
        <ReadableFooter footer={transcript.footer ?? STOPPED_FALLBACK_FOOTER} density={density} usage={usage} stoppedReason={stoppedReason} />
      )}
    </div>
  );
}

/**
 * Run-level Details disclosure plus result footer, built from the run's
 * transcript entries. The issue chat renders this once per run message so its
 * thinking/system/stderr live in the same Details as on the run page.
 */
export function ReadableRunSummary({
  entries,
  streaming = false,
  density = "compact",
  usage,
  stoppedReason,
}: {
  entries: readonly TranscriptEntry[];
  streaming?: boolean;
  density?: ReadableDensity;
  /** The run record's final usage; wins over the transcript's result line. */
  usage?: ReadableRunUsage | null;
  /** Cancelled-run stop reason; renders the footer as a neutral "Stopped". */
  stoppedReason?: string | null;
}) {
  const transcript = useReadableTranscript(entries, streaming);
  // The chat shows assistant text and tool calls from its own message parts;
  // error-looking stderr only exists in the entries, so surface it here —
  // unless the run was stopped, in which case the killed process's error
  // noise is exactly what the neutral footer replaces.
  const stopped = stoppedReason != null;
  const errorLines = stopped
    ? []
    : transcript.blocks.flatMap((block) => (block.type === "error" ? block.lines : []));
  if (transcript.details.length === 0 && !transcript.footer && errorLines.length === 0 && !stopped) return null;
  return (
    <div className="space-y-2" data-readable-run-summary>
      {errorLines.length > 0 && <ReadableErrorLines lines={errorLines} />}
      <ReadableDetails lines={transcript.details} density={density} />
      {(transcript.footer || stopped) && (
        <ReadableFooter footer={transcript.footer ?? STOPPED_FALLBACK_FOOTER} density={density} usage={usage} stoppedReason={stoppedReason} />
      )}
    </div>
  );
}
