import "./ConsultingPhases.css";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

const PHASES = [
  { n: "01", name: "Diagnose",   window: "2 weeks",   outcome: "Process map · pain ledger · readiness signal",
    body: "We sit with the team for two weeks. We map what actually happens day-to-day, document the points where work stalls, and produce a readiness signal that says where agents will land first." },
  { n: "02", name: "Design",     window: "2 weeks",   outcome: "Org chart · task hierarchy · guardrails",
    body: "We design the agent org chart, the task hierarchy that traces to a real business goal, and the guardrails — budget caps, approval gates, and the kill switch." },
  { n: "03", name: "Deploy",     window: "4 weeks",   outcome: "Agents in production · board oversight wired",
    body: "We ship the first agents into production. Real work. Real cost. Board oversight is wired in from day one — every action is logged and reviewable." },
  { n: "04", name: "Operate",    window: "Ongoing",   outcome: "Weekly review · scope expansion · handoff",
    body: "We run weekly reviews with the team that owns the workforce, expand scope as confidence builds, and eventually hand the keys back." },
];

export function ConsultingPhases() {
  return (
    <SectionContainer>
      <Eyebrow>How we work</Eyebrow>
      <h2 className="mkt-display-section" style={{ marginTop: 16, marginBottom: 64 }}>
        Four phases, not features.
      </h2>
      <div className="mkt-phases">
        {PHASES.map((p) => (
          <div key={p.n} className="mkt-phase">
            <div className="mkt-phase__num">{p.n}</div>
            <div>
              <h3 className="mkt-phase__name">{p.name}</h3>
              <p className="mkt-phase__body">{p.body}</p>
              <div className="mkt-phase__meta">
                <span>{p.window}</span>
                <span>{p.outcome}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </SectionContainer>
  );
}
