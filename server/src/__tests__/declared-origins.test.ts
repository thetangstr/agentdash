import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { deriveAuthTrustedOrigins, resolveAuthTrustedOrigins } from "../auth/better-auth.js";
import {
  lintCanonicalOrigin,
  mintingOriginsForBoot,
  originBootReport,
  registerMintingOrigins,
  resolveOriginSettings,
  unreachableHostReason,
  type OriginEnv,
} from "../lib/declared-origins.js";
import { configuredPublicBaseUrl, inBandBaseUrl, outOfBandBaseUrl } from "../lib/public-base-url.js";

// AgentDash (#547). Host identifiers are illustrative, shaped like a box with
// a plaintext LAN door, an mDNS name, a CGNAT/tailnet IP and a TLS tailnet
// door behind a proxy on :3112 — not any real deployment's addresses.
const LAN_IP = "10.0.0.20";
const MDNS = "office-mini.local";
const CGNAT_IP = "100.64.0.16";
const TAILNET = "office-mini.tail0000.ts.net";

/** A multi-door deployment configured the pre-#547 way, before any declared origin. */
const LEGACY_BOX_ENV: OriginEnv = {
  PAPERCLIP_PUBLIC_URL: `http://${LAN_IP}:3102`,
  PAPERCLIP_AUTH_PUBLIC_BASE_URL: `https://${TAILNET}:3112`,
  PAPERCLIP_ALLOWED_HOSTNAMES: `${LAN_IP},${MDNS},${CGNAT_IP},${TAILNET}`,
  BETTER_AUTH_TRUSTED_ORIGINS: `https://${TAILNET}:3112,http://localhost:3102`,
};

function configFrom(env: OriginEnv, overrides: Partial<Config> = {}): Config {
  const settings = resolveOriginSettings({ env });
  return {
    deploymentMode: "authenticated",
    port: 3102,
    authBaseUrlMode: settings.authPublicBaseUrl ? "explicit" : "auto",
    authPublicBaseUrl: settings.authPublicBaseUrl,
    allowedHostnames: settings.allowedHostnames,
    ...(settings.declaredOrigins
      ? {
        canonicalOrigin: settings.canonicalOrigin,
        declaredOrigins: settings.declaredOrigins,
        trustedOriginPatterns: settings.trustedOriginPatterns,
      }
      : {}),
    ...overrides,
  } as Config;
}

describe("backward compatibility: no declared origins", () => {
  it("resolves the auth base URL and hostname list exactly as loadConfig did", () => {
    const settings = resolveOriginSettings({ env: LEGACY_BOX_ENV });

    expect(settings).toEqual({
      authPublicBaseUrl: `https://${TAILNET}:3112`,
      allowedHostnames: [LAN_IP, MDNS, CGNAT_IP, TAILNET],
    });
  });

  it("falls back through BETTER_AUTH_URL, PAPERCLIP_PUBLIC_URL and the config file in the old order", () => {
    expect(resolveOriginSettings({ env: { BETTER_AUTH_URL: " https://a.example.test " } }).authPublicBaseUrl)
      .toBe("https://a.example.test");
    expect(resolveOriginSettings({ env: { PAPERCLIP_PUBLIC_URL: "http://b.example.test:3100" } }))
      .toEqual({ authPublicBaseUrl: "http://b.example.test:3100", allowedHostnames: ["b.example.test"] });
    expect(resolveOriginSettings({
      env: {},
      fileAuthPublicBaseUrl: "https://file.example.test",
      fileAllowedHostnames: ["Extra.Example.Test"],
    })).toEqual({
      authPublicBaseUrl: "https://file.example.test",
      allowedHostnames: ["extra.example.test", "file.example.test"],
    });
    // An env hostname list replaces the file's, as before.
    expect(resolveOriginSettings({
      env: { PAPERCLIP_ALLOWED_HOSTNAMES: "env.example.test" },
      fileAllowedHostnames: ["file-only.example.test"],
    }).allowedHostnames).toEqual(["env.example.test"]);
    expect(resolveOriginSettings({ env: {} })).toEqual({ authPublicBaseUrl: undefined, allowedHostnames: [] });
  });

  it("trusts exactly today's derivation: hostnames x schemes x ports, plus BETTER_AUTH_TRUSTED_ORIGINS", () => {
    const config = configFrom(LEGACY_BOX_ENV);
    const { origins, mode } = resolveAuthTrustedOrigins(config, { listenPort: 3102, env: LEGACY_BOX_ENV });

    // What index.ts computed inline before #547.
    const previous = Array.from(new Set([
      ...deriveAuthTrustedOrigins(config, { listenPort: 3102 }),
      ...LEGACY_BOX_ENV.BETTER_AUTH_TRUSTED_ORIGINS!.split(",").map((value) => value.trim()),
    ]));

    const crossProduct = (host: string) => [
      `https://${host}`,
      `http://${host}`,
      `https://${host}:3102`,
      `http://${host}:3102`,
      `https://${host}:3112`,
      `http://${host}:3112`,
    ];
    expect(mode).toBe("legacy");
    expect(origins).toEqual(previous);
    expect(origins).toEqual(Array.from(new Set([
      `https://${TAILNET}:3112`,
      ...crossProduct(LAN_IP),
      ...crossProduct(MDNS),
      ...crossProduct(CGNAT_IP),
      ...crossProduct(TAILNET),
      "http://localhost:3102",
    ])));
    // 4 hostnames x 6 variants, plus the one env-only entry.
    expect(origins).toHaveLength(25);
  });

  it("an empty declared variable does not switch modes", () => {
    const env = { ...LEGACY_BOX_ENV, PAPERCLIP_CANONICAL_ORIGIN: "  ", PAPERCLIP_ORIGINS: "" };
    expect(resolveOriginSettings({ env })).toEqual(resolveOriginSettings({ env: LEGACY_BOX_ENV }));
  });
});

describe("declared origins", () => {
  const DECLARED_BOX_ENV: OriginEnv = {
    ...LEGACY_BOX_ENV,
    PAPERCLIP_CANONICAL_ORIGIN: "https://agents.example.test",
    PAPERCLIP_ORIGINS: `https://agents.example.test, http://${LAN_IP}:3102 ,https://${TAILNET}:3112`,
    BETTER_AUTH_TRUSTED_ORIGINS: undefined,
  };

  it("trusts the declared list and nothing synthesized from hostnames", () => {
    const config = configFrom(DECLARED_BOX_ENV);
    const { origins, mode } = resolveAuthTrustedOrigins(config, { listenPort: 3102, env: DECLARED_BOX_ENV });

    expect(mode).toBe("declared");
    expect(origins).toEqual([
      "https://agents.example.test",
      `http://${LAN_IP}:3102`,
      `https://${TAILNET}:3112`,
    ]);
    // The cross-product is gone: no guessed scheme or port for any host.
    expect(origins).not.toContain(`https://${LAN_IP}:3102`);
    expect(origins).not.toContain(`http://${MDNS}:3102`);
  });

  it("makes the canonical the auth base URL and adds declared hosts to the hostname guard", () => {
    const settings = resolveOriginSettings({ env: DECLARED_BOX_ENV });

    expect(settings.canonicalOrigin).toBe("https://agents.example.test");
    expect(settings.authPublicBaseUrl).toBe("https://agents.example.test");
    expect(settings.allowedHostnames).toEqual([LAN_IP, MDNS, CGNAT_IP, TAILNET, "agents.example.test"]);
  });

  it("folds the deprecated variables into the declared set", () => {
    const env: OriginEnv = {
      PAPERCLIP_CANONICAL_ORIGIN: "https://agents.example.test/",
      PAPERCLIP_PUBLIC_URL: `http://${LAN_IP}:3102/`,
      PAPERCLIP_AUTH_PUBLIC_BASE_URL: `https://${TAILNET}:3112`,
      BETTER_AUTH_TRUSTED_ORIGINS: "https://legacy.example.test:8443,https://*.preview.example.test",
    };
    const settings = resolveOriginSettings({ env });
    const { origins } = resolveAuthTrustedOrigins(configFrom(env), { env });

    expect(settings.deprecatedAliasesInUse).toEqual([
      "PAPERCLIP_PUBLIC_URL",
      "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
      "BETTER_AUTH_TRUSTED_ORIGINS",
    ]);
    expect(origins).toEqual([
      "https://agents.example.test",
      `http://${LAN_IP}:3102`,
      `https://${TAILNET}:3112`,
      "https://legacy.example.test:8443",
      // A Better Auth wildcard pattern still reaches Better Auth untouched.
      "https://*.preview.example.test",
    ]);
  });

  it("takes canonical from the old public URL when only PAPERCLIP_ORIGINS is set", () => {
    const env: OriginEnv = {
      PAPERCLIP_PUBLIC_URL: `http://${LAN_IP}:3102`,
      PAPERCLIP_ORIGINS: `http://${LAN_IP}:3102,https://agents.example.test`,
    };
    const settings = resolveOriginSettings({ env });

    expect(settings.canonicalOrigin).toBe(`http://${LAN_IP}:3102`);
    expect(settings.authPublicBaseUrl).toBe(`http://${LAN_IP}:3102`);
    expect(resolveOriginSettings({ env: { PAPERCLIP_ORIGINS: "https://first.example.test,http://second.example.test" } })
      .canonicalOrigin).toBe("https://first.example.test");
  });

  it("refuses a declared value that is not an origin", () => {
    expect(() => resolveOriginSettings({ env: { PAPERCLIP_CANONICAL_ORIGIN: "agents.example.test" } }))
      .toThrow(/PAPERCLIP_CANONICAL_ORIGIN must be an http:\/\/ or https:\/\/ origin/);
    expect(() => resolveOriginSettings({ env: { PAPERCLIP_CANONICAL_ORIGIN: "https://agents.example.test/app" } }))
      .toThrow(/no path/);
    expect(() => resolveOriginSettings({ env: { PAPERCLIP_ORIGINS: "https://ok.example.test,ftp://nope.example.test" } }))
      .toThrow(/PAPERCLIP_ORIGINS/);
  });
});

describe("boot lint", () => {
  it("fires for a .local canonical", () => {
    const warnings = lintCanonicalOrigin({ canonical: `http://${MDNS}:3102`, tlsDoors: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/mDNS \.local name/);
  });

  it("fires for private, CGNAT, loopback and link-local canonicals", () => {
    expect(unreachableHostReason(LAN_IP)).toMatch(/private IP/);
    expect(unreachableHostReason("172.20.1.1")).toMatch(/private IP/);
    expect(unreachableHostReason("192.168.1.57")).toMatch(/private IP/);
    expect(unreachableHostReason(CGNAT_IP)).toMatch(/CGNAT/);
    expect(unreachableHostReason("127.0.0.1")).toMatch(/loopback/);
    expect(unreachableHostReason("localhost")).toMatch(/loopback/);
    expect(unreachableHostReason("169.254.10.1")).toMatch(/link-local/);
    expect(unreachableHostReason("[fd12::1]")).toMatch(/ULA/);
    expect(unreachableHostReason("[::1]")).toMatch(/loopback/);
  });

  it("stays quiet for a public name and for public IP literals", () => {
    expect(unreachableHostReason("agents.example.test")).toBeNull();
    expect(unreachableHostReason("172.32.0.1")).toBeNull();
    expect(unreachableHostReason("8.8.8.8")).toBeNull();
    expect(lintCanonicalOrigin({ canonical: "https://agents.example.test", tlsDoors: ["https://agents.example.test"] }))
      .toEqual([]);
  });

  it("fires for an http canonical only when a TLS door is configured", () => {
    expect(lintCanonicalOrigin({ canonical: "http://agents.example.test", tlsDoors: ["http://agents.example.test"] }))
      .toEqual([]);
    const warnings = lintCanonicalOrigin({
      canonical: "http://agents.example.test",
      tlsDoors: [`https://${TAILNET}:3112`],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/plain http:\/\/ while TLS door\(s\) https:\/\/office-mini\.tail0000\.ts\.net:3112/);
  });

  it("flags today's legacy box: a private-IP http canonical beside an https auth door", () => {
    const config = configFrom(LEGACY_BOX_ENV);
    const report = originBootReport({
      canonical: LEGACY_BOX_ENV.PAPERCLIP_PUBLIC_URL,
      declaredOrigins: config.declaredOrigins,
      allowedHostnames: config.allowedHostnames,
      authPublicBaseUrl: config.authPublicBaseUrl,
      env: LEGACY_BOX_ENV,
    });

    expect(report.warnings).toHaveLength(2);
    expect(report.warnings[0]).toMatch(/private IP/);
    expect(report.warnings[1]).toMatch(/plain http:\/\//);
    // Legacy mode has no declared-set notes to make.
    expect(report.info).toEqual([]);
  });

  it("names allowed hostnames that no declared origin covers, and the aliases still in use", () => {
    const env: OriginEnv = {
      PAPERCLIP_CANONICAL_ORIGIN: "https://agents.example.test",
      PAPERCLIP_ORIGINS: `http://${LAN_IP}:3102`,
      PAPERCLIP_ALLOWED_HOSTNAMES: `${LAN_IP},${MDNS},localhost`,
      PAPERCLIP_AUTH_PUBLIC_BASE_URL: `https://${TAILNET}:3112`,
    };
    const config = configFrom(env);
    const report = originBootReport({
      canonical: config.canonicalOrigin,
      declaredOrigins: config.declaredOrigins,
      allowedHostnames: config.allowedHostnames,
      authPublicBaseUrl: config.authPublicBaseUrl,
      env,
    });

    expect(report.warnings).toEqual([
      expect.stringMatching(new RegExp(`^Allowed hostname\\(s\\) ${MDNS.replace(/\./g, "\\.")} appear in no declared origin`)),
      expect.stringMatching(/PAPERCLIP_AUTH_PUBLIC_BASE_URL=https:\/\/office-mini\.tail0000\.ts\.net:3112 differs from PAPERCLIP_CANONICAL_ORIGIN/),
    ]);
    expect(report.info).toEqual([
      expect.stringMatching(/Deprecated origin variables folded into the declared set: PAPERCLIP_AUTH_PUBLIC_BASE_URL, PAPERCLIP_ALLOWED_HOSTNAMES/),
    ]);
  });

  // GH #863 item 1.
  function declaredReport(env: OriginEnv, ssoProviders?: string[]) {
    const config = configFrom(env);
    return originBootReport({
      canonical: config.canonicalOrigin,
      declaredOrigins: config.declaredOrigins,
      allowedHostnames: config.allowedHostnames,
      authPublicBaseUrl: config.authPublicBaseUrl,
      env,
      ssoProviders,
    });
  }

  it("warns that TLS-door users are signed out once when the legacy auth URL was http", () => {
    const env: OriginEnv = {
      PAPERCLIP_CANONICAL_ORIGIN: `https://${TAILNET}:3112`,
      PAPERCLIP_ORIGINS: `https://${TAILNET}:3112,http://${LAN_IP}:3102`,
      PAPERCLIP_PUBLIC_URL: `http://${LAN_IP}:3102`,
    };
    const report = declaredReport(env);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/TLS door\(s\) https:\/\/office-mini\.tail0000\.ts\.net:3112 now use the __Secure- cookie name.*signed out once/),
      ]),
    );
  });

  it("says nothing about a sign-out when the legacy auth URL was already https", () => {
    const env: OriginEnv = {
      PAPERCLIP_CANONICAL_ORIGIN: `https://${TAILNET}:3112`,
      PAPERCLIP_ORIGINS: `https://${TAILNET}:3112`,
      PAPERCLIP_AUTH_PUBLIC_BASE_URL: `https://${TAILNET}:3112`,
    };
    expect(declaredReport(env).warnings.join("\n")).not.toMatch(/signed out once/);
  });

  it("warns that SSO only completes from the canonical scheme when another scheme is declared", () => {
    const env: OriginEnv = {
      PAPERCLIP_CANONICAL_ORIGIN: `https://${TAILNET}:3112`,
      PAPERCLIP_ORIGINS: `https://${TAILNET}:3112,http://${LAN_IP}:3102`,
      PAPERCLIP_AUTH_PUBLIC_BASE_URL: `https://${TAILNET}:3112`,
    };
    expect(declaredReport(env).warnings.join("\n")).not.toMatch(/Single sign-on/);
    const warnings = declaredReport(env, ["google"]).warnings;
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`Single sign-on \\(google\\) only completes when started on the canonical origin .*started on http://${LAN_IP.replace(/\./g, "\\.")}:3102`)),
      ]),
    );
  });
});

describe("minting per audience", () => {
  const KEYS = [
    "PAPERCLIP_CANONICAL_ORIGIN",
    "PAPERCLIP_ORIGINS",
    "PAPERCLIP_PUBLIC_URL",
    "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_BASE_URL",
    "BETTER_AUTH_TRUSTED_ORIGINS",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    registerMintingOrigins(null);
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    registerMintingOrigins(null);
  });

  function fakeRequest(headers: Record<string, string>, protocol = "http", remoteAddress = "10.0.0.99") {
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return { protocol, header: (name: string) => lower[name.toLowerCase()], socket: { remoteAddress } };
  }

  it("prefers PAPERCLIP_CANONICAL_ORIGIN over the old public URL for out-of-band links", () => {
    process.env.PAPERCLIP_PUBLIC_URL = `http://${LAN_IP}:3102`;
    process.env.PAPERCLIP_CANONICAL_ORIGIN = "https://Agents.Example.Test/";
    expect(configuredPublicBaseUrl()).toBe("https://agents.example.test");
  });

  it("echoes a declared door the caller used", () => {
    process.env.PAPERCLIP_CANONICAL_ORIGIN = "https://agents.example.test";
    process.env.PAPERCLIP_ORIGINS = `https://agents.example.test,http://${LAN_IP}:3102`;
    const req = fakeRequest({ host: `${LAN_IP}:3102` });

    expect(inBandBaseUrl(req)).toBe(`http://${LAN_IP}:3102`);
    // The email for the same request is read somewhere else: canonical.
    expect(outOfBandBaseUrl(req)).toBe("https://agents.example.test");
  });

  it("answers a spoofed Host or X-Forwarded-Host with the canonical", () => {
    process.env.PAPERCLIP_CANONICAL_ORIGIN = "https://agents.example.test";
    process.env.PAPERCLIP_ORIGINS = `http://${LAN_IP}:3102`;

    expect(inBandBaseUrl(fakeRequest({ host: "evil.example.test" }))).toBe("https://agents.example.test");
    expect(inBandBaseUrl(fakeRequest({
      host: `${LAN_IP}:3102`,
      "x-forwarded-host": "evil.example.test",
      "x-forwarded-proto": "https",
    }))).toBe("https://agents.example.test");
    // A trusted host on a scheme/port nobody declared is not trusted either.
    expect(inBandBaseUrl(fakeRequest({ host: `${LAN_IP}:3112` }, "https"))).toBe("https://agents.example.test");
  });

  it("uses the registered trusted set when boot has provided one", () => {
    process.env.PAPERCLIP_PUBLIC_URL = `http://${LAN_IP}:3102`;
    registerMintingOrigins([`https://${TAILNET}:3112`, `http://${LAN_IP}:3102`]);

    expect(inBandBaseUrl(fakeRequest({ host: `${TAILNET}:3112`, "x-forwarded-proto": "https" })))
      .toBe(`https://${TAILNET}:3112`);
    expect(inBandBaseUrl(fakeRequest({ host: "evil.example.test" }))).toBe(`http://${LAN_IP}:3102`);
  });

  it("echoes a loopback caller on this machine, as before, so on-box links and the OpenClaw loopback diagnostic still work", () => {
    process.env.PAPERCLIP_PUBLIC_URL = `http://${LAN_IP}:3102`;
    registerMintingOrigins([`http://${LAN_IP}:3102`]);

    expect(inBandBaseUrl(fakeRequest({ host: "127.0.0.1:3102" }, "http", "127.0.0.1"))).toBe("http://127.0.0.1:3102");
    expect(inBandBaseUrl(fakeRequest({ host: "localhost:3102" }, "http", "::ffff:127.0.0.1"))).toBe("http://localhost:3102");
    expect(inBandBaseUrl(fakeRequest({ host: "[::1]:3102" }, "http", "::1"))).toBe("http://[::1]:3102");
    // A remote client merely claiming a loopback Host is not a loopback caller.
    expect(inBandBaseUrl(fakeRequest({ host: "localhost:3102" }, "http", "10.0.0.99"))).toBe(`http://${LAN_IP}:3102`);
    // A loopback connection (e.g. the proxy) naming a non-loopback host is judged by the trusted set.
    expect(inBandBaseUrl(fakeRequest({ host: "evil.example.test" }, "http", "127.0.0.1"))).toBe(`http://${LAN_IP}:3102`);
  });

  it("with nothing configured still answers with the request's own origin, as before", () => {
    const req = fakeRequest({ host: "paperclip.example", "x-forwarded-proto": "https" });
    expect(inBandBaseUrl(req)).toBe("https://paperclip.example");
    expect(outOfBandBaseUrl(req)).toBe("https://paperclip.example");
    expect(inBandBaseUrl(fakeRequest({}))).toBe("");
  });
});

// AgentDash (launch lane D): a hosted box behind the edge router. The box
// env is what cloud/src/railway/provisioner.ts writes: the public name in
// PAPERCLIP_PUBLIC_URL and the auth base URL, and the Railway host beside it
// in PAPERCLIP_ALLOWED_HOSTNAMES. The edge sends Host = the Railway host, and
// Railway's own edge rewrites X-Forwarded-Host to the Railway host as well.
describe("hosted box behind the edge", () => {
  const PUBLIC = "https://acme.agentdash.cloud";
  const RAILWAY = "web-production-1234.up.railway.app";
  const BOX_ENV: OriginEnv = {
    PAPERCLIP_PUBLIC_URL: PUBLIC,
    PAPERCLIP_AUTH_PUBLIC_BASE_URL: PUBLIC,
    PAPERCLIP_ALLOWED_HOSTNAMES: `acme.agentdash.cloud,${RAILWAY}`,
  };
  const KEYS = [
    "PAPERCLIP_CANONICAL_ORIGIN",
    "PAPERCLIP_ORIGINS",
    "PAPERCLIP_PUBLIC_URL",
    "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
    "PAPERCLIP_ALLOWED_HOSTNAMES",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_BASE_URL",
    "BETTER_AUTH_TRUSTED_ORIGINS",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    Object.assign(process.env, BOX_ENV);
    registerMintingOrigins(null);
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    registerMintingOrigins(null);
  });

  function edgeRequest(headers: Record<string, string> = {}) {
    const lower: Record<string, string> = {
      host: RAILWAY,
      "x-forwarded-host": RAILWAY,
      "x-agentdash-forwarded-host": "acme.agentdash.cloud",
      "x-forwarded-proto": "https",
      ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
    };
    return { protocol: "http", header: (name: string) => lower[name.toLowerCase()], socket: { remoteAddress: "10.250.0.7" } };
  }

  function bootAs(env: OriginEnv) {
    const config = configFrom(env);
    const trusted = resolveAuthTrustedOrigins(config, { listenPort: 3100, env });
    registerMintingOrigins(mintingOriginsForBoot(trusted, config.authPublicBaseUrl, env));
    return trusted;
  }

  it("still trusts the Railway host for sign-in, but never mints links on it", () => {
    const trusted = bootAs(BOX_ENV);
    expect(trusted.mode).toBe("legacy");
    expect(trusted.origins).toContain(`https://${RAILWAY}`);

    const req = edgeRequest();
    expect(inBandBaseUrl(req)).toBe(PUBLIC);
    expect(outOfBandBaseUrl(req)).toBe(PUBLIC);
  });

  it("answers a request on the public name with the public name", () => {
    bootAs(BOX_ENV);
    expect(inBandBaseUrl(edgeRequest({ host: "acme.agentdash.cloud", "x-forwarded-host": "acme.agentdash.cloud" })))
      .toBe(PUBLIC);
  });

  it("before boot registers anything, the env-derived set excludes allowed hostnames too", () => {
    expect(inBandBaseUrl(edgeRequest())).toBe(PUBLIC);
  });

  it("still echoes a door the operator declared as a full origin in legacy mode", () => {
    const env: OriginEnv = { ...BOX_ENV, BETTER_AUTH_TRUSTED_ORIGINS: "https://acme-alt.example.test" };
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = env.BETTER_AUTH_TRUSTED_ORIGINS;
    bootAs(env);
    expect(inBandBaseUrl(edgeRequest({ host: "acme-alt.example.test", "x-forwarded-host": "acme-alt.example.test" })))
      .toBe("https://acme-alt.example.test");
  });

  it("falls back to the request host when no public URL is configured (local dev)", () => {
    for (const key of KEYS) delete process.env[key];
    const env: OriginEnv = { PAPERCLIP_ALLOWED_HOSTNAMES: RAILWAY };
    bootAs(env);
    expect(inBandBaseUrl(edgeRequest())).toBe(`https://${RAILWAY}`);
  });
});
