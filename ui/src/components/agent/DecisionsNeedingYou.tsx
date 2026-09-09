import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { approvalsApi } from "../../api/approvals";
import type { InboxItem } from "../../api/stewardships";
import { Button } from "../ui/button";
import { queryKeys } from "../../lib/queryKeys";
import { timeSince, timeUntil } from "../../lib/timeAgo";

/**
 * The decisions an agent is stopped on, and the buttons to make them.
 *
 * Previously these were links to `/approvals/:id` sitting eighth on the page,
 * rendered as `type.replace(/_/g, " ")` — "request board approval" — with the
 * revision and risk level appended as bare words. Three things were already in
 * the payload and shown nowhere: `risk.reason`, which is the sentence
 * explaining why the decision matters; `expiresAt`, so a decision could lapse
 * with nobody having seen a clock; and `sourceIssues[].title`, so the work was
 * identified only by ticket number.
 *
 * `revision` stays on screen deliberately. It is the stale-card protection —
 * the decision endpoint requires the revision the decider was shown — so a
 * steward being able to see which version they are answering is part of the
 * guarantee, not clutter.
 */

/**
 * What each approval type is actually asking, as a phrase completing
 * "<agent> …". Eleven types is a small enough closed set to write out; unlike
 * activity actions, a lookup table here can be complete.
 *
 * Not every one is a request. `mandate_violation` is a report and
 * `workflow_recommendation` is advisory, so the phrases are not forced into a
 * single "wants to" shape.
 */
const ASKS: Record<string, string> = {
  hire_agent: "wants to hire another agent",
  approve_ceo_strategy: "wants sign-off on the strategy",
  budget_override_required: "has run out of budget and cannot continue",
  request_board_approval: "wants board approval",
  mandate_violation: "did something its mandate does not allow",
  connector_send: "wants to send something outside the company",
  inbound_content_review: "wants to release content that was held back",
  deliverable_review: "needs your sign-off on a deliverable",
  workflow_recommendation: "has a suggestion about how this work runs",
};

function askSentence(item: InboxItem, fallbackName: string): string {
  const who = item.requestingAgent?.name ?? fallbackName;
  const ask = ASKS[item.type];
  return ask ? `${who} ${ask}` : `${who}: ${item.type.replace(/_/g, " ")}`;
}

export function DecisionsNeedingYou({
  companyId,
  agentId,
  agentName,
  items,
}: {
  companyId: string;
  agentId: string | null;
  agentName: string;
  items: InboxItem[];
}) {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: ({
      approvalId,
      revision,
      outcome,
    }: {
      approvalId: string;
      revision: number;
      outcome: "approve" | "reject";
    }) =>
      outcome === "approve"
        ? approvalsApi.approve(approvalId, { revision })
        : approvalsApi.reject(approvalId, { revision }),
    onSuccess: () => {
      setFailed(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.myAgent.inbox(companyId) });
      if (agentId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.myAgent.activity(companyId, agentId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.myAgent.currentWork(companyId, agentId),
        });
      }
    },
    // A refused decision is usually a stale revision — somebody else decided,
    // or the agent revised the request. Saying so beats a silent no-op.
    onError: (error: unknown) =>
      setFailed(
        error instanceof Error
          ? error.message
          : "That decision did not go through. Reload and try again.",
      ),
  });

  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby="needs-you-heading"
      className="rounded-lg border border-destructive/40 bg-destructive/[0.03]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-destructive/30 px-4 py-2.5">
        <h2 id="needs-you-heading" className="text-sm font-semibold">
          Needs you
        </h2>
        <span className="text-xs text-muted-foreground">
          {items.length} awaiting your decision
        </span>
      </div>

      {failed ? (
        <p className="px-4 pt-3 text-xs text-destructive" role="alert">
          {failed}
        </p>
      ) : null}

      <ul className="divide-y divide-border">
        {items.map((item) => {
          const expiresIn = item.expiresAt ? timeUntil(item.expiresAt) : null;
          const expired = !!item.expiresAt && expiresIn === null;
          const busy = decide.isPending && decide.variables?.approvalId === item.approvalId;

          return (
            <li key={item.approvalId} className="flex flex-col gap-2 px-4 py-3">
              <p className="text-sm font-medium">{askSentence(item, agentName)}</p>

              {item.risk?.reason ? (
                <p className="text-xs text-muted-foreground">{item.risk.reason}</p>
              ) : null}

              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {item.risk?.level ? (
                  <span
                    className={`rounded-full border px-1.5 py-0.5 ${
                      item.risk.level === "high"
                        ? "border-destructive/50 text-destructive"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {item.risk.level} risk
                  </span>
                ) : null}
                {item.createdAt ? (
                  <span className="rounded-full border border-border px-1.5 py-0.5 text-muted-foreground">
                    waiting {timeSince(item.createdAt)}
                  </span>
                ) : null}
                {expired ? (
                  <span className="rounded-full border border-destructive/50 px-1.5 py-0.5 text-destructive">
                    expired
                  </span>
                ) : expiresIn ? (
                  <span className="rounded-full border border-destructive/50 px-1.5 py-0.5 text-destructive">
                    expires in {expiresIn}
                  </span>
                ) : null}
                <span className="rounded-full border border-border px-1.5 py-0.5 text-muted-foreground">
                  revision {item.revision}
                </span>
              </div>

              {item.sourceIssues?.length ? (
                <p className="text-xs text-muted-foreground">
                  {item.sourceIssues.map((issue) => issue.title || issue.identifier).join(", ")}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <Button
                  size="sm"
                  disabled={busy || expired}
                  onClick={() =>
                    decide.mutate({
                      approvalId: item.approvalId,
                      revision: item.revision,
                      outcome: "approve",
                    })
                  }
                >
                  {busy ? "Deciding…" : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || expired}
                  onClick={() =>
                    decide.mutate({
                      approvalId: item.approvalId,
                      revision: item.revision,
                      outcome: "reject",
                    })
                  }
                >
                  Decline
                </Button>
                <Link
                  to={`/approvals/${item.approvalId}`}
                  className="text-xs underline text-muted-foreground"
                >
                  See the detail
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
