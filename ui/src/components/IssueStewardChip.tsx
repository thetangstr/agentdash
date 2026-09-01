import { CircleDot, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { Issue, IssueAssigneeSteward, IssueAwaitingReview } from "@paperclipai/shared";
import { cn } from "../lib/utils";

/**
 * AgentDash: age-2 — steward accountability on issue cards.
 *
 * Shared rendering for the two list-payload fields the server joins onto
 * issues (`assigneeSteward`, `awaitingReviewByViewer`) so board cards and
 * list rows show exactly the same thing. Keep the chip and badge here;
 * don't fork them per surface.
 */

export function stewardDisplayName(
  steward: Pick<IssueAssigneeSteward, "userId" | "name" | "email">,
  labelByUserId?: Map<string, string>,
): string {
  const override = labelByUserId?.get(steward.userId);
  if (override) return override;
  if (steward.name?.trim()) return steward.name.trim();
  if (steward.email?.trim()) return steward.email.trim();
  return steward.userId.slice(0, 5);
}

/**
 * Summarize every issue in one steward bucket (a board column or list
 * group). A person can be the explicit steward of one agent and the
 * owner-fallback of another, and both land under the same userId — so the
 * bucket counts as a steward bucket if ANY issue in it carries an explicit
 * steward. Never let sort order pick the header icon.
 */
export function summarizeStewardBucket(
  issues: ReadonlyArray<Pick<Issue, "assigneeSteward">>,
): { steward: IssueAssigneeSteward | null; isOwnerFallback: boolean } {
  let explicit: IssueAssigneeSteward | null = null;
  let first: IssueAssigneeSteward | null = null;
  for (const issue of issues) {
    const steward = issue.assigneeSteward ?? null;
    if (!steward) continue;
    if (!first) first = steward;
    if (steward.source === "steward") {
      explicit = steward;
      break;
    }
  }
  const steward = explicit ?? first;
  return { steward, isOwnerFallback: steward !== null && explicit === null };
}

export function IssueStewardChip({
  steward,
  labelByUserId,
  className,
}: {
  steward: IssueAssigneeSteward;
  labelByUserId?: Map<string, string>;
  className?: string;
}) {
  const displayName = stewardDisplayName(steward, labelByUserId);
  const isOwnerFallback = steward.source === "owner";
  const Icon = isOwnerFallback ? ShieldQuestion : ShieldCheck;
  const tooltip = isOwnerFallback
    ? `Owner fallback — no active steward. ${displayName} created this agent.`
    : `Active steward: ${displayName}`;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium",
        isOwnerFallback
          ? "border-border bg-muted text-muted-foreground"
          : "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
        className,
      )}
      title={tooltip}
      aria-label={`${isOwnerFallback ? "Owner fallback" : "Steward"}: ${displayName}`}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden />
      <span className="max-w-[140px] truncate">{displayName}</span>
    </span>
  );
}

/**
 * The server already scopes `awaitingReviewByViewer` to the requesting
 * viewer, but a stale build or a forged client could ship any value —
 * cross-check the viewer on the payload; never trust the wire alone.
 */
export function isAwaitingViewerReview(
  awaitingReview: IssueAwaitingReview | null | undefined,
  viewerUserId: string | null | undefined,
): boolean {
  if (!viewerUserId || !awaitingReview) return false;
  return awaitingReview.viewerMatchesPrincipal === true && awaitingReview.viewerUserId === viewerUserId;
}

export function AwaitingReviewBadge({
  issue,
  viewerUserId,
  className,
}: {
  issue: Pick<Issue, "title" | "awaitingReviewByViewer">;
  viewerUserId?: string | null;
  className?: string;
}) {
  const awaitingReview = issue.awaitingReviewByViewer ?? null;
  if (!isAwaitingViewerReview(awaitingReview, viewerUserId)) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200",
        className,
      )}
      title={`Awaiting your review (${awaitingReview?.stageType ?? "review"})`}
      aria-label={`Awaiting your review on ${issue.title}`}
    >
      <CircleDot className="h-2.5 w-2.5" aria-hidden />
      Awaiting your review
    </span>
  );
}
