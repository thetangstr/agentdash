import "./ResearchBriefs.css";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

const BRIEFS = [
  { tag: "FRAMEWORK", title: "The seven layers of the enterprise agent stack",
    abstract: "A taxonomy for what's in scope when you say 'agentify the enterprise.'" },
  { tag: "SYNTHESIS", title: "Why agent pilots stall in month two",
    abstract: "Patterns across the dozen pilots we've watched go quiet between week six and week ten." },
  { tag: "INDUSTRY", title: "Cross-industry agentification — what actually moved",
    abstract: "Where measurable productivity shifted, where it didn't, and what predicts which side you land on." },
  { tag: "FRAMEWORK", title: "Readiness signals we look for in the first call",
    abstract: "The five questions we ask in the first thirty minutes that decide whether a pilot is worth running." },
];

export function ResearchBriefs() {
  return (
    <SectionContainer background="cream-2" id="research">
      <Eyebrow>Research</Eyebrow>
      <h2 className="mkt-display-section" style={{ marginTop: 16, marginBottom: 64 }}>
        What we've learned mapping the agent factory landscape.
      </h2>
      <div className="mkt-briefs">
        {BRIEFS.map((b) => (
          <a key={b.title} href="#" className="mkt-brief">
            <div className="mkt-brief__tag">{b.tag}</div>
            <div className="mkt-brief__title">{b.title}</div>
            <div className="mkt-brief__abstract">{b.abstract}</div>
            <div className="mkt-brief__cta">Read brief →</div>
          </a>
        ))}
      </div>
    </SectionContainer>
  );
}
