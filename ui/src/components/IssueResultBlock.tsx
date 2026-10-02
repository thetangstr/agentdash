// AgentDash: UX-2 (#783) — "Result" on issue detail: what this issue produced.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { formatShippedUsage } from "../lib/shipped";
import { ShippedWorkProductRow } from "./ShippedWorkProductRow";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export const REQUEST_CHANGES_NOTE_MAX = 2000;

export interface IssueResultReviewActions {
  /** Accept the work: the issue moves to done and its deliverables are recorded as accepted. */
  onAccept: () => Promise<unknown>;
  /** Send it back with a note: posted as a comment, the issue returns to the assignee. */
  onRequestChanges: (note: string) => Promise<unknown>;
}

export function IssueResultBlock({
  companyId,
  issueId,
  issueStatus,
  review,
}: {
  companyId: string;
  issueId: string;
  issueStatus?: string | null;
  /**
   * AgentDash (Scan 3 lane I): passed only for a board user. With it, a
   * deliverable waiting for review gets Accept and Request changes here, on
   * the issue the Decisions review row opens.
   */
  review?: IssueResultReviewActions | null;
}) {
  // Same block for every company (one UX).
  const { data } = useQuery({
    queryKey: queryKeys.shipped(companyId, { issueId }),
    queryFn: () => issuesApi.listShipped(companyId, { issueId }),
  });
  const [mode, setMode] = useState<"idle" | "note">("idle");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"accept" | "changes" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items = data?.items ?? [];
  if (items.length === 0) return null;
  const usage = items[0]!.usage;
  const awaitingReview =
    !!review
    && issueStatus !== "done"
    && issueStatus !== "cancelled"
    && items.some((product) => product.status === "ready_for_review");

  async function run(kind: "accept" | "changes", action: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
      setMode("idle");
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't go through. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const trimmedNote = note.trim();
  return (
    <section
      aria-label="Result"
      data-testid="issue-result-block"
      className="rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 max-sm:py-1.5">
        <h3 className="text-sm font-medium">Result</h3>
        <span className="text-xs text-muted-foreground">{formatShippedUsage(usage)}</span>
      </div>
      <div className="divide-y divide-border">
        {items.map((product) => (
          <ShippedWorkProductRow key={product.id} product={product} showIssue={false} showUsage={false} />
        ))}
      </div>
      {awaitingReview ? (
        <div className="space-y-2 border-t border-border px-3 py-2.5" data-testid="issue-review-actions">
          {mode === "note" ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!trimmedNote || busy) return;
                void run("changes", () => review!.onRequestChanges(trimmedNote));
              }}
            >
              <label htmlFor={`request-changes-${issueId}`} className="text-xs font-medium text-muted-foreground">
                What should change?
              </label>
              <Textarea
                id={`request-changes-${issueId}`}
                data-testid="issue-review-note"
                value={note}
                maxLength={REQUEST_CHANGES_NOTE_MAX}
                autoFocus
                rows={3}
                placeholder="A short note for the agent, e.g. add hotel prices for Kyoto"
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  className="max-sm:h-11"
                  disabled={!trimmedNote || busy !== null}
                  data-testid="issue-review-send-changes"
                >
                  {busy === "changes" ? "Sending…" : "Send back"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="max-sm:h-11"
                  disabled={busy !== null}
                  onClick={() => {
                    setMode("idle");
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-auto text-xs text-muted-foreground">Is this what you wanted?</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="max-sm:h-11"
                disabled={busy !== null}
                onClick={() => setMode("note")}
                data-testid="issue-review-request-changes"
              >
                Request changes
              </Button>
              <Button
                type="button"
                size="sm"
                className="max-sm:h-11"
                disabled={busy !== null}
                onClick={() => void run("accept", review!.onAccept)}
                data-testid="issue-review-accept"
              >
                {busy === "accept" ? "Accepting…" : "Accept"}
              </Button>
            </div>
          )}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
