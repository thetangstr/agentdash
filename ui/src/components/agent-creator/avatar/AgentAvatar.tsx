// AgentDash: avatar figure for the agent creator. Delegates to one of two
// aesthetic treatments behind a shared prop contract so they can be compared.
import type {
  AvatarSlotId,
  AvatarVariant,
  EquippedAvatarItem,
} from "./avatar-geometry";
import { AvatarRestrained } from "./AvatarRestrained";
import { AvatarPlayful } from "./AvatarPlayful";

export interface AgentAvatarProps {
  variant: AvatarVariant;
  /** Lucide icon name shown at the head node (reuses AGENT_ICON_NAMES). */
  iconName?: string | null;
  /** Agent accent color — a CSS color value or custom-property reference. */
  colorToken?: string;
  name?: string;
  equipped: readonly EquippedAvatarItem[];
  securityOn?: boolean;
  /** Capability coverage 0..100. */
  coverage?: number;
  /** Slot currently hovered during a drag (wired in Phase 3). */
  dndOverSlot?: AvatarSlotId | null;
  /** Rendered pixel width; height scales with the viewBox. */
  size?: number;
  className?: string;
}

export function AgentAvatar(props: AgentAvatarProps) {
  return props.variant === "playful" ? (
    <AvatarPlayful {...props} />
  ) : (
    <AvatarRestrained {...props} />
  );
}
