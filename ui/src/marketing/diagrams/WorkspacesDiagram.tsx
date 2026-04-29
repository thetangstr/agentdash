export function WorkspacesDiagram() {
  const labels = ["Claude", "Codex", "Cursor", "Gemini", "Pi", "OpenCode", "OpenClaw"];
  const cols = 4;
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {labels.map((label, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = 20 + col * 75;
        const y = 40 + row * 60;
        const isHighlighted = i === 0;
        return (
          <g key={label}>
            <rect
              x={x}
              y={y}
              width="64"
              height="40"
              rx="6"
              fill={isHighlighted ? "var(--mkt-accent)" : "none"}
              stroke={isHighlighted ? "none" : "currentColor"}
            />
            <text
              x={x + 32}
              y={y + 24}
              textAnchor="middle"
              fontSize="11"
              fill={isHighlighted ? "#fff" : "currentColor"}
              stroke="none"
              fontFamily="var(--mkt-font-sans)"
            >{label}</text>
          </g>
        );
      })}
    </svg>
  );
}
