// AgentDash: shared geometry + types for the agent-creator avatar.
// Single source of truth so both aesthetic treatments (restrained / playful)
// render identical slot positions and can be compared 1:1.

export type AvatarSlotId = "head" | "tools" | "body" | "environment" | "shield";

export type AvatarRiskLevel = "none" | "low" | "medium" | "high";

export type AvatarVariant = "restrained" | "playful";

export interface AvatarSlot {
  id: AvatarSlotId;
  /** plain-english label, used for aria + tooltips */
  label: string;
  /** SVG coordinates within AVATAR_VIEWBOX */
  cx: number;
  cy: number;
  /** socket radius */
  r: number;
}

/** A capability/skill module currently equipped onto a slot. */
export interface EquippedAvatarItem {
  slotId: AvatarSlotId;
  moduleId: string;
  label: string;
  risk: AvatarRiskLevel;
}

export const AVATAR_VIEWBOX = { w: 132, h: 158 } as const;

/**
 * Slot layout. The figure is a calm, geometric "operator":
 * head (reasoning) on top, a body core, tools on the left, reach/data on the
 * right, and the guardrail shield anchored below.
 */
export const AVATAR_SLOTS: readonly AvatarSlot[] = [
  { id: "head", label: "Reasoning", cx: 66, cy: 34, r: 24 },
  { id: "tools", label: "Tools", cx: 30, cy: 92, r: 13 },
  { id: "body", label: "Operations", cx: 66, cy: 96, r: 20 },
  { id: "environment", label: "Reach & data", cx: 102, cy: 92, r: 13 },
  { id: "shield", label: "Guardrails", cx: 66, cy: 138, r: 15 },
] as const;

export function getSlot(id: AvatarSlotId): AvatarSlot {
  const slot = AVATAR_SLOTS.find((s) => s.id === id);
  if (!slot) throw new Error(`Unknown avatar slot: ${id}`);
  return slot;
}

/** Risk → design-token color (CSS custom property reference). */
export const RISK_TOKEN: Record<AvatarRiskLevel, string> = {
  none: "var(--success-500)",
  low: "var(--accent-300)",
  medium: "var(--warn-500)",
  high: "var(--danger-500)",
};

/** Group equipped items by slot for rendering. */
export function itemsBySlot(
  equipped: readonly EquippedAvatarItem[],
): Record<AvatarSlotId, EquippedAvatarItem[]> {
  const out: Record<AvatarSlotId, EquippedAvatarItem[]> = {
    head: [],
    tools: [],
    body: [],
    environment: [],
    shield: [],
  };
  for (const item of equipped) out[item.slotId].push(item);
  return out;
}

/** Highest risk present in a slot, for tone selection. */
export function slotRisk(items: readonly EquippedAvatarItem[]): AvatarRiskLevel {
  const order: AvatarRiskLevel[] = ["high", "medium", "low", "none"];
  for (const level of order) {
    if (items.some((i) => i.risk === level)) return level;
  }
  return "none";
}
