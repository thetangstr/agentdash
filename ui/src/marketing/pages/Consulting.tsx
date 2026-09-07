import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { ConsultingPhases } from "../sections/ConsultingPhases";
import { ReadinessBand } from "../sections/ReadinessBand";
import { EngagementCards } from "../sections/EngagementCards";
import { CONTACT_EMAIL, CTA } from "../content/site";
import { Button } from "../components/Button";
import { useDocumentMeta } from "../hooks/useDocumentMeta";

export function Consulting() {
  useDocumentMeta(
    "AgentDash consulting",
    "We install stewarded AI workforces inside companies: diagnose, design, deploy, operate.",
  );
  return (
    <MarketingShell>
      <SectionContainer>
        <Eyebrow>Consulting practice</Eyebrow>
        <h1 className="mkt-display-page" style={{ marginTop: 16, marginBottom: 32, maxWidth: "18ch" }}>
          We install AI workforces inside companies.
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
            something the team owns, not a project we have to babysit.
          </p>
        </div>
      </SectionContainer>
      <ConsultingPhases />
      <ReadinessBand />
      <EngagementCards />
      <SectionContainer>
        <div style={{ textAlign: "center", display: "grid", gap: 24, justifyItems: "center" }}>
          <h2 className="mkt-display-section">Tell us what you're trying to build.</h2>
          <Button href={CTA.walkthrough.href}>{CTA.walkthrough.label}</Button>
          <p style={{ margin: 0, color: "var(--mkt-ink-soft)" }}>
            or write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
        </div>
      </SectionContainer>
    </MarketingShell>
  );
}
