import type { Request } from "express";
import { mintingOrigins, normalizeOrigin } from "./declared-origins.js";

/**
 * The address this instance calls itself, when its operator has said one — which
 * is not the address any particular client happened to dial.
 *
 * Anything minted for a person to open must come from here, for the same reason
 * in two places:
 *
 * - The health route reports it so the UI can generate harness configuration
 *   against a stable host rather than `window.location.origin`. That origin is
 *   whatever URL was in the browser when someone pressed Copy, so a command
 *   copied from a LAN address bakes that address into `~/.codex/config.toml` on a
 *   colleague's laptop and silently stops working the moment they change network.
 *   A config that persists on someone else's machine is the worst place for that
 *   footgun.
 * - Approval links had the same shape of bug (#539): built from the caller's own
 *   transport address, they came out as `http://127.0.0.1:3102` — correct for the
 *   process that minted them and useless to the steward who had to read them.
 *
 * Not a secret. It is by definition the address people are told to use, and the
 * health endpoint already reports deployment mode and bootstrap state.
 */
export function configuredPublicBaseUrl(): string | undefined {
  // AgentDash (#547): PAPERCLIP_CANONICAL_ORIGIN, when declared, is the
  // address. Without it the old variables answer exactly as before, and a
  // bare PAPERCLIP_ORIGINS list lends its first entry only when nothing else
  // names one.
  const canonical = normalizeOrigin(process.env.PAPERCLIP_CANONICAL_ORIGIN);
  if (canonical) return canonical;
  const raw =
    process.env.PAPERCLIP_PUBLIC_URL?.trim()
    || process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  const firstDeclared = (process.env.PAPERCLIP_ORIGINS ?? "")
    .split(",")
    .map((value) => normalizeOrigin(value))
    .find((value): value is string => Boolean(value));
  return firstDeclared;
}

/** The origin a request says it was addressed to (proxy headers first), or null. */
export function requestOrigin(req: Pick<Request, "header" | "protocol">): string | null {
  const forwardedProto = req.header("x-forwarded-proto");
  const proto = forwardedProto?.split(",")[0]?.trim() || req.protocol || "http";
  const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  if (!host) return null;
  return normalizeOrigin(`${proto}://${host}`);
}

/**
 * AgentDash (#547): the base for a link minted INSIDE an HTTP response, whose
 * reader is the caller.
 *
 * Echo the origin the caller used — someone browsing on the canonical name
 * gets canonical links, someone on the office door gets office-door links —
 * but only when that origin is one this instance trusts. `Host` and
 * `X-Forwarded-Host` are client-supplied; taken at face value they let a
 * caller mint an invite that names any host it likes. Anything else gets the
 * canonical address. Loopback callers on this machine are echoed too (see
 * `isLoopbackSelfRequest`). With no canonical configured and nothing trusted
 * to compare against there is no better answer than the request's own
 * origin, which is what this returned before.
 *
 * Links read outside a request — emails, Teams cards, MCP results, approval
 * links — must use `configuredPublicBaseUrl()` instead: there is no caller to
 * echo.
 */
type MintingRequest = Pick<Request, "header" | "protocol"> & {
  socket?: { remoteAddress?: string | undefined } | null;
};

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * A caller on this machine addressing this machine by a loopback name (an
 * on-box agent, the CLI, a local harness). Their links are for them, and the
 * OpenClaw onboarding diagnostics rely on seeing that the API base is
 * loopback, so such a request is echoed even though no trusted-origin list
 * names loopback. Both halves must hold: a remote client merely claiming
 * `Host: localhost` is not a loopback caller.
 */
function isLoopbackSelfRequest(req: MintingRequest, requested: string): boolean {
  const remote = req.socket?.remoteAddress;
  if (!remote || !LOOPBACK_ADDRESSES.has(remote)) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(requested).hostname);
  } catch {
    return false;
  }
}

export function inBandBaseUrl(req: MintingRequest): string {
  const requested = requestOrigin(req);
  if (requested && mintingOrigins().has(requested)) return requested;
  if (requested && isLoopbackSelfRequest(req, requested)) return requested;
  const canonical = configuredPublicBaseUrl();
  if (canonical) {
    if (requested && normalizeOrigin(canonical) === requested) return requested;
    return canonical;
  }
  return requested ?? "";
}

/**
 * AgentDash (#547): the base for a link that leaves the request — an invite
 * email above all. Always canonical when there is one; the in-band base only
 * when the instance advertises nothing.
 */
export function outOfBandBaseUrl(req: MintingRequest): string {
  return configuredPublicBaseUrl() ?? inBandBaseUrl(req);
}

/**
 * Absolute URL for an approval's page, or `undefined` when this instance does not
 * advertise a public URL.
 *
 * Undefined rather than a loopback fallback, deliberately. A client that is told
 * "no answer" can say so; a client handed a plausible-looking wrong link passes it
 * to a human, who discovers the problem only when it fails to open.
 */
export function approvalUrl(approvalId: string): string | undefined {
  const base = configuredPublicBaseUrl();
  return base ? `${base}/approvals/${encodeURIComponent(approvalId)}` : undefined;
}

/**
 * Absolute URL for a server-relative path, or `undefined` when this instance
 * advertises no public URL.
 *
 * Same contract as `approvalUrl` and for the same reason: a link handed to a
 * person has to name an address they can reach, and the server is the only party
 * that knows what that is. Callers that receive `undefined` should say so rather
 * than substituting a guess — see #539 for what a plausible wrong link costs.
 */
export function absoluteUrl(pathname: string): string | undefined {
  const base = configuredPublicBaseUrl();
  if (!base) return undefined;
  return `${base}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
}

/**
 * AgentDash (launch lane D): the base for links read outside any request
 * (billing emails, Stripe return URLs, OAuth redirect URIs) when a feature
 * has its own override variable. The override wins when set; otherwise the
 * instance's configured public URL; otherwise `fallback`. Never a request
 * host: there is no request to take one from, and a host-derived guess is
 * how a hosted box leaked its Railway address.
 */
export function publicBaseUrlOr(override: string | undefined, fallback = ""): string {
  const explicit = override?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  return configuredPublicBaseUrl() ?? fallback;
}
