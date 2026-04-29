import "./HowItWorks.css";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

const STEPS = [
  { n: "01", title: "Create the company",       body: "Define the goal. AgentDash sets up the org, the budget, and the audit log." },
  { n: "02", title: "Hire the CEO and team",     body: "Pick adapters, define reporting lines, set the heartbeat. We provide sensible defaults." },
  { n: "03", title: "Watch the morning briefing",body: "Every day starts with a one-screen view of what your AI workforce did and what needs you." },
];

export function HowItWorks() {
  return (
    <SectionContainer background="cream-2">
      <Eyebrow>How it works</Eyebrow>
      <h2 className="mkt-display-section" style={{ marginTop: 16, marginBottom: 64 }}>
        Three steps to a running AI company.
      </h2>
      <div className="mkt-how-grid">
        {STEPS.map((s) => (
          <div key={s.n}>
            <div className="mkt-how-step__num">{s.n}</div>
            <div className="mkt-how-step__title">{s.title}</div>
            <div className="mkt-how-step__body">{s.body}</div>
          </div>
        ))}
      </div>
    </SectionContainer>
  );
}
