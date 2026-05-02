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

const PLACEHOLDER_LOGOS = [
  { name: "Logo 1" },
  { name: "Logo 2" },
  { name: "Logo 3" },
  { name: "Logo 4" },
  { name: "Logo 5" },
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
  const loggedIn = !isAuthenticatedMode || Boolean(sessionQuery.data);
  if (!previewMode && loggedIn) return <Navigate to="/companies" replace />;

  return (
    <MarketingShell>
      <Hero />
      <SectionContainer>
        <LogoStrip items={PLACEHOLDER_LOGOS} />
      </SectionContainer>
      <SectionContainer background="cream-2">
        <QuoteBlock
          quote="The first week our agents shipped, we caught up on six months of backlog. By month two, the board stopped asking how we'd staff the new initiative."
          attribution="— Placeholder: replace with a real operator quote"
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
