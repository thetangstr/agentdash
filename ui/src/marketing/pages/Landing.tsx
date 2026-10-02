import { useQuery } from "@tanstack/react-query";
import { Navigate, useSearchParams } from "@/lib/router";
import { authApi } from "../../api/auth";
import { queryKeys } from "../../lib/queryKeys";
import { healthApi } from "../../api/health";
import { MarketingShell } from "../MarketingShell";
import { BOX_SIGN_IN_PATH, isInstallHealth } from "../WwwOnlyRoute";
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
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  if (!previewMode && (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading))) return null;
  // AgentDash: unknown health (an error, a 410, non-JSON) means "not a box and
  // not signed in" here, so www's / renders the landing instead of bouncing
  // to /companies. Only a real health answer can make the visitor logged in.
  const loggedIn = isInstallHealth(healthQuery.data) && (!isAuthenticatedMode || Boolean(sessionQuery.data));
  if (!previewMode && loggedIn) return <Navigate to="/companies" replace />;
  // AgentDash: an install is not the marketing site. A hosted box's signed-out
  // root goes to the box's own sign-in, not a landing page whose "Sign in" is
  // www's /find (#949). Scan 2 (E4) generalises that from "a hosted box" to
  // "not www": a self-hosted install's root showed "Start free" and "Hosted
  // workspaces are opening…" to its own users. www's /api/health answers 410
  // (or fails), so www never gets here and keeps rendering the landing.
  if (!previewMode && isInstallHealth(healthQuery.data)) return <Navigate to={BOX_SIGN_IN_PATH} replace />;

  return <LandingContent />;
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
