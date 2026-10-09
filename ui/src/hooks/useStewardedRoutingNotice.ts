import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { useToastActions } from "../context/ToastContext";
import { buildCompanyUserLabelMap } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { stewardedRoutingNotice, type StewardedAgentRouteNotice } from "../lib/stewarded-routing-notice";

/**
 * AgentDash: the callback a page passes an issue create/update response to,
 * so every assignee change says when the server gave the issue to the agent
 * the named person stewards. Reads the same agent list and user directory
 * the issue pages already cache.
 */
export function useStewardedRoutingNotice(companyId: string | null | undefined) {
  const { pushToast } = useToastActions();
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const { data: directory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId!),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId,
  });
  const agentMap = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);
  const people = useMemo(() => buildCompanyUserLabelMap(directory?.users), [directory?.users]);
  return useCallback(
    (response: { routedToStewardedAgent?: StewardedAgentRouteNotice } | null | undefined) => {
      const notice = stewardedRoutingNotice(response?.routedToStewardedAgent, agentMap, people);
      if (notice) pushToast({ title: notice, tone: "info" });
    },
    [agentMap, people, pushToast],
  );
}
