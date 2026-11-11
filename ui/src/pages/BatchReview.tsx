import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { plainAssistantClientName, type BatchItemView, type BatchView } from "@paperclipai/shared";
import { useParams } from "@/lib/router";
import { batchesApi } from "@/api/batches";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { defaultFormat, FieldChanges, ResultRow } from "@/components/batch/BatchPreviewDialog";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";

/**
 * AgentDash admin powers (part 5): the review page of a batch the person's
 * own Claude prepared. Every record's before and after, the time left, and
 * two ways to go ahead, both spending the same single-use batch:
 *
 * - "Show code for Claude" mints the code (shown here, big, once) that the
 *   person reads back to their assistant. The code lives only in this
 *   component's memory: never in the URL, browser storage, the query cache
 *   or the console, and it is gone when the page is left.
 * - "Apply here" applies it with the person's own session.
 */

/**
 * Review of c5941141b: the page is never framed by the server (DENY), but an
 * in-app navigation inside a same-origin frame makes no new request. Inside
 * any frame the page shows the changes and nothing to act with.
 */
function insideAFrame(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 60_000));
}

function statusLine(batch: BatchView, now: number): string {
  if (batch.status === "previewed") {
    return new Date(batch.expiresAt).getTime() <= now
      ? "This preview has expired. Ask your assistant to prepare it again."
      : `Nothing has changed yet. This preview expires in ${minutesLeft(batch.expiresAt, now)} minute${minutesLeft(batch.expiresAt, now) === 1 ? "" : "s"}.`;
  }
  if (batch.status === "running") return "Applying now. Records change one at a time.";
  if (batch.status === "completed") {
    const { applied, refused, failed, unknown } = batch.counts;
    return `Done: ${applied} changed, ${refused} not changed, ${failed} failed, ${unknown} unknown.`;
  }
  if (batch.status === "cancelled") return "This batch was cancelled. Nothing more will change.";
  if (batch.status === "expired") return "This preview has expired. Ask your assistant to prepare it again.";
  return "This batch stopped before it finished. Check the records below.";
}

export function BatchReview() {
  const { batchId = "" } = useParams<{ batchId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setBreadcrumbs([{ label: "Batch change" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const batch = useQuery({
    queryKey: ["batches", selectedCompanyId, batchId],
    queryFn: () => batchesApi.get(selectedCompanyId!, batchId),
    enabled: !!selectedCompanyId && !!batchId,
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === "running" || query.state.data?.status === "previewed" ? 2_000 : false),
  });

  const showCode = useMutation({
    mutationFn: () => batchesApi.confirmCode(selectedCompanyId!, batchId),
    // Kept in component state only: the mutation's own result is discarded.
    onSuccess: (result) => setCode(result.code),
    gcTime: 0,
  });

  const applyHere = useMutation({
    mutationFn: () => batchesApi.applyHere(selectedCompanyId!, batchId),
    onSuccess: () => {
      setCode(null);
      void queryClient.invalidateQueries({ queryKey: ["batches", selectedCompanyId, batchId] });
    },
  });

  // Once the batch is no longer waiting, the code means nothing: drop it.
  useEffect(() => {
    if (batch.data && batch.data.status !== "previewed") setCode(null);
  }, [batch.data]);

  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  if (batch.isLoading) return <p className="text-sm text-muted-foreground" data-testid="batch-review-loading">Loading the batch…</p>;
  if (batch.error || !batch.data) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="batch-review-missing">
        {batch.error instanceof ApiError && batch.error.status === 404
          ? "This batch does not exist, or it is not yours to review."
          : "The batch could not be loaded."}
      </p>
    );
  }

  const data = batch.data;
  const items: BatchItemView[] = data.items ?? [];
  const waiting = data.status === "previewed" && new Date(data.expiresAt).getTime() > now;
  const fromAssistant = data.origin === "assistant";
  // The name is the OAuth client's own choice: shown cleaned, as a label, with
  // the domain it signs in through beside it (review of 8f1b669b0).
  const clientName = plainAssistantClientName(data.assistantClientName);
  const clientHost = data.assistantClientHost ? plainAssistantClientName(data.assistantClientHost) : null;
  const clientLabel = clientHost ? `${clientName} (${clientHost})` : clientName;
  const busy = showCode.isPending || applyHere.isPending;
  const framed = insideAFrame();
  const errorText = (err: unknown) => (err instanceof Error ? err.message : "That did not work.");

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 space-y-5" data-testid="batch-review-page" data-status={data.status}>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">
          {fromAssistant ? <>A batch change prepared by <span data-testid="batch-review-client">{clientLabel}</span></> : "A batch change"}
        </h1>
        <p className="text-sm text-muted-foreground" data-testid="batch-review-status">{statusLine(data, now)}</p>
      </div>

      {waiting && fromAssistant && framed ? (
        <p className="rounded-md border border-border p-4 text-sm" data-testid="batch-review-framed">
          Open this page in its own tab to see the code or apply the change.
        </p>
      ) : null}

      {waiting && fromAssistant && !framed ? (
        <div className="space-y-3 rounded-md border border-border p-4" data-testid="batch-review-actions">
          <p className="text-sm">
            Check every change below. To go ahead, show the code and read it to {clientLabel}, or apply it here yourself.
          </p>
          {code ? (
            <div className="space-y-1" data-testid="batch-review-code-box">
              <p className="font-mono text-3xl font-semibold tracking-widest" data-testid="batch-review-code">{code}</p>
              <p className="text-xs text-muted-foreground">
                Read this to {clientLabel}. It works once and expires in {minutesLeft(data.expiresAt, now)} minute{minutesLeft(data.expiresAt, now) === 1 ? "" : "s"}. Showing a new code replaces this one.
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={code ? "outline" : "default"}
              disabled={busy}
              onClick={() => showCode.mutate()}
              data-testid="batch-review-show-code"
              className="max-sm:min-h-11 max-sm:flex-1"
            >
              {code ? "Show a new code" : "Show code for Claude"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => applyHere.mutate()}
              data-testid="batch-review-apply-here"
              className="max-sm:min-h-11 max-sm:flex-1"
            >
              {applyHere.isPending ? "Applying…" : "Apply here"}
            </Button>
          </div>
          {showCode.isError ? <p className="text-xs text-destructive" role="alert">{errorText(showCode.error)}</p> : null}
          {applyHere.isError ? <p className="text-xs text-destructive" role="alert">{errorText(applyHere.error)}</p> : null}
        </div>
      ) : null}

      <ul className="divide-y divide-border rounded-md border border-border" data-testid="batch-review-items">
        {items.map((item) =>
          data.status === "previewed" ? (
            <li key={item.itemId} className="space-y-1 px-3 py-2" data-testid="batch-review-item">
              <span className="block break-words text-sm font-medium">{item.label}</span>
              <FieldChanges before={item.before} after={item.after} format={defaultFormat} />
            </li>
          ) : (
            <ResultRow key={item.itemId} item={item} format={defaultFormat} />
          ),
        )}
      </ul>
    </div>
  );
}
