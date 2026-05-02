export function TrustSafetyDiagram() {
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* ledger */}
      <rect x="80" y="100" width="160" height="80" rx="4" />
      {[120, 140, 160].map((y) => (
        <line key={y} x1="92" y1={y} x2="228" y2={y} />
      ))}
      {/* shield */}
      <path
        d="M160 20 L200 35 L200 70 Q200 95 160 110 Q120 95 120 70 L120 35 Z"
        fill="var(--mkt-accent)"
        stroke="none"
      />
      <path d="M148 65 L158 75 L175 55" stroke="#fff" strokeWidth="2.5" fill="none" />
    </svg>
  );
}
