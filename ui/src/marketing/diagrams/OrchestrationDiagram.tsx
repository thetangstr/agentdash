export function OrchestrationDiagram() {
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* nodes */}
      {[
        { x: 40, y: 40 },
        { x: 160, y: 30 },
        { x: 280, y: 50 },
        { x: 100, y: 110 },
        { x: 220, y: 120 },
        { x: 160, y: 170 },
      ].map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r="10" fill="var(--mkt-surface-cream)" />
      ))}
      {/* normal edges */}
      <line x1="40" y1="40" x2="100" y2="110" />
      <line x1="280" y1="50" x2="220" y2="120" />
      <line x1="160" y1="30" x2="220" y2="120" />
      <line x1="100" y1="110" x2="160" y2="170" />
      {/* highlighted edges (coral) */}
      <line x1="160" y1="30" x2="100" y2="110" stroke="var(--mkt-accent)" strokeWidth="2" />
      <line x1="100" y1="110" x2="220" y2="120" stroke="var(--mkt-accent)" strokeWidth="2" />
      <line x1="220" y1="120" x2="160" y2="170" stroke="var(--mkt-accent)" strokeWidth="2" />
    </svg>
  );
}
