import "./AgentDashLogo.css";
import { AgentDashMark, type AgentDashMarkTone } from "../../components/brand/AgentDashMark";

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
//
// The mark geometry lives in ui/src/components/brand/AgentDashMark.tsx so the
// app chrome, favicons and this lockup share one definition.

type Tone = AgentDashMarkTone;
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
      <AgentDashMark size={sizing.mark} tone={tone} className="mkt-logo__mark" />
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
