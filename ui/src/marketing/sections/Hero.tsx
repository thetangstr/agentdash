import "./Hero.css";
import { Eyebrow } from "../components/Eyebrow";
import { Button } from "../components/Button";
import { SectionContainer } from "../components/SectionContainer";

export function Hero() {
  return (
    <SectionContainer>
      <div className="mkt-hero">
        <div className="mkt-hero__copy">
          <Eyebrow>The control plane for your AI company</Eyebrow>
          <h1 className="mkt-display-hero">
            Run an AI workforce the way you'd run a company.
          </h1>
          <p className="mkt-body-lg">
            Goals, agents, budgets, and audit trails — in one control plane your
            board would actually approve of.
          </p>
          <div className="mkt-hero__cta-row">
            <Button href="/auth?mode=sign_up">Start free</Button>
            <Button href="#layered-descent" variant="ghost">See the architecture</Button>
          </div>
          <p className="mkt-hero__reassure">No credit card · Free single-seat tier</p>
        </div>
        <div className="mkt-hero__art" aria-hidden>
          <BriefingCardSvg />
        </div>
      </div>
    </SectionContainer>
  );
}

function BriefingCardSvg() {
  return (
    <svg viewBox="0 0 360 280" fill="none" stroke="currentColor" strokeWidth="1.2" role="img" aria-label="Sample morning briefing">
      <text x="20" y="32" fontSize="14" fill="currentColor" fontFamily="var(--mkt-font-serif)">AgentDash · Morning briefing</text>
      <line x1="20" y1="44" x2="340" y2="44" />
      {[0, 1, 2, 3, 4].map((i) => {
        const y = 70 + i * 36;
        const isHighlighted = i === 1;
        return (
          <g key={i}>
            <circle cx="34" cy={y} r="10" />
            <text x="56" y={y + 4} fontSize="11" fill="currentColor">Agent {i + 1}</text>
            <rect
              x="160"
              y={y - 10}
              width="60"
              height="20"
              rx="10"
              fill={isHighlighted ? "var(--mkt-accent)" : "none"}
              stroke={isHighlighted ? "none" : "currentColor"}
            />
            <text
              x="190"
              y={y + 4}
              textAnchor="middle"
              fontSize="10"
              fill={isHighlighted ? "#fff" : "currentColor"}
            >{isHighlighted ? "ATTN" : "ok"}</text>
            <text x="240" y={y + 4} fontSize="11" fill="currentColor">working: drafting Q3 report…</text>
          </g>
        );
      })}
      <line x1="20" y1="252" x2="340" y2="252" />
      <text x="40" y="272" fontSize="11" fill="currentColor" fontFamily="var(--mkt-font-mono)">$182</text>
      <text x="40" y="278" fontSize="9" fill="currentColor">today</text>
      <text x="160" y="272" fontSize="11" fill="currentColor" fontFamily="var(--mkt-font-mono)">17</text>
      <text x="160" y="278" fontSize="9" fill="currentColor">tasks done</text>
      <text x="280" y="272" fontSize="11" fill="currentColor" fontFamily="var(--mkt-font-mono)">3</text>
      <text x="280" y="278" fontSize="9" fill="currentColor">flagged</text>
    </svg>
  );
}
