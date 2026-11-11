// AgentDash: client-side feature-flag keys + helpers.
// Flags are stored per-company in the `feature_flags` table and read via
// goalsEvalHitlApi.listFeatureFlags. Keys are plain strings (mirrors the
// existing `dod_guard_enabled` convention).
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import type { AvatarVariant } from "../components/agent-creator/avatar/avatar-geometry";

/**
 * The two avatar treatments are each gated by their own flag, so they can be
 * rolled out / compared independently per company. Disabled by default;
 * enable via PUT /companies/:companyId/feature-flags/:flagKey { enabled: true }.
 */
export const AVATAR_VARIANT_FLAG_KEYS: Record<AvatarVariant, string> = {
  // From the shared registry: the server accepts only keys listed there.
  restrained: FEATURE_FLAG_KEYS.AGENT_AVATAR_RESTRAINED,
  playful: FEATURE_FLAG_KEYS.AGENT_AVATAR_PLAYFUL,
};

export const ALL_AVATAR_VARIANTS: AvatarVariant[] = ["restrained", "playful"];
