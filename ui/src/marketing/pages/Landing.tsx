import { useQuery } from "@tanstack/react-query";
import { Navigate, useSearchParams } from "@/lib/router";
import { authApi } from "../../api/auth";
import { queryKeys } from "../../lib/queryKeys";
import { healthApi } from "../../api/health";
import { useCompany } from "../../context/CompanyContext";
import { MarketingShell } from "../MarketingShell";
import { BOX_SIGN_IN_PATH } from "../WwwOnlyRoute";
import { isMarketingHost } from "../marketing-host";
import { Hero } from "../sections/Hero";
import { StoryBeats } from "../sections/StoryBeats";
import { DemoSection } from "../sections/DemoSection";
import { Capabilities } from "../sections/Capabilities";
import { HowYouGetIt } from "../sections/HowYouGetIt";
import { ConsultingBand } from "../sections/ConsultingBand";
import { FinalCTA } from "../sections/FinalCTA";
import { useDocumentMeta } from "../hooks/useDocumentMeta";

export function Landing() {
  const [searchParams] = useSearchParams();
  // ?preview=1 skips the logged-in redirect so the marketing landing is
  // viewable locally even in local_trusted mode (where the user is implicitly
  // logged in and would otherwise be sent straight to /companies).
  const previewMode = searchParams.get("preview") === "1";
  // AgentDash (scan 2, E4, PR #955 review): the marketing site is decided by
  // hostname, never by health — www's /api/health is rewritten to the legacy
  // Railway install and answers with an install's health. On a marketing host
  // `/` always renders the landing and asks the API nothing.
  const marketingHost = isMarketingHost();
  const gate = !previewMode && !marketingHost;
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    enabled: gate,
  });
  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: gate && isAuthenticatedMode,
    retry: false,
  });

  if (!gate) return <LandingContent />;
  if (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading)) return null;
  // Every other host is an install (a hosted box, a self-hosted server, dev),
  // and an install is not the marketing site. Signed in, `/` is the app.
  const loggedIn = Boolean(healthQuery.data) && (!isAuthenticatedMode || Boolean(sessionQuery.data));
  if (loggedIn) return <SignedInRedirect />;
  // Signed out, it is the install's own sign-in — not a landing page whose
  // "Sign in" is www's /find (#949 for boxes), and not "Start free" / "Hosted
  // workspaces are opening…" shown to a self-hosted install's own users (E4).
  return <Navigate to={BOX_SIGN_IN_PATH} replace />;
}

/**
 * Where a signed-in person lands when they arrive at `/` (which is where
 * sign-in sends them when no `next` was given).
 *
 * AgentDash (Scan 3, lane J): someone with exactly one company goes straight
 * to its Chief of Staff (`/:prefix/cos`). A bare Companies list with a single
 * card was a dead stop between signing in and doing anything. People with
 * several companies, or none yet, still get the Companies page, which lists
 * them or sends a company-less person on to create one.
 */
export function SignedInRedirect() {
  const { companies, loading } = useCompany();
  if (loading) return null;
  const active = companies.filter((company) => company.status !== "archived");
  if (active.length === 1) {
    return <Navigate to={`/${active[0]!.issuePrefix}/cos`} replace />;
  }
  return <Navigate to="/companies" replace />;
}

/**
 * The page itself, separated so tests can render it without the auth gate.
 * The title is set here rather than in Landing: while the gate is resolving,
 * Landing renders nothing, so BreadcrumbProvider's mount effect sees no
 * `.mkt-root` and resets the title to "AgentDash" after the hook ran.
 */
export function LandingContent() {
  useDocumentMeta(
    "AgentDash · A Chief of Staff agent that answers to you",
    "Hire a Chief of Staff agent stewarded by you, direct it from Claude Code or Codex, and let it work with the rest of your agent workforce. Self-hosted and open source.",
  );
  return (
    <MarketingShell>
      <Hero />
      <StoryBeats />
      <DemoSection />
      <Capabilities />
      <HowYouGetIt />
      <ConsultingBand />
      <FinalCTA />
    </MarketingShell>
  );
}
