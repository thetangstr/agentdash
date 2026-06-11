// AgentDash: avatar treatment (b) — game-creator energy (emoji-free).
// Equipped slots fill as solid "plates" with a soft drop-shadow, and a
// restrained capability aura intensifies with coverage. Power-up feel comes
// from timing + shadow, not neon or RPG armor.
import { useId } from "react";
import { getAgentIcon } from "../../../lib/agent-icons";
import type { AgentAvatarProps } from "./AgentAvatar";
import {
  AVATAR_VIEWBOX,
  RISK_TOKEN,
  getSlot,
  itemsBySlot,
  slotRisk,
} from "./avatar-geometry";

export function AvatarPlayful({
  iconName,
  colorToken = "var(--accent-500)",
  name,
  equipped,
  securityOn = false,
  coverage = 0,
  dndOverSlot = null,
  size = 220,
}: AgentAvatarProps) {
  const HeadIcon = getAgentIcon(iconName);
  const bySlot = itemsBySlot(equipped);
  const head = getSlot("head");
  const { w, h } = AVATAR_VIEWBOX;
  const height = (size * h) / w;
  const uid = useId().replace(/:/g, "");
  const auraId = `aura-${uid}`;
  const shadowId = `plate-shadow-${uid}`;
  const auraOpacity = coverage > 60 ? 0.5 : coverage > 30 ? 0.34 : coverage > 0 ? 0.2 : 0;

  return (
    <svg
      width={size}
      height={height}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`${name || "Agent"} avatar with ${equipped.length} equipped capabilities`}
      style={{ display: "block" }}
    >
      <defs>
        <radialGradient id={auraId} cx="50%" cy="42%" r="55%">
          <stop offset="0%" stopColor={colorToken} stopOpacity={0.45} />
          <stop offset="100%" stopColor={colorToken} stopOpacity={0} />
        </radialGradient>
        <filter id={shadowId} x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="2" floodColor="#1F1B16" floodOpacity="0.18" />
        </filter>
      </defs>

      {/* capability aura */}
      <ellipse
        cx={w / 2}
        cy={h * 0.45}
        rx={w * 0.46}
        ry={h * 0.4}
        fill={`url(#${auraId})`}
        opacity={auraOpacity}
        style={{ transition: "opacity 260ms ease" }}
      />

      {/* spine */}
      <line
        x1={head.cx}
        y1={head.cy}
        x2={head.cx}
        y2={getSlot("shield").cy}
        stroke="var(--border-strong)"
        strokeWidth={1.5}
      />

      {/* head plate */}
      <circle
        cx={head.cx}
        cy={head.cy}
        r={head.r}
        fill="var(--surface-raised)"
        stroke={colorToken}
        strokeWidth={2}
        filter={`url(#${shadowId})`}
      />
      <g transform={`translate(${head.cx - 14} ${head.cy - 14})`}>
        <HeadIcon width={28} height={28} color={colorToken} strokeWidth={2} />
      </g>

      {/* body core */}
      {(() => {
        const body = getSlot("body");
        const risk = slotRisk(bySlot.body);
        const filled = bySlot.body.length > 0;
        return (
          <circle
            cx={body.cx}
            cy={body.cy}
            r={body.r}
            fill={filled ? RISK_TOKEN[risk] : "var(--surface-sunken)"}
            fillOpacity={filled ? 0.9 : 1}
            stroke={filled ? RISK_TOKEN[risk] : "var(--border-strong)"}
            strokeWidth={filled ? 2 : 1.25}
            filter={filled ? `url(#${shadowId})` : undefined}
            style={{ transition: "all 200ms cubic-bezier(0.34, 1.4, 0.64, 1)" }}
          />
        );
      })()}

      {/* peripheral plates */}
      {(["tools", "environment"] as const).map((id) => {
        const slot = getSlot(id);
        const items = bySlot[id];
        const filled = items.length > 0;
        const risk = slotRisk(items);
        const isOver = dndOverSlot === id;
        return (
          <g key={id} aria-label={`${slot.label}${filled ? `: ${items.map((i) => i.label).join(", ")}` : " (empty)"}`}>
            <circle
              cx={slot.cx}
              cy={slot.cy}
              r={isOver ? slot.r + 2 : slot.r}
              fill={filled ? RISK_TOKEN[risk] : "var(--surface-sunken)"}
              fillOpacity={filled ? 0.92 : 1}
              stroke={isOver ? colorToken : filled ? RISK_TOKEN[risk] : "var(--border-soft)"}
              strokeWidth={filled || isOver ? 2 : 1.25}
              filter={filled ? `url(#${shadowId})` : undefined}
              style={{ transition: "all 200ms cubic-bezier(0.34, 1.4, 0.64, 1)" }}
            />
            {items.length > 1 ? (
              <text
                x={slot.cx}
                y={slot.cy + 4}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fontFamily="var(--font-mono, monospace)"
                fill="var(--text-inverse)"
              >
                {items.length}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* guardrail shield plate */}
      {(() => {
        const slot = getSlot("shield");
        return (
          <path
            aria-label={`Guardrails ${securityOn ? "on" : "off"}`}
            d={shieldPath(slot.cx, slot.cy, slot.r)}
            fill={securityOn ? "var(--success-500)" : "var(--surface-sunken)"}
            fillOpacity={securityOn ? 0.92 : 1}
            stroke={securityOn ? "var(--success-500)" : "var(--border-strong)"}
            strokeWidth={securityOn ? 2 : 1.25}
            filter={securityOn ? `url(#${shadowId})` : undefined}
            style={{ transition: "all 200ms cubic-bezier(0.34, 1.4, 0.64, 1)" }}
          />
        );
      })()}
    </svg>
  );
}

function shieldPath(cx: number, cy: number, r: number): string {
  const top = cy - r;
  const bottom = cy + r;
  const half = r * 0.85;
  return [
    `M ${cx - half} ${top}`,
    `L ${cx + half} ${top}`,
    `L ${cx + half} ${cy + r * 0.2}`,
    `Q ${cx + half} ${bottom} ${cx} ${bottom}`,
    `Q ${cx - half} ${bottom} ${cx - half} ${cy + r * 0.2}`,
    "Z",
  ].join(" ");
}
