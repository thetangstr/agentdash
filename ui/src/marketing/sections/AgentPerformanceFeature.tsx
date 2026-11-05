import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import "../pages/AgentPerformance.css";
export function AgentPerformanceFeature() {
  return <SectionContainer background="cream-2"><div className="mkt-performance-feature"><div><Eyebrow>New · Better evidence</Eyebrow><h2 className="mkt-display-section">Evaluate the agent,<br />not just the activity.</h2></div><div><p className="mkt-body-lg">Connect approved responsibilities to the work an agent owes, the evidence it produces, and the results you accept. Task acceptance is one input; costs, use and later outcomes stay separate.</p><a href="/agent-performance">Explore agent performance <span aria-hidden>↗</span></a></div></div></SectionContainer>;
}
