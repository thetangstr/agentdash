// AgentDash: avatar treatment (a) — restrained / on-brand.
// Hairline geometry, tone-based slot fills, no glow / armor / rank badges.
// Motion is opacity/position fades only (respects prefers-reduced-motion).
import { getAgentIcon } from "../../../lib/agent-icons";
import type { AgentAvatarProps } from "./AgentAvatar";
import {
  AVATAR_VIEWBOX,
  RISK_TOKEN,
  getSlot,
  itemsBySlot,
  slotRisk,
} from "./avatar-geometry";

export function AvatarRestrained({
  iconName,
  colorToken = "var(--accent-500)",
  name,
  equipped,
  securityOn = false,
  dndOverSlot = null,
  size = 220,
}: AgentAvatarProps) {
  const HeadIcon = getAgentIcon(iconName);
  const bySlot = itemsBySlot(equipped);
  const head = getSlot("head");
  const { w, h } = AVATAR_VIEWBOX;
  const height = (size * h) / w;

  return (
    <svg
      width={size}
      height={height}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`${name || "Agent"} avatar with ${equipped.length} equipped capabilities`}
      style={{ display: "block" }}
    >
      {/* connective spine — hairline */}
      <line
        x1={head.cx}
        y1={head.cy}
        x2={head.cx}
        y2={getSlot("shield").cy}
        stroke="var(--border-strong)"
        strokeWidth={1}
      />

      {/* head */}
      <circle
        cx={head.cx}
        cy={head.cy}
        r={head.r}
        fill="var(--surface-raised)"
        stroke="var(--border-strong)"
        strokeWidth={1.25}
      />
      <g
        transform={`translate(${head.cx - 13} ${head.cy - 13})`}
        style={{ color: colorToken }}
      >
        <HeadIcon width={26} height={26} color={colorToken} strokeWidth={1.5} />
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
            fill={filled ? RISK_TOKEN[risk] : "var(--surface-raised)"}
            fillOpacity={filled ? 0.12 : 1}
            stroke={filled ? RISK_TOKEN[risk] : "var(--border-strong)"}
            strokeWidth={1.25}
            style={{ transition: "fill-opacity 200ms ease, stroke 200ms ease" }}
          />
        );
      })()}

      {/* peripheral sockets: tools, environment */}
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
              r={slot.r}
              fill={filled ? RISK_TOKEN[risk] : "var(--surface-sunken)"}
              fillOpacity={filled ? 0.14 : 1}
              stroke={isOver ? colorToken : filled ? RISK_TOKEN[risk] : "var(--border-soft)"}
              strokeWidth={isOver ? 1.75 : 1}
              strokeDasharray={filled ? undefined : "2 3"}
              style={{ transition: "all 200ms ease" }}
            />
            {items.length > 1 ? (
              <text
                x={slot.cx}
                y={slot.cy + 3.5}
                textAnchor="middle"
                fontSize={10}
                fontFamily="var(--font-mono, monospace)"
                fill="var(--text-secondary)"
              >
                {items.length}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* guardrail shield */}
      {(() => {
        const slot = getSlot("shield");
        return (
          <g aria-label={`Guardrails ${securityOn ? "on" : "off"}`}>
            <path
              d={shieldPath(slot.cx, slot.cy, slot.r)}
              fill={securityOn ? "var(--success-500)" : "var(--surface-sunken)"}
              fillOpacity={securityOn ? 0.12 : 1}
              stroke={securityOn ? "var(--success-500)" : "var(--border-strong)"}
              strokeWidth={1.25}
              strokeDasharray={securityOn ? undefined : "2 3"}
              style={{ transition: "all 200ms ease" }}
            />
          </g>
        );
      })()}
    </svg>
  );
}

/** A small heraldic shield centered on (cx, cy). */
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
