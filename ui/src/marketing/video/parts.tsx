import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { V } from "./theme";

/** Eases a value from 0→1 over [start, start+len] frames with a soft spring. */
export function useRise(start: number, len = 18) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = spring({ frame: frame - start, fps, config: { damping: 200, stiffness: 120 }, durationInFrames: len });
  return frame < start ? 0 : t;
}

export function Rise({ start, len, children, style }: { start: number; len?: number; children: ReactNode; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const t = useRise(start, len);
  // Nothing is laid out before its cue, so lists grow as items arrive instead
  // of showing holes where later items will land.
  if (frame < start) return null;
  return (
    <div style={{ opacity: t, transform: `translateY(${(1 - t) * 14}px)`, ...style }}>
      {children}
    </div>
  );
}

export function Typewriter({ text, start, cps = 28, style }: { text: string; start: number; cps?: number; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chars = Math.max(0, Math.floor(((frame - start) / fps) * cps));
  const shown = text.slice(0, chars);
  const cursorOn = chars < text.length && Math.floor(frame / 8) % 2 === 0;
  if (frame < start) return null;
  return (
    <span style={style}>
      {shown}
      {cursorOn ? <span style={{ opacity: 0.8 }}>▍</span> : null}
    </span>
  );
}

export function Stage({ children, background = V.cream }: { children: ReactNode; background?: string }) {
  return (
    <AbsoluteFill style={{ background, fontFamily: V.sans, color: V.ink }}>
      {children}
    </AbsoluteFill>
  );
}

export function Caption({ eyebrow, title, start = 0, align = "left" }: { eyebrow: string; title: string; start?: number; align?: "left" | "center" }) {
  const t = useRise(start, 20);
  return (
    <div style={{ opacity: t, transform: `translateY(${(1 - t) * 12}px)`, textAlign: align }}>
      <div style={{ fontFamily: V.mono, fontSize: 15, letterSpacing: "0.12em", textTransform: "uppercase", color: V.inkSoft }}>
        {eyebrow}
      </div>
      <div style={{ fontFamily: V.serif, fontSize: 50, lineHeight: 1.08, marginTop: 10, letterSpacing: "-0.01em" }}>
        {title}
      </div>
    </div>
  );
}

export function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: V.card,
        border: `1px solid ${V.rule}`,
        borderRadius: 16,
        boxShadow: "0 24px 60px -24px rgba(31,30,29,0.28)",
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function TerminalFrame({ title, children, style }: { title: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: V.termBg,
        color: V.termFg,
        borderRadius: 16,
        boxShadow: "0 24px 60px -24px rgba(31,30,29,0.5)",
        overflow: "hidden",
        fontFamily: V.mono,
        fontSize: 17,
        lineHeight: 1.6,
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: V.termBg2, borderBottom: `1px solid ${V.termRule}` }}>
        <span style={{ display: "inline-flex", gap: 6 }}>
          {[0, 1, 2].map((i) => <i key={i} style={{ width: 11, height: 11, borderRadius: 999, background: "#4a453e", display: "block" }} />)}
        </span>
        <span style={{ color: V.termDim, fontSize: 13 }}>{title}</span>
      </div>
      <div style={{ padding: "18px 20px", display: "grid", alignContent: "start", gap: 10, flex: 1 }}>{children}</div>
    </div>
  );
}

/** A typed prompt row: the glyph appears with the first character, not before. */
export function PromptLine({ text, start, cps }: { text: string; start: number; cps?: number }) {
  const frame = useCurrentFrame();
  if (frame < start) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 12 }}>
      <span style={{ color: V.termAccent, textAlign: "center" }}>&gt;</span>
      <Typewriter text={text} start={start} cps={cps} />
    </div>
  );
}

export function TermLine({ glyph, color, children, start }: { glyph: string; color: string; children: ReactNode; start: number }) {
  const frame = useCurrentFrame();
  if (frame < start) return null;
  const o = interpolate(frame - start, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  return (
    <div style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 12, opacity: o }}>
      <span style={{ color: V.termDim, textAlign: "center" }}>{glyph}</span>
      <span style={{ color }}>{children}</span>
    </div>
  );
}

export function Tag({ children, tone = "accent" }: { children: ReactNode; tone?: "accent" | "teal" | "ink" | "success" }) {
  const colors = {
    accent: { bg: V.accentTint, fg: V.accentInk },
    teal: { bg: V.tealTint, fg: V.teal },
    ink: { bg: V.cream2, fg: V.inkSoft },
    success: { bg: "#e2efe7", fg: V.success },
  }[tone];
  return (
    <span style={{ fontFamily: V.mono, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", background: colors.bg, color: colors.fg, borderRadius: 999, padding: "4px 10px" }}>
      {children}
    </span>
  );
}

export function SimulatedBadge() {
  return (
    <div style={{ position: "absolute", top: 20, right: 24, display: "flex", alignItems: "center", gap: 8 }}>
      <Tag tone="ink">Simulated</Tag>
    </div>
  );
}

export function Progress() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const w = interpolate(frame, [0, durationInFrames], [0, 100], { extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 4, background: "rgba(31,30,29,0.08)" }}>
      <div style={{ width: `${w}%`, height: "100%", background: V.accent }} />
    </div>
  );
}
