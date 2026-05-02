import "./AgentDashLogo.css";

// AgentDash brand mark: monogram 'a' (hexagonal silhouette with chamfered
// top-right corner) wrapping a counter-space NE arrow. The hexagon
// references a dashboard tile; the arrow communicates forward motion +
// the lowercase 'a' counter. Teal primary per CLAUDE.md.
//
// Variants:
//   • <AgentDashLogo />                 → full lockup (mark + wordmark)
//   • <AgentDashLogo variant="mark" />  → mark only (favicon, app chrome)
//   • <AgentDashLogo size="sm|md|lg" /> → coordinated sizing
//
// The mark itself is colour-agnostic: pass `tone="dark"` when rendering on
// a dark surface (e.g. dashboard chrome) — the arrow's knockout flips to
// stay readable. Default tone is "light" (cream-knockout arrow on teal).

type Tone = "light" | "dark";
type Variant = "lockup" | "mark";
type Size = "sm" | "md" | "lg";

export interface AgentDashLogoProps {
  variant?: Variant;
  size?: Size;
  tone?: Tone;
  className?: string;
  /** Override the wordmark text colour (defaults to ink). */
  wordmarkColor?: string;
}

const SIZE_PX: Record<Size, { mark: number; gap: number; word: number }> = {
  sm: { mark: 22, gap: 8,  word: 16 },
  md: { mark: 32, gap: 10, word: 22 },
  lg: { mark: 44, gap: 14, word: 30 },
};

export function AgentDashLogo({
  variant = "lockup",
  size = "md",
  tone = "light",
  className,
  wordmarkColor,
}: AgentDashLogoProps) {
  const sizing = SIZE_PX[size];
  const cls = ["mkt-logo", `mkt-logo--${size}`, className].filter(Boolean).join(" ");

  return (
    <span className={cls} aria-label="AgentDash">
      <AgentDashMark size={sizing.mark} tone={tone} />
      {variant === "lockup" ? (
        <span
          className="mkt-logo__wordmark"
          style={{
            fontSize: sizing.word,
            marginLeft: sizing.gap,
            color: wordmarkColor,
          }}
        >
          AgentDash
        </span>
      ) : null}
    </span>
  );
}

function AgentDashMark({ size, tone }: { size: number; tone: Tone }) {
  // The mark sits in a 64x64 viewBox. The outer path is the chamfered
  // hexagonal 'a' silhouette. The inner two strokes draw a NE arrow as
  // counter-space (cream on teal) — same geometry as Lucide ArrowUpRight,
  // scaled and recentred so the visual weight balances inside the hex.
  const fill = tone === "dark" ? "var(--mkt-surface-cream, #faf9f5)" : "#0d9488";
  const arrow = tone === "dark" ? "#0d9488" : "var(--mkt-surface-cream, #faf9f5)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-hidden="true"
      className="mkt-logo__mark"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Outer 'a' hexagon — rounded rect with a chamfered top-right corner */}
      <path
        d="M14 4 H42 L60 22 V50 A10 10 0 0 1 50 60 H14 A10 10 0 0 1 4 50 V14 A10 10 0 0 1 14 4 Z"
        fill={fill}
      />
      {/* NE arrow counter — drawn with rounded strokes for crispness at small sizes */}
      <g
        stroke={arrow}
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        {/* Diagonal shaft, SW → NE */}
        <line x1="22" y1="42" x2="42" y2="22" />
        {/* Arrowhead corner: top edge, then right edge */}
        <polyline points="26,22 42,22 42,38" />
      </g>
    </svg>
  );
}
