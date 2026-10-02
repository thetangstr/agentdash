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

/**
 * The company prefix of a "/:prefix/onboarding" path, read from the path
 * itself. The wizard is mounted at the App root, outside the :companyPrefix
 * route, so useParams() never sees the prefix there; reading it from params
 * is what left a direct load of /WAN/onboarding on "Name your company".
 */
export function onboardingPathCompanyPrefix(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 2 && segments[1]?.toLowerCase() === "onboarding") {
    return segments[0];
  }
  return undefined;
}

/**
 * What the route-driven wizard opens on.
 *
 * AgentDash (Scan 3, lane J): the wizard never creates a second company for
 * someone who already has one. When the person has any company, it opens on
 * the agent step for the prefixed company, or else the selected one (or the
 * first). Making another company is the explicit New Company action
 * (NEW_COMPANY_PATH), not something the wizard falls into.
 */
export function resolveRouteOnboardingOptions(params: {
  pathname: string;
  companyPrefix?: string;
  companies: OnboardingRouteCompany[];
  selectedCompanyId?: string | null;
}): { initialStep: 1 | 2; companyId?: string } | null {
  const { pathname, companies, selectedCompanyId } = params;

  if (!isOnboardingPath(pathname)) return null;

  const companyPrefix = params.companyPrefix ?? onboardingPathCompanyPrefix(pathname);

  const matchedCompany = companyPrefix
    ? companies.find(
        (company) =>
          company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
      ) ?? null
    : null;

  const company =
    matchedCompany ??
    companies.find((entry) => entry.id === selectedCompanyId) ??
    companies[0] ??
    null;

  if (!company) {
    return { initialStep: 1 };
  }

  return { initialStep: 2, companyId: company.id };
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
