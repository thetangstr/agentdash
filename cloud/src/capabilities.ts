// AgentDash: capabilities the control plane may rely on only once the box
// side ships them. These are CODE constants, flipped by the pull request that
// lands the feature, never by an environment variable or setting.
//
// claimTrackingReady: boxes report their claim state (`claimed` in
// /api/health, SC-6 #767) and the edge secret gate exists (SC-5 #766). Until
// then the control plane cannot tell an unclaimed box from one in use, so
// turning provisioning on is refused and provisioning stays off even if the
// stored setting says otherwise (GH #800 security review).
//
// When it is safe to flip (the orchestrator does it, in its own PR):
//   1. #767 and #766 are merged, and a stable release is cut from a main that
//      contains both: the first `vYYYY.MDD.N` tag after the later of the two
//      merges, with its GHCR image published (#774). No release up to and
//      including v2026.925.0 reports `claimed`.
//   2. target_release names that tag (or a later one), so every new box runs it.
//   3. A live end-to-end passes on a box from that image: /api/health reports
//      claimed:false, the claim link signs the founder up and lands on /cos,
//      health reports claimed:true, the sweep marks the box active and the
//      close_signup job closes its sign-up.
//   3b. Set jobs/claim.ts CLAIM_EMAIL_IN_FRAGMENT_SINCE to the first release
//       containing #836's /claim change; until then links use ?email=, which
//       every release reads.
//   4. No box on an older release is still awaiting its claim (they stay
//      "unknown" to the sweep and would never be cleaned up, only flagged).
//
// FLIPPED 2026-10-01 (orchestrator, MVP launch): SC-5 (#807), SC-6 (#805)
// and #836 all first ship in v2026.929.0, whose GHCR image is published; no
// box on an older release is awaiting its claim (the only box, sc2test, is
// deleted). Step 3's live end-to-end is run on the first canary box right
// after this deploys, with target_release pinned to a release that reports
// `claimed` and waitlist approval still in front of every customer box; if it
// fails, `admin settings set provisioning_enabled false` stops provisioning.
//
// Frozen, so nothing can flip a capability at runtime: an assignment throws
// (ES modules are strict). Tests that need another value replace this module
// with vi.mock, never by mutating it.
export interface Capabilities {
  readonly claimTrackingReady: boolean;
}

export const capabilities: Capabilities = Object.freeze({
  claimTrackingReady: true,
});
