/**
 * AgentDash (#547): the addresses this instance answers on, stated by the
 * operator as full origins instead of synthesized from bare hostnames.
 *
 * Two new variables:
 *
 *   PAPERCLIP_CANONICAL_ORIGIN=https://agents.mkthink.com
 *   PAPERCLIP_ORIGINS=https://agents.mkthink.com,http://mkmini.local:3102
 *
 * Before these, trusted origins were `PAPERCLIP_ALLOWED_HOSTNAMES` crossed
 * with {http, https} and every port the code could infer. Every bug in this
 * area was that cross-product guessing wrong: the `:3112` browser 403 (#509),
 * a DHCP address that stopped being true, an mDNS name that was never true
 * off-link. A declared origin carries its own scheme and port, so there is
 * nothing left to infer.
 *
 * Declared mode is opt-in. When neither variable is set, nothing here changes
 * what the instance trusts or mints: `resolveOriginSettings` reproduces the
 * previous derivation exactly (the backward-compat test pins it), and the
 * existing variables keep their meaning. When either is set:
 *
 * - `PAPERCLIP_PUBLIC_URL`, `PAPERCLIP_AUTH_PUBLIC_BASE_URL` (and its
 *   `BETTER_AUTH_URL` / `BETTER_AUTH_BASE_URL` spellings) and
 *   `BETTER_AUTH_TRUSTED_ORIGINS` are deprecated aliases. Their origins fold
 *   into the declared set, so a door that worked keeps working while the
 *   operator migrates (the order in #547: declare the new origin alongside
 *   the old, cut canonical over, remove the old only once every paired
 *   harness has moved).
 * - `PAPERCLIP_ALLOWED_HOSTNAMES` still feeds the private-hostname guard, but
 *   a bare hostname no longer mints trusted origins — that would be the
 *   cross-product again. Boot warns for each allowed hostname no declared
 *   origin names, so a door that loses auth trust is announced, not found.
 */

export type OriginEnv = Record<string, string | undefined>;

/** `scheme://host[:port]` for an http(s) URL, or null when it is not one. */
export function normalizeOrigin(raw: string | undefined | null): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A Better Auth wildcard (`https://*.example.com`) parses as a URL but is a
  // pattern, not an address anyone can be sent to.
  if (!url.hostname || url.hostname.includes("*")) return null;
  return url.origin.toLowerCase();
}

/**
 * Parse a variable that must hold exactly an origin. Throws on anything else:
 * the variable is new and opt-in, so an unreadable value is a typo to report
 * at boot, not something to guess around on the auth path.
 */
function parseDeclaredOrigin(name: string, raw: string): string {
  const value = raw.trim();
  const origin = normalizeOrigin(value);
  if (!origin) {
    throw new Error(`${name} must be an http:// or https:// origin (scheme://host[:port]); got ${JSON.stringify(value)}`);
  }
  const url = new URL(value);
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(`${name} must be an origin with no path, query or fragment; got ${JSON.stringify(value)}`);
  }
  return origin;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

/** True when either declared-origins variable has a value. */
export function declaredOriginsEnabled(env: OriginEnv = process.env): boolean {
  return Boolean(env.PAPERCLIP_CANONICAL_ORIGIN?.trim() || env.PAPERCLIP_ORIGINS?.trim());
}

export interface OriginSettingsInput {
  env: OriginEnv;
  /** `auth.publicBaseUrl` from the config file, if any. */
  fileAuthPublicBaseUrl?: string;
  /** `server.allowedHostnames` from the config file, if any. */
  fileAllowedHostnames?: string[];
}

export interface OriginSettings {
  /** Better Auth's base URL (explicit mode) — same meaning as before. */
  authPublicBaseUrl: string | undefined;
  /** Hostnames the private-hostname guard admits — same meaning as before. */
  allowedHostnames: string[];
  /** Declared mode only: the one address minted for people who are not in a request. */
  canonicalOrigin?: string;
  /** Declared mode only: every origin browsers may arrive on, canonical first. */
  declaredOrigins?: string[];
  /**
   * Declared mode only: `BETTER_AUTH_TRUSTED_ORIGINS` entries that are not
   * plain origins (Better Auth's wildcard patterns). Still trusted for auth,
   * never echoed into a minted link.
   */
  trustedOriginPatterns?: string[];
  /** Declared mode only: the pre-#547 origin variables that are still set. */
  deprecatedAliasesInUse?: string[];
}

const AUTH_BASE_URL_ALIASES = [
  "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
] as const;

/**
 * The origin-related part of `loadConfig`, pure so it can be tested without
 * reading a config file or env file off disk.
 */
export function resolveOriginSettings(input: OriginSettingsInput): OriginSettings {
  const { env } = input;
  const publicUrlFromEnv = env.PAPERCLIP_PUBLIC_URL;
  const legacyAuthPublicBaseUrlRaw =
    env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    env.BETTER_AUTH_URL ??
    env.BETTER_AUTH_BASE_URL ??
    publicUrlFromEnv ??
    input.fileAuthPublicBaseUrl;
  const allowedHostnamesFromEnvRaw = env.PAPERCLIP_ALLOWED_HOSTNAMES;
  const allowedHostnamesFromEnv = allowedHostnamesFromEnvRaw
    ? allowedHostnamesFromEnvRaw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : null;
  const configuredHostnames = allowedHostnamesFromEnv ?? input.fileAllowedHostnames ?? [];

  if (!declaredOriginsEnabled(env)) {
    // Legacy derivation, byte for byte what loadConfig did before #547.
    const authPublicBaseUrl = legacyAuthPublicBaseUrlRaw?.trim() || undefined;
    const publicUrlHostname = authPublicBaseUrl
      ? (() => {
        try {
          return new URL(authPublicBaseUrl).hostname.trim().toLowerCase();
        } catch {
          return null;
        }
      })()
      : null;
    const allowedHostnames = Array.from(
      new Set(
        [
          ...configuredHostnames,
          ...(publicUrlHostname ? [publicUrlHostname] : []),
        ]
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    return { authPublicBaseUrl, allowedHostnames };
  }

  const explicitCanonicalRaw = env.PAPERCLIP_CANONICAL_ORIGIN?.trim();
  const explicitCanonical = explicitCanonicalRaw
    ? parseDeclaredOrigin("PAPERCLIP_CANONICAL_ORIGIN", explicitCanonicalRaw)
    : undefined;
  const listed = splitList(env.PAPERCLIP_ORIGINS).map((value) => parseDeclaredOrigin("PAPERCLIP_ORIGINS", value));

  // The auth base URL follows canonical when canonical is stated: one address
  // is the point. The old auth variable, if set, still folds into the
  // declared set below, so its door stays trusted.
  const authPublicBaseUrl = explicitCanonical ?? (legacyAuthPublicBaseUrlRaw?.trim() || listed[0]);

  // Same precedence as `configuredPublicBaseUrl()`, so links and the health
  // report agree with what this function calls canonical. The config file's
  // `auth.publicBaseUrl` stays out of this chain deliberately (AgentDash
  // #954): it reaches `authPublicBaseUrl` and the trusted set above, but an
  // operator-declared PAPERCLIP_CANONICAL_ORIGIN / PAPERCLIP_ORIGINS is the
  // stronger claim on which address links are minted from.
  const canonicalOrigin =
    explicitCanonical ??
    normalizeOrigin(publicUrlFromEnv) ??
    normalizeOrigin(env.PAPERCLIP_AUTH_PUBLIC_BASE_URL) ??
    listed[0];

  const aliasOrigins: string[] = [];
  for (const raw of [publicUrlFromEnv, ...AUTH_BASE_URL_ALIASES.map((name) => env[name])]) {
    const origin = normalizeOrigin(raw);
    if (origin) aliasOrigins.push(origin);
  }
  const trustedOriginPatterns: string[] = [];
  for (const entry of splitList(env.BETTER_AUTH_TRUSTED_ORIGINS)) {
    const origin = normalizeOrigin(entry);
    if (origin) aliasOrigins.push(origin);
    else trustedOriginPatterns.push(entry);
  }

  const authOrigin = normalizeOrigin(authPublicBaseUrl);
  const fileOrigin = normalizeOrigin(input.fileAuthPublicBaseUrl);
  const declaredOrigins = Array.from(
    new Set([
      ...(canonicalOrigin ? [canonicalOrigin] : []),
      ...listed,
      ...(authOrigin ? [authOrigin] : []),
      ...aliasOrigins,
      ...(fileOrigin ? [fileOrigin] : []),
    ]),
  );

  const allowedHostnames = Array.from(
    new Set(
      [
        ...configuredHostnames,
        ...declaredOrigins.map(hostnameOf).filter((value): value is string => Boolean(value)),
      ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  return {
    authPublicBaseUrl,
    allowedHostnames,
    canonicalOrigin,
    declaredOrigins,
    trustedOriginPatterns,
    deprecatedAliasesInUse: deprecatedOriginAliasesInUse(env),
  };
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

/**
 * Why a hostname cannot serve as the one address everybody is sent to, or
 * null when nothing is wrong with it. Loopback, private (RFC 1918), CGNAT /
 * tailnet (100.64.0.0/10), link-local, IPv6 ULA and mDNS `.local` names all
 * answer only from somewhere in particular.
 */
export function unreachableHostReason(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return null;
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "is a loopback name, which only this machine can open";
  }
  if (host === "local" || host.endsWith(".local")) {
    return "is an mDNS .local name, which resolves only on the local network segment — not over a VPN or off-site";
  }
  const v4 = parseIpv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return "is a loopback address, which only this machine can open";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return "is a private IP address, which is unreachable off-network and stops being true when the DHCP lease changes";
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return "is a CGNAT/tailnet IP address, which only members of that network can reach";
    }
    if (a === 169 && b === 254) return "is a link-local IP address, which does not route at all";
    return null;
  }
  if (host.includes(":")) {
    if (host === "::1") return "is a loopback address, which only this machine can open";
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) {
      return "is a private (ULA) IPv6 address, which is unreachable off-network";
    }
    if (/^fe[89ab][0-9a-f]?:/.test(host)) return "is a link-local IPv6 address, which does not route at all";
  }
  return null;
}

/**
 * Boot-time lint of the canonical origin. Warnings, never refusals: a
 * genuinely LAN-only deployment is legitimate, it just has to be a choice.
 *
 * `tlsDoors` are the https origins the operator has stated (declared set, or
 * in legacy mode the explicitly configured URLs — not the synthesized
 * cross-product, which always contains an https:// variant of every host).
 */
export function lintCanonicalOrigin(input: {
  canonical: string | undefined;
  tlsDoors: string[];
}): string[] {
  const warnings: string[] = [];
  const canonical = normalizeOrigin(input.canonical);
  if (!canonical) return warnings;
  const url = new URL(canonical);
  const reason = unreachableHostReason(url.hostname);
  if (reason) {
    warnings.push(
      `Canonical origin ${canonical} ${reason}. Approval, webhook, email and MCP links are minted from it; `
        + "set PAPERCLIP_CANONICAL_ORIGIN to a name every reader can resolve.",
    );
  }
  if (url.protocol === "http:") {
    const tls = Array.from(new Set(input.tlsDoors.map(normalizeOrigin).filter((value): value is string => Boolean(value))))
      .filter((origin) => origin.startsWith("https://"));
    if (tls.length > 0) {
      warnings.push(
        `Canonical origin ${canonical} is plain http:// while TLS door(s) ${tls.join(", ")} are configured. `
          + "Minted links send people, and their session cookies, over plaintext; make an https:// door canonical.",
      );
    }
  }
  return warnings;
}

/**
 * Everything boot should say about origins: the canonical lint (both modes)
 * and, in declared mode, an allowed hostname no declared origin names (it
 * passes the hostname guard, but browsers arriving on it are refused by
 * auth), an auth base URL overridden by canonical, and which deprecated
 * variables are still in use.
 */
export function originBootReport(input: {
  canonical: string | undefined;
  declaredOrigins?: string[];
  allowedHostnames: string[];
  authPublicBaseUrl?: string;
  env: OriginEnv;
  /** Configured single-sign-on providers (e.g. `["google"]`). */
  ssoProviders?: string[];
}): { warnings: string[]; info: string[] } {
  const { env } = input;
  const declared = input.declaredOrigins;
  const tlsDoors = declared ?? [
    ...(input.authPublicBaseUrl ? [input.authPublicBaseUrl] : []),
    ...(env.PAPERCLIP_PUBLIC_URL ? [env.PAPERCLIP_PUBLIC_URL] : []),
    ...splitList(env.BETTER_AUTH_TRUSTED_ORIGINS),
  ];
  const warnings = lintCanonicalOrigin({ canonical: input.canonical, tlsDoors });
  const info: string[] = [];
  if (!declared) return { warnings, info };

  const declaredHosts = new Set(declared.map(hostnameOf).filter(Boolean));
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
  const uncovered = input.allowedHostnames.filter((host) => !declaredHosts.has(host) && !loopback.has(host));
  if (uncovered.length > 0) {
    warnings.push(
      `Allowed hostname(s) ${uncovered.join(", ")} appear in no declared origin. `
        + "In declared mode a bare hostname is no longer expanded into trusted origins, so browsers arriving there "
        + "cannot sign in. Add the full origin (scheme://host:port) to PAPERCLIP_ORIGINS if that door should work.",
    );
  }

  const canonical = normalizeOrigin(input.canonical);
  if (env.PAPERCLIP_CANONICAL_ORIGIN?.trim()) {
    for (const name of AUTH_BASE_URL_ALIASES) {
      const origin = normalizeOrigin(env[name]);
      if (origin && origin !== canonical) {
        warnings.push(
          `${name}=${origin} differs from PAPERCLIP_CANONICAL_ORIGIN=${canonical}; `
            + "the auth base URL now follows the canonical origin. The old origin stays trusted, but SSO providers "
            + "registered against it need the canonical callback added.",
        );
        break;
      }
    }
  } else {
    info.push(
      `PAPERCLIP_ORIGINS is set without PAPERCLIP_CANONICAL_ORIGIN; canonical origin taken as ${canonical ?? "(none)"}.`,
    );
  }

  // AgentDash (GH #863 item 1): declared mode names TLS-door session cookies
  // `__Secure-<prefix>.session_token`. Legacy mode with an http:// (or unset)
  // auth base URL used the plain name on every door, so the first boot with
  // PAPERCLIP_ORIGINS set signs out everyone who was signed in on a TLS door.
  // Boot cannot tell a first boot from a later one, so the note is
  // conditional; it is harmless after the first sign-in.
  const tlsDeclared = declared.filter((origin) => origin.startsWith("https://"));
  const legacyBaseUrl = [...AUTH_BASE_URL_ALIASES, "PAPERCLIP_PUBLIC_URL"]
    .map((name) => env[name]?.trim())
    .find((value): value is string => Boolean(value));
  if (tlsDeclared.length > 0 && !legacyBaseUrl?.toLowerCase().startsWith("https://")) {
    warnings.push(
      `Sessions on TLS door(s) ${tlsDeclared.join(", ")} now use the __Secure- cookie name. If this instance `
        + "ran without PAPERCLIP_ORIGINS before, everyone signed in on those doors is signed out once and must "
        + "sign in again (see doc/DOCKER.md, Declared origins).",
    );
  }

  // GH #863 item 1 (verified): the OAuth state cookie follows the same rule
  // (`__Secure-<prefix>.state` on https, `<prefix>.state` on http) and the
  // provider callback lands on the canonical origin. Single sign-on started on
  // a door whose scheme differs from the canonical's sets the state cookie
  // under the other name, and the callback fails with a state mismatch.
  const ssoProviders = input.ssoProviders ?? [];
  if (ssoProviders.length > 0 && canonical) {
    const canonicalScheme = canonical.slice(0, canonical.indexOf(":"));
    const otherScheme = declared.filter((origin) => !origin.startsWith(`${canonicalScheme}:`));
    if (otherScheme.length > 0) {
      warnings.push(
        `Single sign-on (${ssoProviders.join(", ")}) only completes when started on the canonical origin ${canonical}; `
          + `started on ${otherScheme.join(", ")} it fails with a state mismatch, because the state cookie is named `
          + "per scheme. Send people to the canonical origin to sign in with SSO.",
      );
    }
  }

  const aliases = deprecatedOriginAliasesInUse(env);
  if (aliases.length > 0) {
    info.push(
      `Deprecated origin variables folded into the declared set: ${aliases.join(", ")}. `
        + "Move their doors into PAPERCLIP_ORIGINS and remove them once every paired harness uses the canonical origin.",
    );
  }
  return { warnings, info };
}

/** The pre-#547 origin variables that have a value (declared mode treats them as aliases). */
export function deprecatedOriginAliasesInUse(env: OriginEnv): string[] {
  return [
    "PAPERCLIP_PUBLIC_URL",
    ...AUTH_BASE_URL_ALIASES,
    "BETTER_AUTH_TRUSTED_ORIGINS",
    "PAPERCLIP_ALLOWED_HOSTNAMES",
  ].filter((name) => Boolean(env[name]?.trim()));
}

// ---------------------------------------------------------------------------
// The allow-set for in-band minting.
//
// Links minted inside an HTTP response may echo the origin the caller used,
// but only an origin the instance actually trusts — never a Host header taken
// at face value. Boot registers the effective trusted-origin set (declared or
// legacy-derived); without a registration (tests, tooling) the set is derived
// from the environment alone.
// ---------------------------------------------------------------------------

let registeredMintingOrigins: Set<string> | null = null;

export function registerMintingOrigins(origins: Iterable<string> | null): void {
  if (origins === null) {
    registeredMintingOrigins = null;
    return;
  }
  const set = new Set<string>();
  for (const origin of origins) {
    const normalized = normalizeOrigin(origin);
    if (normalized) set.add(normalized);
  }
  registeredMintingOrigins = set;
}

export function mintingOrigins(env: OriginEnv = process.env): Set<string> {
  if (registeredMintingOrigins) return registeredMintingOrigins;
  return explicitMintingOrigins(env);
}

/**
 * AgentDash (launch lane D): the origins an operator wrote down as full
 * origins, and nothing synthesized.
 *
 * In legacy mode the trusted set Better Auth uses is every
 * `PAPERCLIP_ALLOWED_HOSTNAMES` entry crossed with {http, https} and the
 * known ports. That is right for accepting sign-ins and wrong for minting
 * links: a hosted box lists its Railway host there so health checks and the
 * edge hop are admitted, and the Railway edge rewrites `X-Forwarded-Host` to
 * that host, so an invite created through `https://<slug>.agentdash.cloud`
 * came back as `https://web-production-xxxx.up.railway.app/...`. Boot
 * registers this set (plus the auth base URL) for minting in legacy mode, so
 * a hostname that is only allowed, never declared as an origin, gets the
 * public URL instead of an echo.
 */
export function explicitMintingOrigins(env: OriginEnv = process.env, extra: Array<string | undefined | null> = []): Set<string> {
  const set = new Set<string>();
  const add = (raw: string | undefined) => {
    const origin = normalizeOrigin(raw);
    if (origin) set.add(origin);
  };
  add(env.PAPERCLIP_CANONICAL_ORIGIN);
  for (const entry of splitList(env.PAPERCLIP_ORIGINS)) add(entry);
  add(env.PAPERCLIP_PUBLIC_URL);
  for (const name of AUTH_BASE_URL_ALIASES) add(env[name]);
  for (const entry of splitList(env.BETTER_AUTH_TRUSTED_ORIGINS)) add(entry);
  for (const entry of extra) add(entry ?? undefined);
  return set;
}

/**
 * AgentDash (launch lane D): the set boot registers for minting. Declared
 * mode mints from the declared set (every entry is a full origin the
 * operator wrote down). Legacy mode mints only from the explicit origins
 * plus the auth base URL, never from the allowed-hostnames cross-product
 * that Better Auth still trusts for sign-in.
 */
export function mintingOriginsForBoot(
  trusted: { mode: "declared" | "legacy"; origins: string[] },
  authPublicBaseUrl: string | undefined,
  env: OriginEnv = process.env,
): Iterable<string> {
  if (trusted.mode === "declared") return trusted.origins;
  return explicitMintingOrigins(env, [authPublicBaseUrl]);
}
