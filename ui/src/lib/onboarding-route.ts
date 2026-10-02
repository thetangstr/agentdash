// AgentDash (one onboarding path): every install starts a workspace the same
// way, hosted or self-hosted: name it at /company-create, then the first run
// at /setup, then the Chief of Staff at /cos. The six-step wizard stays at
// /onboarding for deep links only; nothing routes a new user there.
export const FIRST_COMPANY_PATH = "/company-create";
/**
 * "New Company" from inside the app. `another=1` tells /company-create the
 * person already has a workspace and means to make a second one, so it does
 * not apply the post-signup guard that sends an existing member to /cos.
 */
export const NEW_COMPANY_PATH = "/company-create?another=1";

type OnboardingRouteCompany = {
  id: string;
  issuePrefix: string;
};

export function isOnboardingPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 1) {
    return segments[0]?.toLowerCase() === "onboarding";
  }

  if (segments.length === 2) {
    return segments[1]?.toLowerCase() === "onboarding";
  }

  return false;
}

export function resolveRouteOnboardingOptions(params: {
  pathname: string;
  companyPrefix?: string;
  companies: OnboardingRouteCompany[];
}): { initialStep: 1 | 2; companyId?: string } | null {
  const { pathname, companyPrefix, companies } = params;

  if (!isOnboardingPath(pathname)) return null;

  if (!companyPrefix) {
    return { initialStep: 1 };
  }

  const matchedCompany =
    companies.find(
      (company) =>
        company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
    ) ?? null;

  if (!matchedCompany) {
    return { initialStep: 1 };
  }

  return { initialStep: 2, companyId: matchedCompany.id };
}

/**
 * A signed-in person with no workspace, on a board path, is sent to name one
 * (FIRST_COMPANY_PATH). A deep link to /onboarding is left alone.
 */
export function shouldRedirectCompanylessRouteToOnboarding(params: {
  pathname: string;
  hasCompanies: boolean;
}): boolean {
  return !params.hasCompanies && !isOnboardingPath(params.pathname);
}
