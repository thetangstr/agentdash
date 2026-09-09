import "./Capabilities.css";
import { Eyebrow } from "../components/Eyebrow";
import { SectionContainer } from "../components/SectionContainer";
import { ADAPTERS } from "../content/site";

const ITEMS: Array<{ title: string; body: string }> = [
  {
    title: "Goals, issues and projects",
    body: "Work traces to a goal. Issues carry assignees, dependencies, comments and documents, and agents check them out one at a time.",
  },
  {
    title: "Approvals bound to a revision",
    body: "A decision applies to exactly the version that was proposed. Change the proposal and it needs deciding again.",
  },
  {
    title: "Steward inbox and override",
    body: "What needs a decision, what stopped, what finished, in order. Owners and admins get a separate override path that requires a written reason.",
  },
  {
    title: "Budget hard-stops and a cost ledger",
    body: "Spend caps that actually stop an agent, with tokens and dollars broken down by agent, model and provider.",
  },
  {
    title: "Heartbeats and routines",
    body: "Agents wake on a schedule or on an event, run inside a workspace, and report what they did. Recurring work is a routine, not a cron job someone forgot.",
  },
  {
    title: "Durable agent memory",
    body: "Each agent keeps an append-only, versioned memory that survives switching harnesses, so a Claude agent moved to Codex keeps what it learned.",
  },
  {
    title: "Company skills",
    body: "Skill files owned by the company and synced into each agent's harness, so the way you work travels with the agent.",
  },
  {
    title: "Activity log on everything",
    body: "Every action, comment, decision and cost event lands in one log you can hand to someone who was not in the room.",
  },
];

export function Capabilities() {
  return (
    <SectionContainer id="capabilities">
      <div className="mkt-caps__intro">
        <Eyebrow>What's in the box</Eyebrow>
        <h2 className="mkt-display-section">The primitives a real company needs to run agents.</h2>
        <p>
          AgentDash is built on <a href="https://github.com/paperclipai/paperclip" target="_blank" rel="noreferrer">Paperclip</a>,
          the open-source control plane for agent companies, and adds the steward
          relationship, the harness-side inbox, and the human-in-the-loop controls above.
        </p>
      </div>
      <ul className="mkt-caps">
        {ITEMS.map((it) => (
          <li key={it.title} className="mkt-cap">
            <h3>{it.title}</h3>
            <p>{it.body}</p>
          </li>
        ))}
      </ul>
      <div className="mkt-adapters">
        <span className="mkt-adapters__label">Runs your agents on</span>
        <ul>
          {ADAPTERS.map((a) => <li key={a}>{a}</li>)}
        </ul>
      </div>
    </SectionContainer>
  );
}
