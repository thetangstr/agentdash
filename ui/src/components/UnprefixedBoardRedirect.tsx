import { Navigate, useLocation } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { shouldRedirectCompanylessRouteToOnboarding } from "@/lib/onboarding-route";
import { FirstRunStart } from "@/components/FirstRunStart";

/**
 * A board path typed or linked without its company prefix — `/guides`,
 * `/my-agent` — lands here and is sent to the same path under the selected
 * company: `/guides/x` → `/<prefix>/guides/x`, search and hash intact.
 *
 * Lifted out of App.tsx so a route test can mount the real thing beside the
 * real pages, rather than a copy of it.
 */
export function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

export function NoCompaniesStartPage() {
  const { openOnboarding } = useDialogActions();

  // MKThink is the first customer, so their brief is the default prose. Any
  // other instance still gets a working prompt — just a generic description.
  const brief = `MKThink is a strategy, design and innovation consultancy. We help
organizations solve complex problems.

I want a Chief of Staff for myself, plus three agents each belonging to one of my
leads: Delivery (live client project status and commitments at risk), Platform
(our SharePoint estate and code repositories), and People (recruiting pipeline
and who is waiting on us).

Set up three goals with tasks under them:
  1. Monthly board pack, assembled without a fire drill — the Chief assembles it
     and the other three each contribute their part, attributed.
  2. SharePoint and repository cleanup — inventory what is stale, then a deletion
     proposal a human approves. An agent must NEVER delete anything itself.
  3. Recruiting pipeline that never silently stalls — weekly review of who is
     waiting on us and which roles block delivery.

No agent may contact a client or a candidate directly; they draft and a human
sends. No agent reports a number it cannot source.`;

  return <FirstRunStart onCreateManually={() => openOnboarding()} companyBrief={brief} />;
}
