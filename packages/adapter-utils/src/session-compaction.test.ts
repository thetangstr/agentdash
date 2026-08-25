import { describe, expect, it } from "vitest";
import {
  getAdapterSessionManagement,
  hasSessionCompactionThresholds,
  readSessionCompactionOverride,
  resolveSessionCompactionPolicy,
} from "./session-compaction.js";

/**
 * When a resumed session gets rotated, and why it must.
 *
 * "Native context management" says the adapter will not overflow its window. It
 * says nothing about cost: every call still re-reads the accumulated history,
 * and across a heartbeat interval the provider's prompt cache has gone cold, so
 * that history is billed as fresh input. Measured on a live instance, a session
 * left to run reached 400k+ input per wake — ~194k of it uncached — to produce
 * a few hundred tokens of output.
 *
 * Rotation now carries a second job. The agent's instructions are sent once per
 * session rather than on every wake, so a session that never rotates is one
 * where the mandate is never re-stated, and the adapter's own compaction can
 * summarise it away without telling anybody. The ceiling is what guarantees a
 * fresh session eventually happens.
 */
describe("session compaction defaults for heartbeat adapters", () => {
  it.each(["codex_local", "hermes_local"])(
    "%s rotates on a bounded ceiling rather than never",
    (adapterType) => {
      const { policy, source } = resolveSessionCompactionPolicy(adapterType, {});
      expect(source).toBe("adapter_default");
      expect(policy.enabled).toBe(true);
      expect(hasSessionCompactionThresholds(policy)).toBe(true);
      expect(policy.maxRawInputTokens).toBeGreaterThan(0);
      expect(policy.maxSessionRuns).toBeGreaterThan(0);
    },
  );

  it("keeps the ceiling generous enough not to be a per-wake reset", () => {
    // A fresh session re-sends the whole mandate, so rotating too eagerly would
    // reintroduce the cost this is meant to remove. The ceiling is a backstop
    // against unbounded growth, not a routine.
    const { policy } = resolveSessionCompactionPolicy("codex_local", {});
    expect(policy.maxSessionRuns).toBeGreaterThanOrEqual(10);
    expect(policy.maxRawInputTokens).toBeGreaterThanOrEqual(100_000);
  });

  it.each(["acpx_local", "claude_local"])(
    "leaves %s alone — it is not what was measured",
    (adapterType) => {
      // Only the two adapters actually running heartbeats here were changed.
      // Widening this to every adapter would be a guess dressed up as a fix.
      const { policy } = resolveSessionCompactionPolicy(adapterType, {});
      expect(hasSessionCompactionThresholds(policy)).toBe(false);
    },
  );

  it("still lets an agent override the default in either direction", () => {
    const off = resolveSessionCompactionPolicy("codex_local", {
      heartbeat: { sessionCompaction: { enabled: false } },
    });
    expect(off.policy.enabled).toBe(false);
    expect(off.source).toBe("agent_override");

    const tighter = resolveSessionCompactionPolicy("codex_local", {
      heartbeat: { sessionCompaction: { maxRawInputTokens: 50_000 } },
    });
    expect(tighter.policy.maxRawInputTokens).toBe(50_000);
    // Untouched fields still come from the adapter default.
    expect(tighter.policy.maxSessionRuns).toBeGreaterThan(0);
  });

  it("reads an override from either spelling the config has used", () => {
    expect(readSessionCompactionOverride({ heartbeat: { sessionRotation: { maxSessionRuns: 5 } } }))
      .toEqual({ maxSessionRuns: 5 });
    expect(readSessionCompactionOverride({ sessionCompaction: { maxSessionAgeHours: 3 } }))
      .toEqual({ maxSessionAgeHours: 3 });
  });

  it("still reports these adapters as resumable", () => {
    // The fix is about rotating a long session, not about giving up resume —
    // resume is what makes a wake cheap in the first place.
    for (const adapterType of ["codex_local", "hermes_local"]) {
      expect(getAdapterSessionManagement(adapterType)?.supportsSessionResume).toBe(true);
    }
  });
});
