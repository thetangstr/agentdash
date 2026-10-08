import { Navigate, useLocation, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { FIRST_COMPANY_PATH, shouldRedirectCompanylessRouteToOnboarding } from "@/lib/onboarding-route";
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
      return <Navigate to={FIRST_COMPANY_PATH} replace />;
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
  // AgentDash (one onboarding path): "New Company" names the workspace at
  // /company-create, then /setup and the Chief of Staff, the same as a first
  // run anywhere. The six-step wizard is not an entry point any more.
  const navigate = useNavigate();

  // AgentDash: public first-run examples must not describe an existing customer.
  const brief = `Help me describe my organization, the people responsible for its work,
and the first outcome we want to achieve. Set up a Chief of Staff and propose
agents with clear responsibilities based on the needs I provide.

Ask for human approval before deleting data or sending any external message.
Agents should draft proposals for review and cite a source for every reported
number. If information is missing, ask me rather than inventing it.`;

  return <FirstRunStart onCreateManually={() => navigate(FIRST_COMPANY_PATH)} companyBrief={brief} />;
}
