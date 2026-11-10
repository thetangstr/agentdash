import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BATCH_MAX_RECORDS_UI,
  type BatchItemView,
  type BatchPreviewItem,
  type BatchPreviewResult,
  type BatchView,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "../../api/client";
import { batchesApi } from "../../api/batches";
import { cn } from "../../lib/utils";

/**
 * AgentDash admin powers: the one preview-and-apply dialog every batch uses.
 *
 * 1. Preview: each record with what changes, in plain words, plus what was
 *    left out and why. Nothing has changed yet.
 * 2. Apply: the server sends each record through its own single-record
 *    route, one at a time; the dialog polls until the batch ends.
 * 3. Results, per record: changed, changed differently (with what it is
 *    now), not changed (with the reason), failed, or unknown (it may or may
 *    not have changed, and is never retried).
 */

export interface BatchFieldText {
  /** "Status" */
  label: string;
  /** "In progress" */
  value: string;
}

export interface BatchPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  /** "Change tasks", "Approve decisions" */
  title: string;
  kind: string;
  /** The whole selection; a batch takes the first 200. */
  ids: string[];
  change: Record<string, unknown>;
  noun: { one: string; many: string };
  /** Plain words for a field and its value. Return null to hide a field. */
  formatField?: (field: string, value: unknown) => BatchFieldText | null;
  /** Called once the batch has finished (or was never needed), when the dialog closes. */
  onFinished?: () => void;
  pollIntervalMs?: number;
}

type Phase =
  | { name: "previewing" }
  | { name: "preview"; result: BatchPreviewResult }
  | { name: "confirming"; result: BatchPreviewResult }
  | { name: "running"; result: BatchPreviewResult; batchId: string }
  | { name: "error"; message: string; canRetry: boolean };

function plural(count: number, noun: { one: string; many: string }) {
  return `${count} ${count === 1 ? noun.one : noun.many}`;
}

function defaultFormat(field: string, value: unknown): BatchFieldText {
  const text = value === null || value === undefined
    ? "None"
    : Array.isArray(value)
      ? value.length === 0 ? "None" : value.map(String).join(", ")
      : String(value).replace(/_/g, " ");
  return { label: field, value: text };
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  return Object.keys(after).filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
}

function FieldChanges({
  before,
  after,
  format,
}: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  format: (field: string, value: unknown) => BatchFieldText | null;
}) {
  const fields = changedFields(before, after);
  return (
    <ul className="space-y-0.5 text-xs text-muted-foreground">
      {fields.map((field) => {
        const from = format(field, before[field]);
        const to = format(field, after[field]);
        if (!from || !to) return null;
        return (
          <li key={field}>
            <span className="font-medium text-foreground">{to.label}:</span> {from.value} → {to.value}
          </li>
        );
      })}
    </ul>
  );
}

const OUTCOME_TEXT: Record<string, { title: string; tone: string }> = {
  applied: { title: "Changed", tone: "text-green-700 dark:text-green-400" },
  applied_differently: { title: "Changed, but not as previewed", tone: "text-amber-700 dark:text-amber-400" },
  refused: { title: "Not changed", tone: "text-muted-foreground" },
  failed: { title: "Failed: nothing was changed", tone: "text-destructive" },
  unknown: { title: "Unknown: it may or may not have changed", tone: "text-amber-700 dark:text-amber-400" },
  pending: { title: "Waiting", tone: "text-muted-foreground" },
  applying: { title: "Changing now", tone: "text-muted-foreground" },
};

function outcomeKey(item: BatchItemView) {
  return item.outcome === "applied" && item.reasonCode === "applied_differently" ? "applied_differently" : item.outcome;
}

function ResultRow({ item, format }: { item: BatchItemView; format: (field: string, value: unknown) => BatchFieldText | null }) {
  const key = outcomeKey(item);
  const text = OUTCOME_TEXT[key] ?? OUTCOME_TEXT.pending!;
  return (
    <li className="space-y-1 px-3 py-2" data-testid="batch-result-row" data-outcome={key}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="min-w-0 text-sm font-medium">{item.label}</span>
        <span className={cn("text-xs font-medium", text.tone)}>{text.title}</span>
      </div>
      {key === "applied_differently" && item.actual ? (
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">It is now:</p>
          <FieldChanges before={item.after} after={item.actual} format={format} />
        </div>
      ) : null}
      {key === "unknown" ? (
        <p className="text-xs text-muted-foreground">
          It is never retried automatically. Open it and check before trying again.
        </p>
      ) : null}
      {item.reason && key !== "applied" ? <p className="text-xs text-muted-foreground">{item.reason}</p> : null}
    </li>
  );
}

export function BatchPreviewDialog({
  open,
  onOpenChange,
  companyId,
  title,
  kind,
  ids,
  change,
  noun,
  formatField,
  onFinished,
  pollIntervalMs = 1000,
}: BatchPreviewDialogProps) {
  const [phase, setPhase] = useState<Phase>({ name: "previewing" });
  const [attempt, setAttempt] = useState(0);
  const finishedRef = useRef(false);
  const included = useMemo(() => ids.slice(0, BATCH_MAX_RECORDS_UI), [ids]);
  const changeKey = JSON.stringify(change);
  const format = (field: string, value: unknown) => (formatField ? formatField(field, value) : defaultFormat(field, value));

  // Preview whenever the dialog opens (or "Preview again").
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    finishedRef.current = false;
    setPhase({ name: "previewing" });
    batchesApi
      .preview(companyId, { kind, ids: included, change: JSON.parse(changeKey) })
      .then((result) => {
        if (!cancelled) setPhase({ name: "preview", result });
      })
      .catch((err: unknown) => {
        if (!cancelled) setPhase({ name: "error", message: err instanceof Error ? err.message : "The preview could not be made.", canRetry: true });
      });
    return () => {
      cancelled = true;
    };
  }, [open, companyId, kind, included, changeKey, attempt]);

  const batchId = phase.name === "running" ? phase.batchId : null;
  const status = useQuery({
    queryKey: ["batches", companyId, batchId],
    queryFn: () => batchesApi.get(companyId, batchId!),
    enabled: !!batchId,
    refetchInterval: (query) => {
      const data = query.state.data as BatchView | undefined;
      return data && data.status !== "running" ? false : pollIntervalMs;
    },
  });
  const batch = status.data;
  const done = !!batch && batch.status !== "running";

  function close() {
    // A preview that was never applied is cancelled, so it does not count
    // against the person's open previews.
    if (phase.name === "preview" && phase.result.batchId) {
      void batchesApi.cancel(companyId, phase.result.batchId).catch(() => undefined);
    }
    if ((done || (phase.name === "preview" && !phase.result.batchId)) && !finishedRef.current) {
      finishedRef.current = true;
      onFinished?.();
    }
    onOpenChange(false);
  }

  async function apply() {
    if (phase.name !== "preview" || !phase.result.batchId || !phase.result.confirmHandle || !phase.result.previewDigest) return;
    const result = phase.result;
    setPhase({ name: "confirming", result });
    try {
      await batchesApi.confirm(companyId, result.batchId!, { handle: result.confirmHandle!, previewDigest: result.previewDigest! });
      setPhase({ name: "running", result, batchId: result.batchId! });
    } catch (err) {
      const expired = err instanceof ApiError && err.status === 409;
      setPhase({
        name: "error",
        message: expired
          ? "This preview expired or was already used, so nothing was changed. Preview again to see the records as they are now."
          : err instanceof ApiError && err.status === 429
            ? err.message
            : err instanceof Error ? err.message : "The change could not be started.",
        canRetry: true,
      });
    }
  }

  const preview = phase.name === "preview" || phase.name === "confirming" || phase.name === "running" ? phase.result : null;
  const counts = batch?.counts;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-testid="batch-preview-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {done
              ? "Done. Here is what happened to each one."
              : phase.name === "running"
                ? "Changing them now, one at a time."
                : "Nothing has changed yet. Check the list, then apply."}
          </DialogDescription>
        </DialogHeader>

        {ids.length > BATCH_MAX_RECORDS_UI ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" data-testid="batch-cap-notice">
            You selected {plural(ids.length, noun)}. One batch holds {BATCH_MAX_RECORDS_UI}, so the first {BATCH_MAX_RECORDS_UI} are included.
          </p>
        ) : null}

        {phase.name === "previewing" ? <p className="text-sm text-muted-foreground">Checking what would change...</p> : null}

        {phase.name === "error" ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-destructive" data-testid="batch-error">{phase.message}</p>
            {phase.canRetry ? (
              <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>Preview again</Button>
            ) : null}
          </div>
        ) : null}

        {preview && !batch ? (
          <div className="space-y-3">
            <p className="text-sm" data-testid="batch-preview-summary">
              {preview.items.length === 0
                ? `Nothing to change in the ${plural(included.length, noun)} you picked.`
                : `${plural(preview.items.length, noun)} will change.`}
            </p>
            {preview.omitted.noop > 0 ? (
              <p className="text-xs text-muted-foreground">{plural(preview.omitted.noop, noun)} already look like this, so they are left out.</p>
            ) : null}
            {preview.omitted.notFound > 0 ? (
              <p className="text-xs text-muted-foreground">{plural(preview.omitted.notFound, noun)} could not be found or you cannot see them, so they are left out.</p>
            ) : null}
            {preview.notDecidable.length > 0 ? (
              <div className="space-y-1" data-testid="batch-not-decidable">
                <p className="text-xs font-medium">Left out:</p>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {preview.notDecidable.map((row) => <li key={row.entityId}>{row.reason}</li>)}
                </ul>
              </div>
            ) : null}
            {preview.items.length > 0 ? (
              <ul className="divide-y divide-border rounded-md border border-border" data-testid="batch-preview-items">
                {preview.items.map((item: BatchPreviewItem) => (
                  <li key={item.itemId} className="space-y-1 px-3 py-2">
                    <p className="text-sm font-medium">{item.label}</p>
                    <FieldChanges before={item.before} after={item.after} format={format} />
                    {item.notes?.map((note) => (
                      <p key={note} className="text-xs text-amber-700 dark:text-amber-400">{note}</p>
                    ))}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {batch ? (
          <div className="space-y-2">
            {counts ? (
              <p className="text-sm" data-testid="batch-result-summary">
                {counts.applied} changed{counts.appliedDifferently ? ` (${counts.appliedDifferently} not as previewed)` : ""}, {counts.refused} not changed, {counts.failed} failed, {counts.unknown} unknown
                {batch.status === "interrupted" ? ". The batch was interrupted." : ""}
              </p>
            ) : null}
            <ul className="divide-y divide-border rounded-md border border-border" data-testid="batch-results">
              {(batch.items ?? []).map((item) => <ResultRow key={item.itemId} item={item} format={format} />)}
            </ul>
          </div>
        ) : null}

        <DialogFooter>
          {done || phase.name === "error" || (preview && preview.items.length === 0) ? (
            <Button size="sm" onClick={close}>Close</Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={close} disabled={phase.name === "confirming" || phase.name === "running"}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void apply()}
                disabled={phase.name !== "preview" || !preview?.batchId}
                data-testid="batch-apply"
              >
                {phase.name === "confirming" || phase.name === "running" ? "Applying..." : `Apply to ${plural(preview?.items.length ?? 0, noun)}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
