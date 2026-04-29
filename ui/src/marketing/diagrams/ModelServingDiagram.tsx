export function ModelServingDiagram() {
  const models = ["Anthropic", "OpenAI", "Your own"];
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* boundary line — what's above is AgentDash, below is the model layer */}
      <line x1="20" y1="60" x2="300" y2="60" strokeDasharray="4 4" />
      <text x="20" y="50" fontSize="10" fill="currentColor" fontFamily="var(--mkt-font-mono)">— AGENTDASH —</text>
      <text x="20" y="80" fontSize="10" fill="currentColor" fontFamily="var(--mkt-font-mono)">YOUR INFERENCE LAYER</text>
      {models.map((label, i) => {
        const x = 30 + i * 95;
        const isHighlighted = i === 2;
        return (
          <g key={label}>
            <rect x={x} y={110} width="80" height="50" rx="6" fill={isHighlighted ? "var(--mkt-accent)" : "none"} stroke={isHighlighted ? "none" : "currentColor"} />
            <text x={x + 40} y={140} textAnchor="middle" fontSize="11" fill={isHighlighted ? "#fff" : "currentColor"}>{label}</text>
          </g>
        );
      })}
    </svg>
  );
}
