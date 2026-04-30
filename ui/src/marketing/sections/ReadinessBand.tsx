import "./ReadinessBand.css";
import { SectionContainer } from "../components/SectionContainer";
import { Button } from "../components/Button";

export function ReadinessBand() {
  return (
    <SectionContainer>
      <div className="mkt-readiness">
        <div>
          <h2 className="mkt-display-section">Where does your company sit on the readiness curve?</h2>
          <p className="mkt-body-lg" style={{ color: "var(--mkt-ink-soft)", marginTop: 24 }}>
            We built a 20-minute structured intake for our own engagements. It produces a written readiness brief
            with the three pilots most likely to land in your first quarter.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <Button href="/assess">Run the assessment</Button>
        </div>
      </div>
    </SectionContainer>
  );
}
