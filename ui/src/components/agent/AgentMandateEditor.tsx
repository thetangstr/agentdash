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
  if (bundle.error || !entryFile || !isManaged) {
    return (
      <section aria-labelledby="mandate-heading" className="rounded-lg border p-4">
        <h2 id="mandate-heading" className="text-sm font-semibold">
          Mandate
        </h2>
        <p className="mt-2 text-xs text-muted-foreground">
          {bundle.error instanceof Error
            ? bundle.error.message
            : "This agent uses an externally managed instructions bundle. An administrator configures where instructions live."}
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="mandate-heading" className="rounded-lg border p-4">
      <h2 id="mandate-heading" className="text-sm font-semibold">
        Mandate
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Editing {entryFile}. Changes are versioned by the instruction-bundle history.
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
