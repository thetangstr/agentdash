// AgentDash (one UX): whether stewardship is on for a company, as the SERVER
// says — never read from the company's product profile.
//
// The answer comes from `GET /me/capabilities` (`features.stewardship`), which
// the server computes with the same predicate that gates the stewardship
// routes. Asking that once replaced probing `/me/inbox` and reading its 404:
// a workspace without stewardship used to log a 404 per probe, per surface,
// per mount (scan 3 lane L). When the server cannot say (an older server, or a
// failed lookup) this falls back to the probe: `/me/inbox` answers 404 when
// stewardship is off, and `/me/agent` and the assign/transfer/release routes
// answer the same, so a write can never land where the capability is off.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { capabilitiesApi } from "@/api/capabilities";
import { stewardshipsApi } from "@/api/stewardships";
import { isCapabilityNotFound } from "@/components/AvailableOnRequest";
import { capabilitiesQueryKey, useCapabilities } from "@/hooks/useCapability";
import { queryKeys } from "@/lib/queryKeys";

export type CapabilityState = "loading" | "on" | "off";

/** The server's direct answer: on, off, still loading, or "could not tell". */
export type FeatureAnswer = CapabilityState | "unknown";

function stewardshipProbe(companyId: string) {
  return {
    queryKey: queryKeys.myAgent.inbox(companyId),
    queryFn: () => stewardshipsApi.getMyInbox(companyId),
  };
}

/**
 * What `/me/capabilities` says about stewardship. "unknown" when the server
 * did not say (older server, failed lookup, failed request): callers then ask
 * the gated route as they always did.
 */
export function useStewardshipFeature(companyId: string | null | undefined): FeatureAnswer {
  const capabilities = useCapabilities(companyId);
  if (!companyId) return "loading";
  // A failed first attempt falls back at once rather than waiting out retries.
  if (capabilities.isPending && capabilities.failureCount === 0) return "loading";
  const answer = capabilities.data?.features?.stewardship;
  if (answer === true) return "on";
  if (answer === false) return "off";
  return "unknown";
}

/**
 * "on" once the gate has passed (a success, or a non-404 failure such as a 403
 * for a non-board actor — the gate itself let the request through), "off" on
 * the gate's 404, "loading" until the answer is in. The probe runs only when
 * `/me/capabilities` could not answer directly.
 */
export function useStewardshipCapability(companyId: string | null | undefined): CapabilityState {
  const feature = useStewardshipFeature(companyId);
  const inbox = useQuery({
    ...stewardshipProbe(companyId ?? ""),
    enabled: !!companyId && feature === "unknown",
  });
  if (!companyId || feature === "loading") return "loading";
  if (feature !== "unknown") return feature;
  if (inbox.isPending) return "loading";
  if (isCapabilityNotFound(inbox.error)) return "off";
  return "on";
}

/**
 * Strict, imperative form for code that WRITES stewardship data (for example
 * pairing an owner with the agent they just created): true only when the gated
 * route answered successfully. Any failure counts as off, so an unknown answer
 * never creates stewardship rows the server would not otherwise hold. When the
 * server already said stewardship is off, the gated route is not asked.
 */
export async function fetchStewardshipOn(queryClient: QueryClient, companyId: string): Promise<boolean> {
  try {
    const capabilities = await queryClient.fetchQuery({
      queryKey: capabilitiesQueryKey(companyId),
      queryFn: () => capabilitiesApi.get(companyId),
    });
    if (capabilities.features?.stewardship === false) return false;
  } catch {
    // Could not ask; the probe below decides.
  }
  try {
    await queryClient.fetchQuery(stewardshipProbe(companyId));
    return true;
  } catch {
    return false;
  }
}
