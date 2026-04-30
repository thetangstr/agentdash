import "./FinalCTA.css";
import { SectionContainer } from "../components/SectionContainer";
import { Button } from "../components/Button";

export function FinalCTA() {
  return (
    <SectionContainer>
      <div className="mkt-final">
        <h2 className="mkt-display-section">Start running your AI company.</h2>
        <div className="mkt-final__cta-row">
          <Button href="/auth?mode=sign_up">Start free</Button>
          <Button href="mailto:consulting@agentdash.com" variant="ghost">Talk to sales</Button>
        </div>
      </div>
    </SectionContainer>
  );
}
