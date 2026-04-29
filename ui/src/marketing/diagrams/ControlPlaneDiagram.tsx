export function ControlPlaneDiagram() {
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* board node */}
      <rect x="120" y="20" width="80" height="32" rx="4" fill="var(--mkt-accent)" stroke="none" />
      <text x="160" y="40" textAnchor="middle" fontSize="12" fill="#fff" fontFamily="var(--mkt-font-mono)">BOARD</text>
      {/* CEO */}
      <line x1="160" y1="52" x2="160" y2="80" />
      <rect x="130" y="80" width="60" height="28" rx="4" />
      <text x="160" y="98" textAnchor="middle" fontSize="11" fill="currentColor">CEO</text>
      {/* execs */}
      <line x1="160" y1="108" x2="160" y2="130" />
      <line x1="80" y1="130" x2="240" y2="130" />
      <line x1="80" y1="130" x2="80" y2="148" />
      <line x1="160" y1="130" x2="160" y2="148" />
      <line x1="240" y1="130" x2="240" y2="148" />
      <rect x="55" y="148" width="50" height="24" rx="4" />
      <rect x="135" y="148" width="50" height="24" rx="4" />
      <rect x="215" y="148" width="50" height="24" rx="4" />
    </svg>
  );
}
