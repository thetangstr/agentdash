import { useQuery } from "@tanstack/react-query";

import { capabilitiesApi, type CapabilityKey } from "../api/capabilities";

/**
 * Ask the server what this person may do. Never decide it here.
 *
 * Three states, and the third is the one that gets forgotten: allowed, denied,
 * and **not yet known**. A component that treats "loading" as "allowed" flashes
 * an editable control and then snatches it away; one that treats it as "denied"
 * flashes a read-only page at the owner of the company. Both look broken, so
 * callers get `isLoading` explicitly and are expected to render neither state
 * until it settles.
 *
 * Cached for a minute. Roles change rarely, and a stale answer here is
 * cosmetic — the API is the boundary, so the worst case is a control that
 * appears and then 403s, which is exactly what this reduces rather than
 * something it can create.
 */
export function useCapabilities(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ["me", "capabilities", companyId] as const,
    queryFn: () => capabilitiesApi.get(companyId!),
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });
}

/**
 * @returns `allowed` — true only when the server has said so. `isLoading` is
 * separate on purpose; do not collapse them into one boolean at the call site.
 */
export function useCapability(companyId: string | null | undefined, key: CapabilityKey) {
  const query = useCapabilities(companyId);
  return {
    allowed: query.data?.capabilities?.[key] === true,
    isLoading: query.isLoading,
    membershipRole: query.data?.membershipRole ?? null,
    isInstanceAdmin: query.data?.isInstanceAdmin ?? false,
  };
}

/**
 * The sentence to show when the server refuses.
 *
 * A toast that says "Error" is how a permission boundary gets mistaken for a
 * bug. The server already writes a human sentence for every 403 in this area —
 * "Only an owner, admin or operator can change company direction." — so the
 * client's job is to surface it, not to invent its own wording.
 */
export function refusalMessage(error: unknown, fallback = "You do not have permission to do that."): string {
  if (error && typeof error === "object") {
    const withMessage = error as { message?: unknown; error?: unknown };
    const raw = typeof withMessage.error === "string" ? withMessage.error : withMessage.message;
    if (typeof raw === "string" && raw.trim().length > 0) return raw;
  }
  return fallback;
}
