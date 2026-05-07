// AgentDash: goals-eval-hitl
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Bot, User, Workflow, Gavel } from "lucide-react";
import { goalsEvalHitlApi, goalsEvalHitlQueryKeys, type ReviewTimelineRow } from "../api/goals-eval-hitl";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

interface VerdictTimelineProps {
  companyId: string;
  issueId: string;
}

export function VerdictTimeline({ companyId, issueId }: VerdictTimelineProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: goalsEvalHitlQueryKeys.reviewTimeline(companyId, issueId),
    queryFn: () => goalsEvalHitlApi.fetchReviewTimeline(companyId, issueId),
    enabled: !!companyId && !!issueId,
  });

  if (isLoading && !data) {
    return (
      <div className="space-y-2">
        <div className="h-12 bg-muted/40 animate-pulse rounded" />
        <div className="h-12 bg-muted/40 animate-pulse rounded" />
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }

  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No review history yet.</p>
    );
  }

  // Newest first — matches the existing IssueRunLedger / activity rows
  // ordering in IssueDetail. The server returns chronological (oldest
  // first) so we reverse here.
  const ordered = [...data].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div className="border border-border divide-y divide-border">
      {ordered.map((row) => (
        <VerdictTimelineRow key={`${row.source}:${row.rowId}`} row={row} />
      ))}
    </div>
  );
}

function VerdictTimelineRow({ row }: { row: ReviewTimelineRow }) {
  const [expanded, setExpanded] = useState(false);
  const isVerdict = row.source === "verdict";
  const hasRubric =
    isVerdict && row.rubricScores && Object.keys(row.rubricScores).length > 0;
  const canExpand = hasRubric || (row.body && row.body.length > 0);

  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <span className="shrink-0 mt-0.5">
          {isVerdict ? (
            <Gavel className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Workflow className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium",
                isVerdict
                  ? "bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {isVerdict ? "verdict" : "execution"}
            </span>
            <span
              className={cn(
                "text-xs font-medium",
                outcomeColorClass(row.outcome),
              )}
            >
              {row.outcome}
            </span>
            <span className="text-xs text-muted-foreground/70">
              {timeAgo(row.createdAt)}
            </span>
            {(row.reviewerAgentId || row.reviewerUserId) && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                {row.reviewerAgentId ? (
                  <Bot className="h-3 w-3" />
                ) : (
                  <User className="h-3 w-3" />
                )}
                <span className="font-mono">
                  {(row.reviewerAgentId ?? row.reviewerUserId ?? "").slice(0, 8)}
                </span>
              </span>
            )}
          </div>
          {row.body && (
            <p className="mt-1.5 text-sm text-muted-foreground whitespace-pre-wrap break-words">
              {row.body}
            </p>
          )}
          {canExpand && hasRubric && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {expanded ? "Hide rubric" : "Show rubric"}
            </button>
          )}
          {expanded && hasRubric && row.rubricScores && (
            <div className="mt-2 space-y-1">
              {Object.entries(row.rubricScores).map(([key, value]) => (
                <RubricRow key={key} label={key} value={value} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RubricRow({ label, value }: { label: string; value: unknown }) {
  let display: string;
  let justification: string | null = null;
  if (typeof value === "number") {
    display = value.toString();
  } else if (
    value &&
    typeof value === "object" &&
    "score" in (value as Record<string, unknown>)
  ) {
    const obj = value as { score: number; justification?: string };
    display = obj.score.toString();
    justification = obj.justification ?? null;
  } else {
    display = JSON.stringify(value);
  }
  return (
    <div className="text-xs">
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-muted-foreground"> · {display}</span>
      {justification && (
        <p className="mt-0.5 ml-2 text-muted-foreground/70">{justification}</p>
      )}
    </div>
  );
}

function outcomeColorClass(outcome: string): string {
  switch (outcome) {
    case "passed":
      return "text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "text-red-600 dark:text-red-400";
    case "revision_requested":
      return "text-amber-600 dark:text-amber-400";
    case "escalated_to_human":
      return "text-blue-600 dark:text-blue-400";
    default:
      return "text-muted-foreground";
  }
}
