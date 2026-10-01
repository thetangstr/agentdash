import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Who can see this project.
 *
 * A5 made projects restrictable and gave the server a replaceable access
 * list (`GET`/`PUT /projects/:id/access`); nothing on the page ever edited it.
 * Agent visibility (2026-09-30) makes the list the way an administrator
 * shares work with a member who otherwise sees only their own agents, so it
 * needs a hand. Humans only here: agents are listed automatically when a
 * project's lead is set, and the design keeps agents out of this rule.
 */
interface Props {
  projectId: string;
  companyId: string;
  visibility: "company" | "restricted";
  canManage: boolean;
}

export function ProjectAccessEditor({ projectId, companyId, visibility, canManage }: Props) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accessQuery = useQuery({
    queryKey: ["projects", projectId, "access"] as const,
    queryFn: () => projectsApi.getAccess(projectId, companyId),
    enabled: canManage,
  });
  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    enabled: canManage,
  });

  const listed = useMemo(() => {
    const ids = new Set<string>();
    for (const row of accessQuery.data?.access ?? []) if (row.principalType === "user") ids.add(row.principalId);
    return ids;
  }, [accessQuery.data]);

  useEffect(() => {
    if (accessQuery.data) setSelected(new Set(listed));
  }, [accessQuery.data, listed]);

  const setVisibility = useMutation({
    mutationFn: (next: "company" | "restricted") => projectsApi.update(projectId, { visibility: next }, companyId),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "access"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not change who can see this project."),
  });

  const save = useMutation({
    mutationFn: (userIds: string[]) => {
      // Keep the agents the server listed; only the humans are edited here.
      const agents = (accessQuery.data?.access ?? []).filter((row) => row.principalType === "agent");
      return projectsApi.replaceAccess(
        projectId,
        {
          access: [
            ...agents.map((row) => ({ principalType: "agent" as const, principalId: row.principalId })),
            ...userIds.map((principalId) => ({ principalType: "user" as const, principalId })),
          ],
        },
        companyId,
      );
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "access"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not save the access list."),
  });

  if (!canManage) return null;

  const members = (membersQuery.data?.members ?? []).filter((m) => m.status === "active" && m.principalType === "user");
  const current = selected ?? listed;
  const dirty = selected !== null && (selected.size !== listed.size || [...selected].some((id) => !listed.has(id)));

  return (
    <section aria-labelledby="project-access-heading" className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 id="project-access-heading" className="text-base font-semibold">
          Who can see this project
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          An open project is visible to every member. A restricted project is visible only to administrators, its
          creator, and the people listed here — and listing someone shows them every issue in it, whichever agents are
          working in it.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <span className="font-medium">Visibility</span>
        <select
          aria-label="Project visibility"
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={visibility}
          disabled={setVisibility.isPending}
          onChange={(event) => setVisibility.mutate(event.target.value as "company" | "restricted")}
        >
          <option value="company">Everyone in the company</option>
          <option value="restricted">Only people on the list</option>
        </select>
      </label>
      {visibility === "restricted" ? (
        <div className="space-y-2">
          {membersQuery.isLoading || accessQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active members to list.</p>
          ) : (
            <ul className="space-y-1">
              {members.map((member) => {
                const label = member.user?.name || member.user?.email || member.principalId;
                const checked = current.has(member.principalId);
                return (
                  <li key={member.principalId}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(current);
                          if (checked) next.delete(member.principalId);
                          else next.add(member.principalId);
                          setSelected(next);
                        }}
                      />
                      <span>{label}</span>
                      {member.membershipRole === "admin" ? (
                        <span className="text-xs text-muted-foreground">administrator — sees everything anyway</span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            className="rounded-md border px-3 py-1 text-sm disabled:opacity-50"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate([...current])}
          >
            {save.isPending ? "Saving…" : "Save access list"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
