import "./EngagementCards.css";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

export function EngagementCards() {
  return (
    <SectionContainer background="cream-2">
      <Eyebrow>Engagement</Eyebrow>
      <h2 className="mkt-display-section" style={{ marginTop: 16, marginBottom: 48 }}>
        Two ways to work with us.
      </h2>
      <div className="mkt-eng">
        <div className="mkt-eng-card">
          <div className="mkt-eng-card__name">Pilot</div>
          <div className="mkt-eng-card__body">4–6 weeks, fixed scope, fixed price. Goal: prove the workforce shipping real work in production.</div>
        </div>
        <div className="mkt-eng-card">
          <div className="mkt-eng-card__name">Production</div>
          <div className="mkt-eng-card__body">Quarterly retainer, expanding scope, embedded with your team. Goal: build the operating muscle to run agents long-term.</div>
        </div>
      </div>
    </SectionContainer>
  );
}
