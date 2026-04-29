import "./CapabilitiesGrid.css";
import { Factory, GitBranch, ShieldAlert, BookOpen, ScrollText, Boxes } from "lucide-react";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

const TILES = [
  { Icon: Factory,     title: "Agent Factory",      body: "Spawn from templates, scale up or down." },
  { Icon: GitBranch,   title: "Task Dependencies",  body: "Hierarchical work that traces to the goal." },
  { Icon: ShieldAlert, title: "Budget Hard-Stops",  body: "Spend caps you can defend in a board meeting." },
  { Icon: BookOpen,    title: "Skills Registry",    body: "Teach an agent once, reuse everywhere." },
  { Icon: ScrollText,  title: "Activity Audit",     body: "Every action, every decision, fully logged." },
  { Icon: Boxes,       title: "Multi-Adapter",      body: "Claude, Codex, Cursor, Gemini, Pi, OpenCode, OpenClaw." },
];

export function CapabilitiesGrid() {
  return (
    <SectionContainer>
      <Eyebrow>What's in the box</Eyebrow>
      <h2 className="mkt-display-section" style={{ marginTop: 16, marginBottom: 64 }}>
        Built for the work agents actually do.
      </h2>
      <div className="mkt-cap-grid">
        {TILES.map(({ Icon, title, body }) => (
          <div className="mkt-cap-tile" key={title}>
            <Icon className="mkt-cap-tile__icon" size={24} strokeWidth={1.5} />
            <div className="mkt-cap-tile__title">{title}</div>
            <div className="mkt-cap-tile__body">{body}</div>
          </div>
        ))}
      </div>
    </SectionContainer>
  );
}
