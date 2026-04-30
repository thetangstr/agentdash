import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { AboutMission } from "../sections/AboutMission";
import { AboutFounder } from "../sections/AboutFounder";

export function About() {
  return (
    <MarketingShell>
      <SectionContainer>
        <Eyebrow>About</Eyebrow>
        <h1 className="mkt-display-page" style={{ marginTop: 16 }}>Why AgentDash exists.</h1>
      </SectionContainer>
      <AboutMission />
      <AboutFounder />
      <SectionContainer>
        <p style={{ textAlign: "center", color: "var(--mkt-ink-soft)" }}>
          Press, partnerships, careers — <a href="mailto:hello@agentdash.com">hello@agentdash.com</a>
        </p>
      </SectionContainer>
    </MarketingShell>
  );
}
