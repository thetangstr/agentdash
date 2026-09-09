import "./FinalCTA.css";
import { SectionContainer } from "../components/SectionContainer";
import { Button } from "../components/Button";
import { CTA, READINESS_LINE } from "../content/site";

export function FinalCTA() {
  return (
    <SectionContainer>
      <div className="mkt-final">
        <h2 className="mkt-display-section">See it on your own work.</h2>
        <p className="mkt-final__sub">
          Bring one thing you would hand a Chief of Staff. We'll walk through how
          AgentDash would run it, what would wait on you, and what it would cost.
        </p>
        <div className="mkt-final__cta-row">
          <Button href={CTA.walkthrough.href}>{CTA.walkthrough.label}</Button>
          <Button href={CTA.selfHost.href} variant="ghost">{CTA.selfHost.label}</Button>
        </div>
        <p className="mkt-final__note">{READINESS_LINE}</p>
      </div>
    </SectionContainer>
  );
}
