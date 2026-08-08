import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { stewardshipsApi, type StewardFactRequest } from "../../api/stewardships";
import { Button } from "../ui/button";

/**
 * Questions your agent could not answer without you.
 *
 * The other half of escalation. An agent could already reach your machine, and
 * your machine could reply — but you could not. A fact only you knew aged out as
 * `missing` however available you were, because the one route that wrote an
 * answer required an agent key.
 *
 * This is also the shortest path to a board pack worth reading. Agents have no
 * connectors yet, so most figures are unavailable to them; a person typing what
 * they know is real data, attributed, and carries no injection risk because it
 * is not agent-authored.
 *
 * Two deliberate omissions:
 *
 *  - No "skip" or "dismiss". A fact that nobody answers should lapse on its
 *    lease and be flagged as missing, which is a fact about the week worth
 *    knowing. A dismiss button would let it disappear silently instead, and the
 *    whole design exists so an assembled deliverable shows where its holes are.
 *  - No pre-filled draft. Offering a suggested answer to approve is how a
 *    plausible guess acquires a person's name — the exact provenance failure
 *    this surface is here to prevent.
 */
export function QuestionsForYou({
  companyId,
  agentName,
}: {
  companyId: string;
  agentName: string;
}) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const pending = useQuery({
    queryKey: ["me", "fact-requests", companyId],
    queryFn: () => stewardshipsApi.myFactRequests(companyId),
    enabled: Boolean(companyId),
    // Someone else's agent may ask at any time, and this page is where the
    // person waits. Polling beats a stale list they have to think to refresh.
    refetchInterval: 30_000,
  });

  const answer = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      stewardshipsApi.answerFactRequest(companyId, id, text),
    onSuccess: async (_result, variables) => {
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[variables.id];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["me", "fact-requests", companyId] });
    },
  });

  const questions: StewardFactRequest[] = pending.data?.factRequests ?? [];

  if (questions.length === 0) {
    // Rendered rather than hidden: "nothing is waiting on me" is information a
    // steward wants, and a panel that only appears when there is work makes its
    // absence indistinguishable from a page that failed to load.
    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Questions for you</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing is waiting on you. When {agentName} is asked something only you can
          answer, it appears here.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">
        Questions for you
        <span className="ml-2 rounded-full bg-foreground px-2 py-0.5 text-xs text-background">
          {questions.length}
        </span>
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Someone's agent asked {agentName} for something it cannot look up. Your answer goes
        back with your name on it, and whatever is being assembled is waiting on it.
      </p>

      <ul className="mt-3 space-y-3">
        {questions.map((question) => (
          <li key={question.id} className="rounded-md border border-border p-3">
            <p className="text-sm">{question.question}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                {question.factKey}
              </code>{" "}
              · for {question.pipelineId}
              {question.escalatedAt ? " · escalated to you" : null}
            </p>

            <textarea
              className="mt-2 min-h-[72px] w-full resize-none rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              placeholder="What you know, and where it came from. If you do not know, say so — that is a useful answer."
              value={drafts[question.id] ?? ""}
              onChange={(event) =>
                setDrafts((previous) => ({ ...previous, [question.id]: event.target.value }))
              }
            />

            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Recorded as answered by you, not by {agentName}.
              </p>
              <Button
                size="sm"
                disabled={!drafts[question.id]?.trim() || answer.isPending}
                onClick={() =>
                  answer.mutate({ id: question.id, text: drafts[question.id]!.trim() })
                }
              >
                {answer.isPending ? "Sending…" : "Answer"}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {answer.error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {answer.error instanceof Error ? answer.error.message : "Could not send that answer"}
        </p>
      ) : null}
    </section>
  );
}
