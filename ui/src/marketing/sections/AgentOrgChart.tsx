import { useEffect, useMemo, useState } from "react";
import "./AgentOrgChart.css";

type Agent = {
  name: string;
  role: string;
  x: number;
  y: number;
  pulseDelay: number;
  status: "working" | "idle";
};

const HUB = { x: 210, y: 140 };

const AGENTS: Agent[] = [
  { name: "Avery", role: "CEO",   x: 70,  y: 70,  pulseDelay: 0,   status: "working" },
  { name: "Mira",  role: "CMO",   x: 350, y: 70,  pulseDelay: 0.6, status: "working" },
  { name: "Theo",  role: "CTO",   x: 380, y: 165, pulseDelay: 1.2, status: "working" },
  { name: "Quinn", role: "CFO",   x: 320, y: 235, pulseDelay: 1.8, status: "idle"    },
  { name: "Sam",   role: "Sales", x: 110, y: 235, pulseDelay: 2.4, status: "working" },
];

const HIRE_SLOT = { x: 40, y: 165 };

const CANDIDATES = [
  { name: "Riley", role: "Engineer" },
  { name: "Mae",   role: "Recruiter" },
  { name: "Devon", role: "Researcher" },
  { name: "Iris",  role: "Designer" },
];

export function AgentOrgChart() {
  const [tick, setTick] = useState(0);
  const [tasksDone, setTasksDone] = useState(17);
  const [spend, setSpend] = useState(182);
  const [hireIndex, setHireIndex] = useState(0);

  useEffect(() => {
    const counter = setInterval(() => {
      setTick((t) => t + 1);
      setTasksDone((t) => t + 1);
      setSpend((s) => s + 4 + Math.floor(Math.random() * 7));
    }, 3400);
    return () => clearInterval(counter);
  }, []);

  useEffect(() => {
    const cycle = setInterval(() => {
      setHireIndex((i) => (i + 1) % CANDIDATES.length);
    }, 6200);
    return () => clearInterval(cycle);
  }, []);

  const candidate = CANDIDATES[hireIndex]!;
  const formattedSpend = useMemo(() => `$${spend.toLocaleString()}`, [spend]);

  return (
    <svg
      viewBox="0 0 420 320"
      role="img"
      aria-label="Animated AgentDash org chart with five named AI agents and a rotating new-hire slot"
      className="mkt-org"
      fill="none"
    >
      <defs>
        <radialGradient id="mkt-org-hub-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--mkt-accent)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--mkt-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* connection edges from hub to each agent */}
      {AGENTS.map((agent) => (
        <line
          key={`edge-${agent.name}`}
          x1={HUB.x}
          y1={HUB.y}
          x2={agent.x}
          y2={agent.y}
          className="mkt-org__edge"
        />
      ))}

      {/* dashed edge to the new-hire slot */}
      <line
        x1={HUB.x}
        y1={HUB.y}
        x2={HIRE_SLOT.x}
        y2={HIRE_SLOT.y}
        className="mkt-org__edge mkt-org__edge--dashed"
      />

      {/* coral work-pulses traveling each edge, staggered */}
      {AGENTS.map((agent) => (
        <circle
          key={`pulse-${agent.name}`}
          r="3"
          className="mkt-org__pulse"
        >
          <animateMotion
            dur="3.4s"
            begin={`${agent.pulseDelay}s`}
            repeatCount="indefinite"
            path={`M${agent.x} ${agent.y} L${HUB.x} ${HUB.y}`}
            keyPoints="0;1"
            keyTimes="0;1"
            calcMode="linear"
          />
        </circle>
      ))}

      {/* central hub: glow + ring + label */}
      <circle cx={HUB.x} cy={HUB.y} r="46" fill="url(#mkt-org-hub-glow)" />
      <circle cx={HUB.x} cy={HUB.y} r="34" className="mkt-org__hub-ring" />
      <circle cx={HUB.x} cy={HUB.y} r="34" className="mkt-org__hub-pulse" />
      <text x={HUB.x} y={HUB.y - 4} textAnchor="middle" className="mkt-org__hub-label">
        AgentDash
      </text>
      <text x={HUB.x} y={HUB.y + 10} textAnchor="middle" className="mkt-org__hub-sublabel">
        control plane
      </text>

      {/* five established agent nodes */}
      {AGENTS.map((agent) => (
        <g key={`node-${agent.name}`} className="mkt-org__node">
          <circle cx={agent.x} cy={agent.y} r="16" className="mkt-org__node-bg" />
          <circle cx={agent.x} cy={agent.y} r="16" className="mkt-org__node-ring" />
          <text x={agent.x} y={agent.y - 24} textAnchor="middle" className="mkt-org__node-name">
            {agent.name}
          </text>
          <text x={agent.x} y={agent.y + 32} textAnchor="middle" className="mkt-org__node-role">
            {agent.role}
          </text>
          <circle
            cx={agent.x + 14}
            cy={agent.y - 12}
            r="3.2"
            className={`mkt-org__status mkt-org__status--${agent.status}`}
          />
        </g>
      ))}

      {/* rotating new-hire slot — re-keyed per candidate so the fade animation re-runs */}
      <g key={`hire-${hireIndex}`} className="mkt-org__hire">
        <circle cx={HIRE_SLOT.x} cy={HIRE_SLOT.y} r="16" className="mkt-org__node-bg" />
        <circle cx={HIRE_SLOT.x} cy={HIRE_SLOT.y} r="16" className="mkt-org__node-ring mkt-org__node-ring--new" />
        <text x={HIRE_SLOT.x} y={HIRE_SLOT.y - 24} textAnchor="middle" className="mkt-org__node-name">
          {candidate.name}
        </text>
        <text x={HIRE_SLOT.x} y={HIRE_SLOT.y + 32} textAnchor="middle" className="mkt-org__node-role">
          {candidate.role}
        </text>
        <g className="mkt-org__hire-badge">
          <rect x={HIRE_SLOT.x - 22} y={HIRE_SLOT.y + 38} width="44" height="14" rx="7" />
          <text x={HIRE_SLOT.x} y={HIRE_SLOT.y + 48} textAnchor="middle" className="mkt-org__hire-badge-label">
            HIRED
          </text>
        </g>
      </g>

      {/* footer rule + ticking counters */}
      <line x1="20" y1="278" x2="400" y2="278" className="mkt-org__edge" />
      <g key={`stats-${tick}`} className="mkt-org__stats">
        <text x="40" y="298" className="mkt-org__stat-num">{formattedSpend}</text>
        <text x="40" y="312" className="mkt-org__stat-label">SPEND TODAY</text>
        <text x="170" y="298" className="mkt-org__stat-num">{tasksDone}</text>
        <text x="170" y="312" className="mkt-org__stat-label">TASKS DONE</text>
        <text x="300" y="298" className="mkt-org__stat-num">3</text>
        <text x="300" y="312" className="mkt-org__stat-label">FLAGGED</text>
      </g>
    </svg>
  );
}
