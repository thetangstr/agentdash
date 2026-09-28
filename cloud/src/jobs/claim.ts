// AgentDash: what a box's own /api/health says about its claim (GH #800
// security review). Deletion needs POSITIVE evidence that a box is unclaimed:
//   claimed    `claimed: true`, `bootstrapStatus: "ready"` or a company exists
//   unclaimed  `claimed: false` (SC-6 #767) and none of the above
//   unknown    anything else: unreachable, an error, or a release without the
//              `claimed` field. `bootstrap_pending` alone is NOT evidence:
//              the live SC-2 run showed a box stays bootstrap_pending after its
//              founder has signed up, until a company is created.
//
// Boxes on a release before SC-6 (#767) have no `claimed` field, so they are
// always `unknown` here: never cleaned up, and provisioning stays gated
// (capabilities.claimTrackingReady) until every box runs a release that has it.
import { decryptField, type DataKeyring } from "../crypto.js";

export type ClaimState = "claimed" | "unclaimed" | "unknown";

/**
 * The one-time claim link (spec §3.5 step 2). The code AND the email ride in
 * the fragment, which browsers never send to a server or put in a Referer
 * (GH #836 review: the email was in the query string, so it reached the
 * box's and the edge's request logs). The box's /claim page reads both from
 * the fragment (ui/src/pages/Claim.tsx), and still accepts ?email= from
 * older links.
 */
export function claimLink(input: { slug: string; edgeDomain: string; email: string; code: string }): string {
  return `https://${input.slug}.${input.edgeDomain}/claim#code=${encodeURIComponent(input.code)}&email=${encodeURIComponent(input.email)}`;
}

/** The claim link for a box, from its encrypted claim code; null once the code is erased (after the claim). */
export function claimLinkForBox(
  box: { slug: string; claimCodeEnc: string | null },
  input: { dataKeys: DataKeyring; edgeDomain: string; email: string },
): string | null {
  if (!box.claimCodeEnc) return null;
  const code = decryptField(input.dataKeys, box.claimCodeEnc, "boxes.claim_code_enc");
  return claimLink({ slug: box.slug, edgeDomain: input.edgeDomain, email: input.email, code });
}

export interface ClaimProbe {
  state: ClaimState;
  health: Record<string, unknown> | null;
  reason: string;
}

export async function probeClaim(
  upstreamHost: string | null,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ClaimProbe> {
  if (!upstreamHost) return { state: "unknown", health: null, reason: "no upstream host recorded" };
  const f = opts.fetch ?? fetch;
  let body: Record<string, unknown> | null = null;
  try {
    const res = await f(`https://${upstreamHost}/api/health`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    if (!res.ok) return { state: "unknown", health: null, reason: `health answered HTTP ${res.status}` };
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return { state: "unknown", health: null, reason: `health unreachable (${err instanceof Error ? err.name : "error"})` };
  }
  if (!body || body.status !== "ok") return { state: "unknown", health: body, reason: "health is not ok" };
  if (body.claimed === true || body.bootstrapStatus === "ready" || body.instanceHasCompany === true) {
    return { state: "claimed", health: body, reason: "box reports a claim" };
  }
  if (body.claimed === false) return { state: "unclaimed", health: body, reason: "box reports claimed=false" };
  return { state: "unknown", health: body, reason: "box does not report its claim state (needs SC-6)" };
}
