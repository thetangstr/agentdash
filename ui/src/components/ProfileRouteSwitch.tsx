import type { ReactNode } from "react";
import { Navigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { loadLastInboxTab } from "../lib/inbox";
import { PageSkeleton } from "./PageSkeleton";

/**
 * AgentDash: UX-7 (GH #788) — the product profile is knowable only once the
 * companies query has resolved AND a company is selected: `selectedCompany`
 * is null during the fetch, and stays null for one more render while the
 * selection effect picks a company from the loaded list. Redirecting in
 * that window would read the null as "default profile" and strip an
 * agentdash_mk deep link to /decisions — so while the profile is
 * unresolved, callers render a skeleton and decide nothing.
 */
export function useResolvedProductProfile(): { resolving: boolean; isMk: boolean } {
  const { companies, selectedCompany, loading } = useCompany();
  const resolving = loading || (companies.length > 0 && !selectedCompany);
  return { resolving, isMk: selectedCompany?.productProfile === "agentdash_mk" };
}

export function InboxRootRedirect() {
  // AgentDash: UX-7 (GH #788) — the default profile's inbox is the Decisions
  // page; only agentdash_mk still has the tabbed inbox.
  const { resolving, isMk } = useResolvedProductProfile();
  if (resolving) return <PageSkeleton variant="inbox" />;
  if (isMk) {
    return <Navigate to={`/inbox/${loadLastInboxTab()}`} replace />;
  }
  return <Navigate to="/decisions" replace />;
}

/** Renders `mk` on the agentdash_mk profile and `fallback` everywhere else —
 *  the profile split UX-7/#788 needs, with no layout change on MK. While the
 *  profile is still resolving it renders a skeleton instead of guessing —
 *  guessing wrong on a cold deep link is the bug this component exists in. */
export function ProfileRouteSwitch({
  mk,
  fallback,
  skeleton,
}: {
  mk: ReactNode;
  fallback: ReactNode;
  skeleton?: ReactNode;
}) {
  const { resolving, isMk } = useResolvedProductProfile();
  if (resolving) return <>{skeleton ?? <PageSkeleton />}</>;
  if (isMk) return <>{mk}</>;
  return <>{fallback}</>;
}
