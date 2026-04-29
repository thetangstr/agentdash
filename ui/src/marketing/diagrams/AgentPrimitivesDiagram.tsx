export function AgentPrimitivesDiagram() {
  const subs = ["IDENTITY", "MEMORY", "HEARTBEAT", "TOOLS"];
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* main agent block */}
      <rect x="20" y="80" width="80" height="40" rx="6" fill="var(--mkt-accent)" stroke="none" />
      <text x="60" y="104" textAnchor="middle" fontSize="11" fill="#fff" fontFamily="var(--mkt-font-mono)">AGENT</text>
      {/* connecting lines */}
      {subs.map((_, i) => (
        <line key={i} x1="100" y1={100} x2="180" y2={30 + i * 47} />
      ))}
      {/* sub-blocks */}
      {subs.map((label, i) => (
        <g key={label}>
          <rect x="180" y={20 + i * 47} width="100" height="30" rx="5" />
          <text x="230" y={39 + i * 47} textAnchor="middle" fontSize="10" fill="currentColor" fontFamily="var(--mkt-font-mono)">{label}</text>
        </g>
      ))}
    </svg>
  );
}
