// AgentDash (MVP launch lane B): one deliverable waiting for the person's
// review, as listed on Home's "Waiting on you" and the Decisions page.
import type { WaitingOnYouReview } from "@paperclipai/shared";
import { FileCheck } from "lucide-react";
import { Link } from "@/lib/router";
import { issueUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";

export function ReviewWaitingRow({ review, testId = "review-waiting-row" }: { review: WaitingOnYouReview; testId?: string }) {
  const deliverables = review.readyForReviewCount;
  return (
    <li data-testid={testId} className="flex items-start gap-3 px-4 py-2.5">
      <FileCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      <div className="min-w-0 flex-1">
        <Link
          to={issueUrl({ id: review.issueId, identifier: review.identifier })}
          className="text-sm font-medium hover:underline"
        >
          {review.summary}
        </Link>
        <div className="flex min-w-0 flex-wrap gap-x-2 text-xs [overflow-wrap:anywhere] text-muted-foreground">
          <span>Review</span>
          {review.identifier ? (
            <>
              <span aria-hidden>·</span>
              <span>{review.identifier}</span>
            </>
          ) : null}
          {review.submittedBy ? (
            <>
              <span aria-hidden>·</span>
              <span>from {review.submittedBy}</span>
            </>
          ) : null}
          {deliverables > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span>
                {deliverables} deliverable{deliverables === 1 ? "" : "s"} ready
              </span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span>waiting {timeAgo(review.waitingSince)}</span>
        </div>
      </div>
    </li>
  );
}
