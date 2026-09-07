import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

const MISSION =
  "AgentDash exists so that any company can run an AI workforce with the same clarity, accountability, and safety it expects from its human teams.";

export function AboutMission() {
  return (
    <SectionContainer>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>Our mission</Eyebrow>
      </div>
      <p className="mkt-mission">{MISSION}</p>
    </SectionContainer>
  );
}
