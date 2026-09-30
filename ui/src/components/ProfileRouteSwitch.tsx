import { useCompany } from "../context/CompanyContext";

/**
 * AgentDash: one UX (doc/plans/2026-09-30-one-ux.md) — the ProfileRouteSwitch
 * component and InboxRootRedirect are gone: routes no longer branch on the
 * product profile. Only this hook remains, because pages/Home.tsx still reads
 * it until the merged landing page (one-UX 2/3) replaces the Home/Overview
 * split. Delete this file then; it is on scripts/ci/profile-ux-allowlist.json
 * until it is. Do not add new callers.
 *
 * @deprecated profile-driven UX is being removed; see the plan above.
 */
export function useResolvedProductProfile(): { resolving: boolean; isMk: boolean } {
  const { companies, selectedCompany, loading } = useCompany();
  const resolving = loading || (companies.length > 0 && !selectedCompany);
  return { resolving, isMk: selectedCompany?.productProfile === "agentdash_mk" };
}
