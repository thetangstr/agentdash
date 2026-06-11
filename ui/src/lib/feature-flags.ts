// AgentDash: client-side feature-flag keys + helpers.
// Flags are stored per-company in the `feature_flags` table and read via
// goalsEvalHitlApi.listFeatureFlags. Keys are plain strings (mirrors the
// existing `dod_guard_enabled` convention).
import type { AvatarVariant } from "../components/agent-creator/avatar/avatar-geometry";

/**
 * The two avatar treatments are each gated by their own flag, so they can be
 * rolled out / compared independently per company. Disabled by default;
 * enable via PUT /companies/:companyId/feature-flags/:flagKey { enabled: true }.
 */
export const AVATAR_VARIANT_FLAG_KEYS: Record<AvatarVariant, string> = {
  restrained: "agent_avatar_restrained",
  playful: "agent_avatar_playful",
};

export const ALL_AVATAR_VARIANTS: AvatarVariant[] = ["restrained", "playful"];
