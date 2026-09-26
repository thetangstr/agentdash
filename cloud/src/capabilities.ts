// AgentDash: capabilities the control plane may rely on only once the box
// side ships them. These are CODE constants, flipped by the pull request that
// lands the feature, never by an environment variable or setting.
//
// claimTrackingReady: boxes report their claim state (`claimed` in
// /api/health, SC-6 #767) and the edge secret gate exists (SC-5 #766). Until
// then the control plane cannot tell an unclaimed box from one in use, so
// turning provisioning on is refused and provisioning stays off even if the
// stored setting says otherwise (GH #800 security review).
export const capabilities = {
  claimTrackingReady: false,
};
