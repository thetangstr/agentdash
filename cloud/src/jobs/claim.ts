// AgentDash: what a box's own /api/health says about its claim (GH #800
// security review). Deletion needs POSITIVE evidence that a box is unclaimed:
//   claimed    `claimed: true`, `bootstrapStatus: "ready"` or a company exists
//   unclaimed  `claimed: false` (SC-6 #767) and none of the above
//   unknown    anything else: unreachable, an error, or a release without the
//              `claimed` field. `bootstrap_pending` alone is NOT evidence:
//              the live SC-2 run showed a box stays bootstrap_pending after its
//              founder has signed up, until a company is created.
export type ClaimState = "claimed" | "unclaimed" | "unknown";

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
