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
  const rows = [
    { name: "Avery (CEO)",  status: "ok",   detail: "reviewing Q3 priorities" },
    { name: "Mira (CMO)",   status: "ATTN", detail: "needs your input on launch" },
    { name: "Theo (CTO)",   status: "ok",   detail: "shipping migrations" },
    { name: "Quinn (CFO)",  status: "ok",   detail: "closing April books" },
    { name: "Sam (Sales)",  status: "ok",   detail: "qualifying 12 leads" },
  ];
  return (
    <svg viewBox="0 0 420 320" fill="none" stroke="currentColor" strokeWidth="1.2" role="img" aria-label="Sample morning briefing">
      <text x="24" y="34" fontSize="15" fill="currentColor" fontFamily="var(--mkt-font-serif)">AgentDash · Morning briefing</text>
      <text x="396" y="34" textAnchor="end" fontSize="11" fill="currentColor" fontFamily="var(--mkt-font-mono)" opacity="0.6">TUE · APR 29</text>
      <line x1="24" y1="48" x2="396" y2="48" />
      {rows.map((row, i) => {
        const y = 78 + i * 34;
        const isHighlighted = row.status === "ATTN";
        return (
          <g key={row.name}>
            <circle cx="38" cy={y} r="9" />
            <text x="56" y={y + 4} fontSize="11" fontWeight="500" fill="currentColor">{row.name}</text>
            <rect
              x="170"
              y={y - 9}
              width="56"
              height="18"
              rx="9"
              fill={isHighlighted ? "var(--mkt-accent)" : "none"}
              stroke={isHighlighted ? "none" : "currentColor"}
            />
            <text
              x="198"
              y={y + 4}
              textAnchor="middle"
              fontSize="10"
              fontFamily="var(--mkt-font-mono)"
              fill={isHighlighted ? "#fff" : "currentColor"}
              stroke="none"
            >{row.status}</text>
            <text x="240" y={y + 4} fontSize="11" fill="currentColor" opacity="0.75">{row.detail}</text>
          </g>
        );
      })}
      <line x1="24" y1="266" x2="396" y2="266" />
      <text x="40"  y="290" fontSize="20" fill="currentColor" fontFamily="var(--mkt-font-serif)" fontWeight="500">$182</text>
      <text x="40"  y="306" fontSize="10" fill="currentColor" fontFamily="var(--mkt-font-mono)" opacity="0.6" letterSpacing="0.08em">SPEND TODAY</text>
      <text x="170" y="290" fontSize="20" fill="currentColor" fontFamily="var(--mkt-font-serif)" fontWeight="500">17</text>
      <text x="170" y="306" fontSize="10" fill="currentColor" fontFamily="var(--mkt-font-mono)" opacity="0.6" letterSpacing="0.08em">TASKS DONE</text>
      <text x="290" y="290" fontSize="20" fill="currentColor" fontFamily="var(--mkt-font-serif)" fontWeight="500">3</text>
      <text x="290" y="306" fontSize="10" fill="currentColor" fontFamily="var(--mkt-font-mono)" opacity="0.6" letterSpacing="0.08em">FLAGGED</text>
    </svg>
  );
}
