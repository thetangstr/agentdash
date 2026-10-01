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
 * GH #836 re-review: the first stable release whose /claim page reads the
 * email from the link's fragment (ui/src/pages/Claim.tsx, shipped by #836).
 * Null until that release is cut: set it, in the PR after the cut, to that
 * tag. Releases before it (v2026.927.0 and older) read only `?email=`.
 */
export const CLAIM_EMAIL_IN_FRAGMENT_SINCE: string | null = "v2026.929.0";

const RELEASE_RE = /^v(\d{4})\.(\d{3,4})\.(\d+)$/;

/** Compare stable tags vYYYY.MDD.N (MDD as a number: 927 < 1004). Null for anything else. */
export function compareReleases(a: string, b: string): number | null {
  const ma = RELEASE_RE.exec(a);
  const mb = RELEASE_RE.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * True only when the box's release is known and at or after `since`. An
 * unknown release, a non-stable tag, or no `since` yet all answer false: the
 * `?email=` form is the safe default because EVERY /claim page reads it
 * (older releases read only it; newer ones read both), whereas the fragment
 * form would show an older box's page as "this claim link is incomplete".
 */
export function claimReadsEmailFromFragment(releaseTag: string | null | undefined, since: string | null = CLAIM_EMAIL_IN_FRAGMENT_SINCE): boolean {
  if (!releaseTag || !since) return false;
  const c = compareReleases(releaseTag, since);
  return c !== null && c >= 0;
}

/**
 * The one-time claim link (spec §3.5 step 2). The code always rides in the
 * fragment, which browsers never send to a server or put in a Referer. The
 * email rides there too when the box's /claim page reads it from there
 * (`emailInFragment`); otherwise, for older releases, in `?email=`, where it
 * reaches the box's and the edge's request logs (GH #836 review).
 */
export function claimLink(input: { slug: string; edgeDomain: string; email: string; code: string; emailInFragment: boolean }): string {
  const base = `https://${input.slug}.${input.edgeDomain}/claim`;
  const code = `code=${encodeURIComponent(input.code)}`;
  const email = `email=${encodeURIComponent(input.email)}`;
  return input.emailInFragment ? `${base}#${code}&${email}` : `${base}?${email}#${code}`;
}

/** The claim link for a box, from its encrypted claim code; null once the code is erased (after the claim). */
export function claimLinkForBox(
  box: { slug: string; claimCodeEnc: string | null; releaseTag?: string | null },
  input: { dataKeys: DataKeyring; edgeDomain: string; email: string; fragmentSince?: string | null },
): string | null {
  if (!box.claimCodeEnc) return null;
  const code = decryptField(input.dataKeys, box.claimCodeEnc, "boxes.claim_code_enc");
  const emailInFragment = claimReadsEmailFromFragment(box.releaseTag, input.fragmentSince === undefined ? CLAIM_EMAIL_IN_FRAGMENT_SINCE : input.fragmentSince);
  return claimLink({ slug: box.slug, edgeDomain: input.edgeDomain, email: input.email, code, emailInFragment });
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
