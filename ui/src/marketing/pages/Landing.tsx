import { useQuery } from "@tanstack/react-query";
import { Navigate, useSearchParams } from "@/lib/router";
import { authApi } from "../../api/auth";
import { queryKeys } from "../../lib/queryKeys";
import { healthApi } from "../../api/health";
import { MarketingShell } from "../MarketingShell";
import { Hero } from "../sections/Hero";
import { LayeredDescent } from "../sections/LayeredDescent";
import { CapabilitiesGrid } from "../sections/CapabilitiesGrid";
import { HowItWorks } from "../sections/HowItWorks";
import { ConsultingBand } from "../sections/ConsultingBand";
import { FinalCTA } from "../sections/FinalCTA";
import { SectionContainer } from "../components/SectionContainer";
import { LogoStrip } from "../components/LogoStrip";
import { QuoteBlock } from "../components/QuoteBlock";

const TRUST_MARKERS = [
  { name: "Goals" },
  { name: "Agents" },
  { name: "Budgets" },
  { name: "Approvals" },
  { name: "Audit trails" },
];

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
  const loggedIn = healthQuery.isSuccess && (!isAuthenticatedMode || Boolean(sessionQuery.data));
  if (!previewMode && loggedIn) return <Navigate to="/companies" replace />;

  return (
    <MarketingShell>
      <Hero />
      <SectionContainer spacing="compact">
        <LogoStrip items={TRUST_MARKERS} />
      </SectionContainer>
      <SectionContainer background="cream-2">
        <QuoteBlock
          quote="The winning companies won't hire one AI assistant. They'll run accountable AI teams with goals, budgets, audits, and humans in the loop."
          attribution="AgentDash launch thesis"
        />
      </SectionContainer>
      <LayeredDescent />
      <CapabilitiesGrid />
      <HowItWorks />
      <ConsultingBand />
      <FinalCTA />
    </MarketingShell>
  );
}
