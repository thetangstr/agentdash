import "./Demo.css";
import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { Button } from "../components/Button";
import { StewardDemo } from "../demo/StewardDemo";
import { CTA, STEWARD_TOOLS } from "../content/site";
import { useDocumentMeta } from "../hooks/useDocumentMeta";

const BEHIND: Array<{ step: string; real: string; simulated: string }> = [
  {
    step: "Sending a request from the terminal",
    real: `The AgentDash MCP server exposes ${STEWARD_TOOLS.propose}, which works out what an instruction means and reads it back without changing anything, and ${STEWARD_TOOLS.confirm}, which carries it out once you say yes. The handle is spent by that one call.`,
    simulated: "The terminal on this page is a mock. It does not run Claude Code or Codex, and no MCP call leaves your browser.",
  },
  {
    step: "The Chief of Staff delegating",
    real: "Agents create issues, assign them, comment, and @-mention each other on a shared board. Autonomous agents run on routines and post into the same company. All of it lands in the activity log.",
    simulated: "The company, the agents, the numbers and the timing are scripted. Real agents take minutes, not seconds, and their answers come from your data.",
  },
  {
    step: "The approval",
    real: `Approvals are bound to a revision: one decision applies to one proposed version. Stewards read what needs a decision with ${STEWARD_TOOLS.sync} and decide with ${STEWARD_TOOLS.decide}. Policies such as "agents draft, a human sends" are written into each agent's instructions.`,
    simulated: "Both branches here are pre-written. In a real instance the agent's follow-up depends on what you actually decided and why.",
  },
  {
    step: "The result",
    real: "Deliverables are issue documents with revisions, attributed to the agents that wrote them and the humans who steward those agents.",
    simulated: "The board update shown is fiction. Nothing is written to any instance when you use this page.",
  },
];

export function Demo() {
  useDocumentMeta(
    "AgentDash demo · Direct a Chief of Staff agent from your terminal",
    "A simulated walkthrough of the AgentDash steward workflow: send a request from Claude Code or Codex, watch agents delegate, decide on a guardrail, get an attributed result.",
  );
  return (
    <MarketingShell>
      <SectionContainer>
        <div className="mkt-demo-page__head">
          <Eyebrow>Interactive demo</Eyebrow>
          <h1 className="mkt-display-page">Direct a Chief of Staff agent from your terminal.</h1>
          <p className="mkt-body-lg">
            Pick a request, send it, watch the team work, and decide the one thing that
            needs a human. This is a scripted walkthrough of a fictional company.
            It does not run live agents and does not touch any real instance.
          </p>
        </div>
        <StewardDemo />
      </SectionContainer>
      <SectionContainer background="cream-2">
        <div className="mkt-demo-page__behind-intro">
          <Eyebrow>What is real behind each step</Eyebrow>
          <h2 className="mkt-display-section">Where the demo stops and the product starts.</h2>
        </div>
        <dl className="mkt-behind">
          {BEHIND.map((b) => (
            <div key={b.step} className="mkt-behind__row">
              <dt>{b.step}</dt>
              <dd>
                <div className="mkt-behind__cell"><span className="mkt-behind__tag is-real">Real</span><p>{b.real}</p></div>
                <div className="mkt-behind__cell"><span className="mkt-behind__tag is-sim">Simulated here</span><p>{b.simulated}</p></div>
              </dd>
            </div>
          ))}
        </dl>
      </SectionContainer>
      <SectionContainer>
        <div className="mkt-demo-page__cta">
          <h2 className="mkt-display-section">Want it on your work instead of Halden's?</h2>
          <div className="mkt-demo-page__cta-row">
            <Button href={CTA.walkthrough.href}>{CTA.walkthrough.label}</Button>
            <Button href="/mcp" variant="ghost">See the MCP setup</Button>
          </div>
        </div>
      </SectionContainer>
    </MarketingShell>
  );
}
