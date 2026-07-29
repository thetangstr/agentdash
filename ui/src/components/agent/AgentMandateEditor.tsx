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
  const [draft, setDraft] = useState<string | null>(null);
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
    if (file.data && draft === null) setDraft(file.data.content ?? "");
  }, [file.data, draft]);

  const save = useMutation({
    mutationFn: () =>
      agentsApi.saveInstructionsFile(
        agentId,
        { path: entryFile!, content: draft ?? "" },
        companyId,
      ),
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

  // The server refuses steward edits outside the managed bundle root, so an
  // external root is an expected state here, not an error to hide.
  if (bundle.error || !entryFile) {
    return (
      <section aria-labelledby="mandate-heading" className="rounded-lg border p-4">
        <h2 id="mandate-heading" className="text-sm font-semibold">
          Mandate
        </h2>
        <p className="mt-2 text-xs text-muted-foreground">
          {bundle.error instanceof Error
            ? bundle.error.message
            : "This agent has no managed instructions bundle. An administrator configures where instructions live."}
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
        value={draft ?? ""}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaved(false);
        }}
      />

      <button
        type="button"
        disabled={save.isPending || draft === null}
        onClick={() => save.mutate()}
        className="mt-2 rounded border px-2 py-1 text-xs disabled:opacity-50"
      >
        Save mandate
      </button>
    </section>
  );
}
