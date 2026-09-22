import { useQuery } from "@tanstack/react-query";
import { Navigate, useSearchParams } from "@/lib/router";
import { authApi } from "../../api/auth";
import { queryKeys } from "../../lib/queryKeys";
import { healthApi } from "../../api/health";
import { MarketingShell } from "../MarketingShell";
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
  const loggedIn = !isAuthenticatedMode || Boolean(sessionQuery.data);
  if (!previewMode && loggedIn) return <Navigate to="/companies" replace />;

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
