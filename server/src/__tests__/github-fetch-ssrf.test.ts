// AgentDash: GH #709 — SSRF guards on the GitHub fetch used by company import.
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import {
  allowedGitHubFetchHosts,
  assertAllowedGitHubSourceUrl,
  createGitHubFetch,
  isNonPublicAddress,
  type GitHubTransportRequest,
  type GitHubTransportResponse,
  type ResolvedAddress,
} from "../services/github-fetch.js";

const GITHUB_IP = "140.82.112.3";

function publicDns(overrides: Record<string, string[]> = {}) {
  return vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const addresses = overrides[hostname] ?? [GITHUB_IP];
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
}

function reply(
  status: number,
  body: string | Buffer = "",
  headers: Record<string, string> = {},
): GitHubTransportResponse {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return {
    status,
    statusText: "",
    headers,
    body: (async function* () {
      // Deliver in chunks so the streaming size bound is exercised.
      for (let i = 0; i < buf.length; i += 1024) yield buf.subarray(i, i + 1024);
    })(),
    discard: vi.fn(),
  };
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected the fetch to be rejected");
}

describe("ghFetch SSRF guards (GH #709)", () => {
  it("fetches a github.com raw path over a pinned, validated address", async () => {
    const lookup = publicDns();
    const transport = vi.fn(async (_req: GitHubTransportRequest) => reply(200, "# COMPANY\n", { "content-type": "text/plain" }));
    const fetcher = createGitHubFetch({ lookup, transport, env: {} });

    const res = await fetcher("https://raw.githubusercontent.com/acme/pkg/main/COMPANY.md");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# COMPANY\n");
    expect(lookup).toHaveBeenCalledWith("raw.githubusercontent.com");
    const sent = transport.mock.calls[0]![0];
    expect(sent.address.address).toBe(GITHUB_IP);
    expect(sent.url.hostname).toBe("raw.githubusercontent.com");
    expect(sent.method).toBe("GET");
    // api.github.com rejects requests without a User-Agent; node:https sends none by default.
    expect(sent.headers["user-agent"]).toBe("AgentDash");
  });

  it("follows a same-family redirect (api.github.com -> codeload.github.com)", async () => {
    const transport = vi
      .fn<(req: GitHubTransportRequest) => Promise<GitHubTransportResponse>>()
      .mockResolvedValueOnce(reply(302, "", { location: "https://codeload.github.com/acme/pkg/tar.gz/main" }))
      .mockResolvedValueOnce(reply(200, "ok"));
    const fetcher = createGitHubFetch({ lookup: publicDns(), transport, env: {} });

    const res = await fetcher("https://api.github.com/repos/acme/pkg/tarball/main", {
      headers: { authorization: "Bearer secret" },
    });

    expect(await res.text()).toBe("ok");
    expect(transport).toHaveBeenCalledTimes(2);
    // Credentials are never carried to a different host.
    expect(transport.mock.calls[1]![0].headers.authorization).toBeUndefined();
  });

  it("rejects a non-allowlisted host without resolving or connecting", async () => {
    const lookup = publicDns();
    const transport = vi.fn();
    const fetcher = createGitHubFetch({ lookup, transport, env: {} });

    const err = await rejection(fetcher("https://attacker.example/acme/pkg/raw/main/COMPANY.md"));

    expect(err.status).toBe(400);
    expect(err.code).toBe("GITHUB_SOURCE_HOST_NOT_ALLOWED");
    expect(lookup).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects http, non-default ports and embedded credentials even on github hosts", async () => {
    const fetcher = createGitHubFetch({ lookup: publicDns(), transport: vi.fn(), env: {} });
    expect((await rejection(fetcher("http://github.com/acme/pkg"))).status).toBe(400);
    expect((await rejection(fetcher("https://github.com:8443/acme/pkg"))).status).toBe(400);
    expect((await rejection(fetcher("https://user:pw@github.com/acme/pkg"))).status).toBe(400);
  });

  it.each([
    ["http://127.0.0.1:8080/admin"],
    ["http://169.254.169.254/latest/meta-data/"],
    ["https://169.254.169.254/latest/meta-data/"],
    ["https://localhost/admin"],
  ])("rejects a redirect to %s", async (location) => {
    const transport = vi.fn(async () => reply(302, "", { location }));
    const fetcher = createGitHubFetch({ lookup: publicDns(), transport, env: {} });

    const err = await rejection(fetcher("https://raw.githubusercontent.com/acme/pkg/main/COMPANY.md"));

    expect(err.status).toBe(422);
    expect(err.code).toBe("422");
    expect((err.details as { code?: string }).code).toBe("GITHUB_FETCH_REDIRECT_BLOCKED");
    // Only the first hop was ever requested.
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to an operator-allowed host that resolves to the metadata address", async () => {
    const transport = vi.fn(async () => reply(302, "", { location: "https://ghe.internal.example/x" }));
    const fetcher = createGitHubFetch({
      lookup: publicDns({ "ghe.internal.example": ["169.254.169.254"] }),
      transport,
      env: { AGENTDASH_GITHUB_ALLOWED_HOSTS: "ghe.internal.example" },
    });

    const err = await rejection(fetcher("https://api.github.com/repos/acme/pkg"));

    expect(err.status).toBe(422);
    expect((err.details as { code?: string }).code).toBe("GITHUB_FETCH_PRIVATE_ADDRESS");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects an allowed hostname whose DNS answer is private (rebinding)", async () => {
    const transport = vi.fn();
    const fetcher = createGitHubFetch({
      lookup: publicDns({ "github.com": [GITHUB_IP, "10.0.0.5"] }),
      transport,
      env: {},
    });

    const err = await rejection(fetcher("https://github.com/acme/pkg"));

    expect(err.status).toBe(422);
    expect((err.details as { code?: string }).code).toBe("GITHUB_FETCH_PRIVATE_ADDRESS");
    expect(transport).not.toHaveBeenCalled();
  });

  it("stops after the maximum number of redirect hops", async () => {
    const transport = vi.fn(async () => reply(301, "", { location: "https://github.com/acme/pkg" }));
    const fetcher = createGitHubFetch({ lookup: publicDns(), transport, env: {}, maxRedirects: 3 });

    const err = await rejection(fetcher("https://github.com/acme/pkg"));

    expect((err.details as { code?: string }).code).toBe("GITHUB_FETCH_TOO_MANY_REDIRECTS");
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("rejects an oversized response by declared length", async () => {
    const big = reply(200, "x", { "content-length": String(10_000) });
    const fetcher = createGitHubFetch({ lookup: publicDns(), transport: vi.fn(async () => big), env: {}, maxResponseBytes: 4096 });

    const err = await rejection(fetcher("https://raw.githubusercontent.com/acme/pkg/main/big.md"));

    expect((err.details as { code?: string }).code).toBe("GITHUB_FETCH_RESPONSE_TOO_LARGE");
    expect(big.discard).toHaveBeenCalled();
  });

  it("rejects an oversized response streamed without a length", async () => {
    const big = reply(200, Buffer.alloc(10_000, 0x61));
    const fetcher = createGitHubFetch({ lookup: publicDns(), transport: vi.fn(async () => big), env: {}, maxResponseBytes: 4096 });

    const err = await rejection(fetcher("https://raw.githubusercontent.com/acme/pkg/main/big.md"));

    expect((err.details as { code?: string }).code).toBe("GITHUB_FETCH_RESPONSE_TOO_LARGE");
  });

  it("times out a hung request", async () => {
    const transport = vi.fn(
      (req: GitHubTransportRequest) =>
        new Promise<GitHubTransportResponse>((_, reject) => {
          req.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const fetcher = createGitHubFetch({ lookup: publicDns(), transport, env: {}, timeoutMs: 20 });

    const err = await rejection(fetcher("https://api.github.com/repos/acme/pkg"));

    expect((err.details as { code?: string }).code).toBe("GITHUB_FETCH_TIMEOUT");
  });

  it("public policy (plain-URL skill import) allows any public host but still blocks private targets", async () => {
    const transport = vi.fn(async () => reply(200, "---\nname: s\n---\n"));
    const fetcher = createGitHubFetch({
      lookup: publicDns({ "skills.example.com": ["93.184.216.34"], "internal.example.com": ["192.168.1.10"] }),
      transport,
      env: {},
      hostPolicy: "public",
    });

    expect((await fetcher("https://skills.example.com/s/SKILL.md")).status).toBe(200);
    const err = await rejection(fetcher("https://internal.example.com/SKILL.md"));
    expect((err.details as { code?: string }).code).toBe("GITHUB_FETCH_PRIVATE_ADDRESS");
  });
});

describe("GitHub host allowlist", () => {
  it("defaults to the github.com family", () => {
    const hosts = allowedGitHubFetchHosts({});
    for (const host of ["github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com"]) {
      expect(hosts.has(host)).toBe(true);
    }
    expect(hosts.has("gist.githubusercontent.com")).toBe(false);
  });

  it("adds operator-configured GitHub Enterprise hosts and reuses existing GHE settings", () => {
    const hosts = allowedGitHubFetchHosts({
      AGENTDASH_GITHUB_ALLOWED_HOSTS: " ghe.acme.com , https://raw.ghe.acme.com/ ",
      AGENTDASH_GITHUB_API_URL: "https://api.ghe2.acme.com/api/v3",
      AGENTDASH_GITHUB_ISSUES_HOSTNAME: "issues.acme.com",
    });
    expect(hosts.has("ghe.acme.com")).toBe(true);
    expect(hosts.has("raw.ghe.acme.com")).toBe(true);
    expect(hosts.has("api.ghe2.acme.com")).toBe(true);
    expect(hosts.has("issues.acme.com")).toBe(true);
  });

  it("assertAllowedGitHubSourceUrl returns a 400 for a non-allowlisted source", () => {
    expect(() => assertAllowedGitHubSourceUrl("https://evil.example/acme/pkg", {})).toThrow(
      expect.objectContaining({ status: 400, code: "GITHUB_SOURCE_HOST_NOT_ALLOWED" }),
    );
    expect(assertAllowedGitHubSourceUrl("https://github.com/acme/pkg", {}).hostname).toBe("github.com");
  });
});

describe("isNonPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.254",
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(["140.82.112.3", "185.199.108.133", "8.8.8.8", "2606:50c0:8000::154"])("allows %s", (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});
