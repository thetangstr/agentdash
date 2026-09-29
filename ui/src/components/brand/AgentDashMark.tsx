// AgentDash: the one definition of the AgentDash brand mark. The marketing
// lockup (ui/src/marketing/components/AgentDashLogo.tsx), the app chrome
// (CompanyRail) and the auth/claim pages all render this component, and
// ui/public/favicon.svg plus the raster icons are generated from the same
// geometry (scripts/brand/generate-icons.mjs). Change the paths here and in
// that script together.
//
// Geometry: a 64x64 viewBox. The outer path is the chamfered hexagonal 'a'
// silhouette (teal #0d9488). The inner strokes draw a NE arrow as
// counter-space (cream #faf9f5) in rounded 6px strokes, same shape as Lucide
// ArrowUpRight, scaled and recentred so the weight balances inside the hex.
//
// The teal tile with the cream arrow reads on both light and dark surfaces,
// so "light" is right for the app in either theme. `tone="dark"` inverts it
// (cream tile, teal arrow) for places that want a knockout.

export type AgentDashMarkTone = "light" | "dark";

export const AGENTDASH_TEAL = "#0d9488";
export const AGENTDASH_CREAM = "#faf9f5";

export const AGENTDASH_MARK_TILE_PATH =
  "M14 4 H42 L60 22 V50 A10 10 0 0 1 50 60 H14 A10 10 0 0 1 4 50 V14 A10 10 0 0 1 14 4 Z";

export interface AgentDashMarkProps {
  size?: number;
  tone?: AgentDashMarkTone;
  className?: string;
  /** Accessible name. Omit when the mark sits next to the visible word "AgentDash". */
  title?: string;
}

export function AgentDashMark({ size = 24, tone = "light", className, title }: AgentDashMarkProps) {
  // The cream reads the marketing token when present so the marketing site
  // keeps its exact surface colour; everywhere else it falls back to #faf9f5.
  const cream = `var(--mkt-surface-cream, ${AGENTDASH_CREAM})`;
  const fill = tone === "dark" ? cream : AGENTDASH_TEAL;
  const arrow = tone === "dark" ? AGENTDASH_TEAL : cream;
  const labelled = Boolean(title);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      aria-label={labelled ? title : undefined}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      data-testid="agentdash-mark"
    >
      {labelled ? <title>{title}</title> : null}
      <path d={AGENTDASH_MARK_TILE_PATH} fill={fill} />
      <g stroke={arrow} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {/* Diagonal shaft, SW to NE */}
        <line x1="22" y1="42" x2="42" y2="22" />
        {/* Arrowhead corner: top edge, then right edge */}
        <polyline points="26,22 42,22 42,38" />
      </g>
    </svg>
  );
}
