import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";

// AgentDash: Agent Performance Management — names for the ids a profile or a
// profile-change approval carries (listed projects, a reports-to agent, an
// escalation person). A screen shows the name when it has one and the id only
// when it doesn't. The lists are the ones the rest of the app already reads,
// under the same query keys; a list the viewer can't read just leaves ids.

/** The name for a project, agent or person id, or null when the screen has none. */
export type ProfileNameLookup = (id: string) => string | null;

type Named = { id?: unknown; name?: unknown };
type DirectoryEntry = { principalId?: unknown; user?: { name?: unknown; email?: unknown } | null };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Ids are unique across tables, so one map serves every kind. Anything that isn't a list is ignored. */
export function buildProfileNameLookup(input: { agents?: unknown; projects?: unknown; people?: unknown }): ProfileNameLookup {
  const names = new Map<string, string>();
  for (const list of [input.agents, input.projects]) {
    if (!Array.isArray(list)) continue;
    for (const item of list as Named[]) {
      const id = text(item?.id);
      const name = text(item?.name);
      if (id && name) names.set(id, name);
    }
  }
  if (Array.isArray(input.people)) {
    for (const entry of input.people as DirectoryEntry[]) {
      const id = text(entry?.principalId);
      const name = text(entry?.user?.name) ?? text(entry?.user?.email);
      if (id && name) names.set(id, name);
    }
  }
  return (id: string) => names.get(id) ?? null;
}

export function useProfileNames(companyId: string | null | undefined): ProfileNameLookup {
  const enabled = !!companyId;
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled,
    retry: false,
  });
  const projects = useQuery({
    queryKey: queryKeys.projects.list(companyId ?? ""),
    queryFn: () => projectsApi.list(companyId!),
    enabled,
    retry: false,
  });
  const people = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId ?? ""),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled,
    retry: false,
  });
  return useMemo(
    () => buildProfileNameLookup({ agents: agents.data, projects: projects.data, people: people.data?.users }),
    [agents.data, projects.data, people.data],
  );
}
