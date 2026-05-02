import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { ConsultingPhases } from "../sections/ConsultingPhases";
import { ResearchBriefs } from "../sections/ResearchBriefs";
import { ReadinessBand } from "../sections/ReadinessBand";
import { EngagementCards } from "../sections/EngagementCards";

export function Consulting() {
  return (
    <MarketingShell>
      <SectionContainer>
        <Eyebrow>Consulting practice</Eyebrow>
        <h1 className="mkt-display-page" style={{ marginTop: 16, marginBottom: 32, maxWidth: "18ch" }}>
          We install AI workforces inside enterprises.
        </h1>
        <div style={{ display: "grid", gap: 24, maxWidth: "60ch", color: "var(--mkt-ink-soft)" }}>
          <p className="mkt-body-lg">
            Most enterprise AI pilots stall after the demo. The slideware is excellent.
            The integration is a slog. The first six months disappear.
          </p>
          <p className="mkt-body-lg">
            We run a structured deployment, not a slideware engagement. We sit with
            your team, ship agents into production within the first quarter, and stay
            through the first quarter of operation so the workforce becomes
            something the team owns — not a project we have to babysit.
          </p>
        </div>
      </SectionContainer>
      <ConsultingPhases />
      <ResearchBriefs />
      <ReadinessBand />
      <EngagementCards />
      <SectionContainer>
        <h2 className="mkt-display-section" style={{ textAlign: "center" }}>Tell us what you're trying to build.</h2>
        <p style={{ textAlign: "center", marginTop: 24 }}>
          <a href="mailto:consulting@agentdash.com">consulting@agentdash.com</a>
        </p>
      </SectionContainer>
    </MarketingShell>
  );
}
