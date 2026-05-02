import { useEffect, useState } from "react";
import { Bot, User } from "lucide-react";
import "./LiveBriefing.css";

// Editorial "Live Briefing" hero illustration. Replaces the prior animated
// org-chart. Single restrained motion (one coral indicator sliding to the
// active row every ~7s) + a barely-perceptible live dot. Everything else
// is composed typography — serif names, mono labels, italic activity copy.
//
// The component is presentational. The data is intentionally fixed so the
// surface reads as a real product card, not a demo loop.

type BriefRow = {
  name: string;
  role: string;
  kind: "human" | "agent";
  activity: string;
  time: string;
};

// One human (the founder, reviewing the day) + four AI agents executing
// against the company's goals. Communicates the hybrid-team narrative
// AgentDash sells: humans set direction, agents do the work. Avatars
// differentiate the two (User icon for humans, Bot icon for agents).
const ROWS: BriefRow[] = [
  { name: "Avery", role: "CEO",   kind: "human", activity: "Reviewing Q3 priorities",            time: "9:42 AM" },
  { name: "Mira",  role: "CMO",   kind: "agent", activity: "Drafting the launch announcement",   time: "9:38 AM" },
  { name: "Theo",  role: "CTO",   kind: "agent", activity: "Shipping migration 0067",            time: "9:31 AM" },
  { name: "Quinn", role: "CFO",   kind: "agent", activity: "Closing the April books",            time: "9:18 AM" },
  { name: "Sam",   role: "Sales", kind: "agent", activity: "Qualifying 12 inbound leads",        time: "8:56 AM" },
];

const STEP_MS = 7000;

export function LiveBriefing() {
  const [activeRow, setActiveRow] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      setActiveRow((i) => (i + 1) % ROWS.length);
    }, STEP_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <article className="mkt-brief" aria-label="Live AgentDash briefing">
      <header className="mkt-brief__header">
        <span className="mkt-brief__live">
          <span className="mkt-brief__live-dot" aria-hidden />
          Live · Tue 29 Apr
        </span>
        <h2 className="mkt-brief__title">Morning briefing</h2>
        <p className="mkt-brief__subtitle">Five agents on shift. One needs your input.</p>
      </header>

      <div className="mkt-brief__rule" />

      <ol className="mkt-brief__list">
        {ROWS.map((row, i) => (
          <li
            key={row.name}
            className={`mkt-brief__row${i === activeRow ? " is-active" : ""}`}
            aria-current={i === activeRow ? "true" : undefined}
          >
            <span className="mkt-brief__indicator" aria-hidden />
            <span
              className={`mkt-brief__avatar mkt-brief__avatar--${row.kind}`}
              aria-hidden
            >
              {row.kind === "agent" ? (
                <Bot size={16} strokeWidth={1.5} />
              ) : (
                <User size={16} strokeWidth={1.5} />
              )}
            </span>
            <div className="mkt-brief__body">
              <div className="mkt-brief__identity">
                <span className="mkt-brief__name">{row.name}</span>
                <span className="mkt-brief__sep" aria-hidden>·</span>
                <span className="mkt-brief__role">{row.role}</span>
                <span
                  className={`mkt-brief__kind mkt-brief__kind--${row.kind}`}
                  aria-label={row.kind === "agent" ? "AI agent" : "Human"}
                >
                  {row.kind === "agent" ? "Agent" : "Human"}
                </span>
              </div>
              <p className="mkt-brief__activity">{row.activity}</p>
            </div>
            <time className="mkt-brief__time" dateTime="09:42">{row.time}</time>
          </li>
        ))}
      </ol>

      <div className="mkt-brief__rule" />

      <footer className="mkt-brief__footer">
        <span className="mkt-brief__footer-label">Today</span>
        <span className="mkt-brief__metric">
          <strong>17</strong>
          <span className="mkt-brief__metric-label">tasks</span>
        </span>
        <span className="mkt-brief__metric">
          <strong>$182</strong>
          <span className="mkt-brief__metric-label">spent</span>
        </span>
        <span className="mkt-brief__metric">
          <strong>3</strong>
          <span className="mkt-brief__metric-label">flagged</span>
        </span>
      </footer>
    </article>
  );
}
