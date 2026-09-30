// AgentDash (one UX): whether stewardship is on for a company, as the SERVER
// says — never read from the company's product profile.
//
// `/me/inbox` is the stewardship route behind the server's capability gate: it
// answers 404 when stewardship is off for the workspace. Some stewardship
// routes (assignment, `/me/agent`) are not gated themselves, so surfaces that
// write through them ask this first. It shares MyAgent's query key, so it costs
// at most one request per company.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { stewardshipsApi } from "@/api/stewardships";
import { isCapabilityNotFound } from "@/components/AvailableOnRequest";
import { queryKeys } from "@/lib/queryKeys";

export type CapabilityState = "loading" | "on" | "off";

function stewardshipProbe(companyId: string) {
  return {
    queryKey: queryKeys.myAgent.inbox(companyId),
    queryFn: () => stewardshipsApi.getMyInbox(companyId),
  };
}

/**
 * "on" once the gate has passed (a success, or a non-404 failure such as a 403
 * for a non-board actor — the gate itself let the request through), "off" on
 * the gate's 404, "loading" until the answer is in.
 */
export function useStewardshipCapability(companyId: string | null | undefined): CapabilityState {
  const inbox = useQuery({
    ...stewardshipProbe(companyId ?? ""),
    enabled: !!companyId,
  });
  if (!companyId || inbox.isPending) return "loading";
  if (isCapabilityNotFound(inbox.error)) return "off";
  return "on";
}

/**
 * Strict, imperative form for code that WRITES stewardship data (for example
 * pairing an owner with the agent they just created): true only when the gated
 * route answered successfully. Any failure counts as off, so an unknown answer
 * never creates stewardship rows the server would not otherwise hold.
 */
export async function fetchStewardshipOn(queryClient: QueryClient, companyId: string): Promise<boolean> {
  try {
    await queryClient.fetchQuery(stewardshipProbe(companyId));
    return true;
  } catch {
    return false;
  }
}
