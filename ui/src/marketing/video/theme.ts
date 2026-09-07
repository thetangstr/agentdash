/**
 * Visual constants for the Remotion hero story. Mirrors tokens.css so the
 * video reads as part of the page; inline values because the composition is
 * also renderable outside the DOM cascade.
 */
export const V = {
  fps: 30,
  width: 1280,
  height: 720,
  cream: "#faf9f5",
  cream2: "#f3efe6",
  card: "#ffffff",
  ink: "#1f1e1d",
  inkSoft: "#54524f",
  inkFaint: "#8a8578",
  rule: "#e8e3d6",
  accent: "#cc785c",
  accentInk: "#7a3f2a",
  accentTint: "#f7e6df",
  teal: "#0d9488",
  tealTint: "#dff3f0",
  success: "#4d8a6a",
  warn: "#c99237",
  termBg: "#1c1a17",
  termBg2: "#26231f",
  termFg: "#ece7dc",
  termDim: "#9a9284",
  termAccent: "#e8a08a",
  termTeal: "#5fd0c2",
  termRule: "#3a3630",
  serif: "'Newsreader', 'Times New Roman', serif",
  sans: "'Inter Tight', 'Inter', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

/** Scene boundaries in frames (30fps). Total 1260 frames = 42s. */
export const SCENES = {
  hire: { from: 0, duration: 210 },
  direct: { from: 210, duration: 300 },
  delegate: { from: 510, duration: 360 },
  decide: { from: 870, duration: 240 },
  result: { from: 1110, duration: 150 },
} as const;

export const TOTAL_FRAMES = 1260;
