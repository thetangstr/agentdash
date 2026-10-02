import { useQuery } from "@tanstack/react-query";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";

/**
 * AgentDash (scan 2, E1): whether this install lets you create another company.
 *
 * A hosted agentdash.cloud box holds exactly one workspace, and the server
 * refuses a second one ("A hosted box holds one workspace") — but only after
 * the whole New Company form has been filled in. So every "New Company" entry
 * point hides on a box. Decided from health (`hostedBox`), never from the
 * company's product profile: this is about the install, not the company.
 *
 * Unknown health counts as "can create": self-hosted installs and dev keep the
 * button while health loads, and only a positive `hostedBox` hides it.
 */
export function useCanCreateCompany(): boolean {
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    staleTime: 60_000,
  });
  return health?.hostedBox !== true;
}
