import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeAllAddresses, verifyConnection, VerifyError } from "./verify.mjs";

/**
 * The bug this exists to catch, in miniature.
 *
 * `--check` once reported "working — 72 tools" against a host that real Claude
 * Code could not reach at all: the name resolved IPv6-first, the server was
 * bound IPv4-only, and Node's `fetch` quietly fell back to IPv4. Proving "I got
 * through somehow" certifies a host that half the clients cannot use, so the
 * probe has to ask about every address a client might choose.
 *
 * Measured on the machine where this was written, against a name resolving to
 * both families:
 *   IPv4-only listener  -> ::1 ECONNREFUSED, 127.0.0.1 reachable
 *   dual-stack listener -> both reachable
 */

const servers = [];

function listen(host, port) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => res.end("ok"));
    servers.push(server);
    server.listen(port, host, () => resolve(server));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("probeAllAddresses", () => {
  it("reports a listening address as reachable", async () => {
    await listen("127.0.0.1", 39221);
    const probes = await probeAllAddresses("http://127.0.0.1:39221/api/mcp");
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ address: "127.0.0.1", reachable: true });
  });

  it("reports a closed port as unreachable, with a reason", async () => {
    const probes = await probeAllAddresses("http://127.0.0.1:39222/api/mcp");
    expect(probes[0].reachable).toBe(false);
    expect(probes[0].reason).toBeTruthy();
  });

  it("probes an IP literal without consulting DNS", async () => {
    await listen("::1", 39223);
    const probes = await probeAllAddresses("http://[::1]:39223/api/mcp");
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ family: 6, reachable: true });
  });

  it("says so plainly when the name does not resolve", async () => {
    const probes = await probeAllAddresses("http://nonexistent.invalid:39224/api/mcp");
    expect(probes[0].reachable).toBe(false);
  });
});

describe("verifyConnection", () => {
  it("refuses a host where nothing is listening, before any handshake", async () => {
    await expect(verifyConnection("http://127.0.0.1:39225/api/mcp", "pcp_x")).rejects.toThrow(
      VerifyError,
    );
  });

  it("names the address family when only some addresses answer", async () => {
    // localhost resolves to both ::1 and 127.0.0.1 on a normal machine. Binding
    // only IPv4 reproduces the shipped bug: one family answers, the other does
    // not, and a client picking the wrong one hangs.
    await listen("127.0.0.1", 39226);
    const probes = await probeAllAddresses("http://localhost:39226/api/mcp");
    const families = new Set(probes.map((p) => p.family));
    if (families.size < 2) {
      // Single-family host: the partial-reachability case cannot arise here.
      expect(probes.every((p) => p.reachable)).toBe(true);
      return;
    }
    const failed = probes.filter((p) => !p.reachable);
    expect(failed.length).toBeGreaterThan(0);
    await expect(verifyConnection("http://localhost:39226/api/mcp", "pcp_x")).rejects.toThrow(
      /refuses connections/i,
    );
  });
});
