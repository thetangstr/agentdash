import "./DemoSection.css";
import { Eyebrow } from "../components/Eyebrow";
import { SectionContainer } from "../components/SectionContainer";
import { StewardDemo } from "../demo/StewardDemo";

export function DemoSection() {
  return (
    <SectionContainer id="demo">
      <div className="mkt-demo-section__intro">
        <div>
          <Eyebrow>Interactive demo</Eyebrow>
          <h2 className="mkt-display-section">Run the workflow yourself.</h2>
        </div>
        <p>
          Pick a request, send it to your Chief of Staff from a terminal, watch the
          team split the work, and decide the one thing that needs a human. Scripted,
          so you can see the whole loop in about a minute.
        </p>
      </div>
      <StewardDemo />
      <p className="mkt-demo-section__more">
        Want the full-width version with notes on what is real behind each step? <a href="/demo">Open the demo page</a>.
      </p>
    </SectionContainer>
  );
}
