import "./ConsultingBand.css";
import { SectionContainer } from "../components/SectionContainer";
import { Button } from "../components/Button";

export function ConsultingBand() {
  return (
    <SectionContainer background="cream-2">
      <div className="mkt-cb">
        <div className="mkt-cb__copy">
          <h2 className="mkt-display-section">Want this installed for you?</h2>
          <p className="mkt-body-lg" style={{ color: "var(--mkt-ink-soft)" }}>
            Our consulting practice deploys AgentDash inside enterprises — diagnose
            the highest-impact pain points, design the agent org, ship the first
            workforce in production, and stay through the first quarter of
            operation.
          </p>
          <div>
            <Button href="/consulting" variant="ghost">Talk to our consulting team</Button>
          </div>
        </div>
        <div className="mkt-cb__art" aria-hidden>
          <OrgChartSvg />
        </div>
      </div>
    </SectionContainer>
  );
}

function OrgChartSvg() {
  return (
    <svg viewBox="0 0 360 280" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* CEO node, coral */}
      <rect x="150" y="20" width="60" height="36" rx="6" fill="var(--mkt-accent)" stroke="none" />
      <text x="180" y="42" textAnchor="middle" fontSize="12" fill="#fff">CEO</text>
      {/* execs */}
      <line x1="180" y1="56" x2="180" y2="80" />
      <line x1="80" y1="80" x2="280" y2="80" />
      <line x1="80" y1="80" x2="80" y2="100" />
      <line x1="180" y1="80" x2="180" y2="100" />
      <line x1="280" y1="80" x2="280" y2="100" />
      {[
        { x: 60, label: "CTO" },
        { x: 160, label: "CMO" },
        { x: 260, label: "CFO" },
      ].map((n) => (
        <g key={n.label}>
          <rect x={n.x} y="100" width="40" height="28" rx="4" />
          <text x={n.x + 20} y="118" textAnchor="middle" fontSize="11" fill="currentColor">{n.label}</text>
        </g>
      ))}
      {/* reports */}
      {[60, 160, 260].map((x) => (
        <g key={x}>
          <line x1={x + 20} y1="128" x2={x + 20} y2="160" />
          <line x1={x - 8} y1="160" x2={x + 48} y2="160" />
          <line x1={x - 8} y1="160" x2={x - 8} y2="180" />
          <line x1={x + 48} y1="160" x2={x + 48} y2="180" />
          <rect x={x - 24} y="180" width="32" height="22" rx="3" />
          <rect x={x + 32} y="180" width="32" height="22" rx="3" />
        </g>
      ))}
    </svg>
  );
}
