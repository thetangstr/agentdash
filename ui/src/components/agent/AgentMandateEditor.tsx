import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

interface Props {
  agentId: string;
  companyId: string;
}

/**
 * The steward's mandate editor.
 *
 * Per design 6.3 this reuses the existing instruction-bundle system rather than
 * introducing a parallel mandate store, so edits inherit its revision and
 * rollback behavior. It edits the bundle's ENTRY FILE only — bundle location
 * and mode are administrator-controlled, because an external root is an
 * arbitrary host directory the server writes into.
 */
/**
 * Says what a mandate IS, before anything about editing one.
 *
 * The panel was headed "Mandate" with one line about version history — vocabulary
 * from this product's design, presented as if self-evident. It is not: a person
 * meeting this page cold has no reason to know the word means "the instruction
 * file that steers my agent". Deliberately over-explained, because this text is
 * the single highest-leverage thing a steward can change and the page gave them
 * no reason to think so.
 */
function MandateExplainer({ entryFile }: { entryFile: string | null }) {
  return (
    <div className="mt-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">The mandate is your agent&rsquo;s job
        description and rulebook, in plain text.</span> It is a file
        ({entryFile ?? "AGENTS.md"}) the agent reads before every piece of work — the same way a
        CLAUDE.md or AGENTS.md file steers a coding agent.
      </p>
      <p className="mt-1.5">
        It says who the agent is and whose agent it is, what it may do on its own, what it must
        check with a person first, what it must never do, and whose word wins when two people
        disagree. When the agent runs — from here, or from a Claude Code or Codex connected with
        its key — this text is what it follows.
      </p>
      <p className="mt-1.5">
        Edit it in your own words. Changes are versioned and take effect from the agent&rsquo;s
        next run.
      </p>
    </div>
  );
}

export function AgentMandateEditor({ agentId, companyId }: Props) {
  const queryClient = useQueryClient();
  // Keyed by agent: the component is re-rendered rather than remounted when the
  // selected company or the stewarded agent changes, so an unkeyed draft could
  // be saved into a DIFFERENT agent's entry file — a silent last-write-wins
  // overwrite of a governance document.
  const [draft, setDraft] = useState<{ agentId: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const bundle = useQuery({
    queryKey: queryKeys.agents.instructionsBundle(agentId),
    queryFn: () => agentsApi.instructionsBundle(agentId, companyId),
    enabled: !!agentId && !!companyId,
  });

  const entryFile = bundle.data?.entryFile ?? null;

  const file = useQuery({
    queryKey: queryKeys.agents.instructionsFile(agentId, entryFile ?? ""),
    queryFn: () => agentsApi.instructionsFile(agentId, entryFile!, companyId),
    enabled: !!agentId && !!companyId && !!entryFile,
  });

  useEffect(() => {
    if (!file.data) return;
    if (draft?.agentId === agentId) return;
    setDraft({ agentId, content: file.data.content ?? "" });
    setSaved(false);
    setError(null);
  }, [file.data, draft, agentId]);

  const createMandate = useMutation({
    mutationFn: () => agentsApi.refreshInstructions(companyId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
    },
  });
  const save = useMutation({
    mutationFn: () => {
      if (!draft || draft.agentId !== agentId) {
        // Refuse rather than write someone else's text into this agent.
        throw new Error("Mandate is still loading for this agent");
      }
      return agentsApi.saveInstructionsFile(
        agentId,
        { path: entryFile!, content: draft.content },
        companyId,
      );
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.instructionsFile(agentId, entryFile ?? ""),
      });
    },
    onError: (err) => {
      setSaved(false);
      setError(err instanceof Error ? err.message : "Failed to save mandate");
    },
  });

  if (bundle.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading mandate…</p>;
  }

  // The server refuses steward edits outside the managed bundle root. `mode` is
  // what reports that — `entryFile` is always populated, so keying off it left
  // this branch unreachable and handed the steward an editor that 403s on save.
  const isManaged = bundle.data?.mode === "managed";
  // AgentDash (AGE-8): "externally managed" was shown for every non-managed
  // state, including the agent that simply has no mandate file yet — which told
  // the steward an administrator had put it somewhere when nobody had. Say what
  // is true, and offer to create it.
  const hasNoBundle = !bundle.error && bundle.data?.mode !== "managed" && bundle.data?.mode !== "external";
  if (bundle.error || !entryFile || !isManaged) {
    return (
      <section aria-labelledby="mandate-heading" className="rounded-lg border p-4">
        <h2 id="mandate-heading" className="text-sm font-semibold">
          Mandate
        </h2>
        <MandateExplainer entryFile={entryFile} />
        <p className="mt-2 text-xs text-muted-foreground">
          {bundle.error instanceof Error
            ? bundle.error.message
            : hasNoBundle
              ? "This agent has no mandate file yet, so nothing you write here reaches it. It is created automatically before the agent's next run; you can also create it now."
              : "This agent's mandate lives in an externally managed location; an administrator configures where. You can read the concepts above, but editing happens where the administrator keeps the file."}
        </p>
        {hasNoBundle ? (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
              disabled={createMandate.isPending}
              onClick={() => createMandate.mutate()}
            >
              {createMandate.isPending ? "Creating…" : "Create mandate now"}
            </button>
            {createMandate.error ? (
              <span className="text-xs text-destructive">
                {createMandate.error instanceof Error ? createMandate.error.message : "Failed to create mandate"}
              </span>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-labelledby="mandate-heading" className="rounded-lg border p-4">
      <h2 id="mandate-heading" className="text-sm font-semibold">
        Mandate
      </h2>
      <MandateExplainer entryFile={entryFile} />
      <p className="mt-2 text-xs text-muted-foreground">
        Editing {entryFile}. Every save is versioned, so nothing is lost by changing it.
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {saved && !error ? <p className="mt-2 text-xs text-muted-foreground">Saved.</p> : null}

      <textarea
        aria-label="Mandate"
        className="mt-2 h-48 w-full rounded border p-2 font-mono text-xs"
        value={draft?.content ?? ""}
        onChange={(event) => {
          setDraft({ agentId, content: event.target.value });
          setSaved(false);
        }}
      />

      <button
        type="button"
        disabled={save.isPending || draft?.agentId !== agentId}
        onClick={() => save.mutate()}
        className="mt-2 rounded border px-2 py-1 text-xs disabled:opacity-50"
      >
        Save mandate
      </button>
    </section>
  );
}
