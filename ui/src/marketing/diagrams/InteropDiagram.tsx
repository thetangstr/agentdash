export function InteropDiagram() {
  const chips = [
    { label: "HubSpot", angle: 0 },
    { label: "Slack", angle: 90 },
    { label: "Email", angle: 180 },
    { label: "Webhook", angle: 270 },
  ];
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="160" cy="100" r="30" fill="var(--mkt-accent)" stroke="none" />
      <text x="160" y="104" textAnchor="middle" fontSize="11" fill="#fff" fontFamily="var(--mkt-font-mono)">CORE</text>
      <circle cx="160" cy="100" r="60" />
      <circle cx="160" cy="100" r="80" strokeDasharray="2 4" />
      {chips.map((chip) => {
        const rad = (chip.angle * Math.PI) / 180;
        const x = 160 + Math.cos(rad) * 80;
        const y = 100 + Math.sin(rad) * 80;
        return (
          <g key={chip.label}>
            <rect x={x - 30} y={y - 12} width="60" height="24" rx="4" fill="var(--mkt-surface-cream)" />
            <text x={x} y={y + 4} textAnchor="middle" fontSize="10" fill="currentColor">{chip.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
