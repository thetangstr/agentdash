/**
 * Prove the link and the key work together BEFORE writing any config.
 *
 * The failure this prevents is the one people actually hit: config is written,
 * the harness starts, and the mistake surfaces much later as a tool call that
 * quietly does nothing. A wrong key, a typo'd host, and an instance that is
 * simply down all look identical at that point. Here they are three different
 * messages, delivered before anything has been changed on disk.
 */

import dns from "node:dns/promises";
import net from "node:net";

const PROTOCOL_VERSION = "2024-11-05";

/** Link-local addresses need a zone index; nobody dials them by name. */
function isLinkLocal(address) {
  return address.startsWith("fe80:") || address.startsWith("169.254.");
}

/** Can we open a TCP connection to this exact address? */
function probeAddress(address, port, family, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (reachable, reason) => {
      socket.destroy();
      resolve({ address, family, reachable, reason: reason ?? null });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, "timed out"));
    socket.once("error", (err) => done(false, err.code ?? err.message));
    socket.connect({ host: address, port, family });
  });
}

/**
 * Probe EVERY address the hostname resolves to, not just the one this process
 * happens to pick.
 *
 * This exists because of a real failure. `mkmini.local` resolves IPv6-first on
 * macOS; the server was bound IPv4-only; Node's `fetch` quietly fell back to
 * IPv4 and reported a healthy connection, while real Claude Code picked the
 * IPv6 address and hung until it timed out. A checker that only proves "I could
 * reach it somehow" will certify a host that half the clients cannot use. The
 * question worth answering is whether EVERY address a client might choose
 * works.
 *
 * @returns {Promise<{address: string, family: number, reachable: boolean, reason: string|null}[]>}
 */
export async function probeAllAddresses(urlString) {
  const url = new URL(urlString);
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (net.isIP(host)) {
    return [await probeAddress(host, port, net.isIP(host))];
  }

  let resolved;
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch (error) {
    return [{ address: host, family: 0, reachable: false, reason: error.code ?? "DNS lookup failed" }];
  }

  const candidates = resolved.filter((entry) => !isLinkLocal(entry.address));
  if (candidates.length === 0) return [];
  return Promise.all(candidates.map((entry) => probeAddress(entry.address, port, entry.family)));
}

/**
 * Streamable HTTP MCP answers with either JSON or an SSE stream depending on
 * the transport's mood; both carry the same JSON-RPC payload.
 */
async function readRpcBody(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return text ? JSON.parse(text) : null;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice(5).trim();
      if (payload) return JSON.parse(payload);
    }
  }
  return null;
}

async function rpc(endpoint, key, method, params, { timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { response, body: await readRpcBody(response).catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trade a connect code for a device-scoped key.
 *
 * The code is short-lived and single-use, so it is safe to pass on a command
 * line in a way an agent key never is — which is the whole reason this exists.
 * The key that comes back is named for this machine, so it can be revoked here
 * without cutting off anyone else.
 */
export async function redeemConnectCode(instanceUrl, code, deviceName) {
  const endpoint = `${instanceUrl.replace(/\/+$/, "")}/api/connect/redeem`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName }),
    });
  } catch (error) {
    throw new VerifyError(`Could not reach ${instanceUrl}: ${error?.message ?? error}`, {
      hint: "Check the address. On a LAN this is usually a .local name, not an IP.",
    });
  }

  if (response.status === 404) {
    throw new VerifyError("This instance does not support connect codes.", {
      hint: "It may be running an older version. Ask for an agent key instead.",
    });
  }
  if (response.status === 429) {
    throw new VerifyError("Too many attempts. Wait a minute and try again.");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new VerifyError(body?.error ?? `The instance refused the code (HTTP ${response.status}).`, {
      hint: "Codes expire after ten minutes and work only once. Ask for a fresh one.",
    });
  }
  if (!body?.apiKey) {
    throw new VerifyError("The instance accepted the code but returned no key.");
  }
  return body;
}

export class VerifyError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = "VerifyError";
    this.hint = hint ?? null;
  }
}

/**
 * @returns {Promise<{serverName: string|null, serverVersion: string|null, toolCount: number, hasInstructions: boolean}>}
 */
export async function verifyConnection(endpoint, key) {
  // Reachability across every address BEFORE the handshake: a partly-reachable
  // host answers this process fine and strands whichever client resolves it
  // differently, which is the exact failure that shipped once already.
  const probes = await probeAllAddresses(endpoint);
  const unreachable = probes.filter((probe) => !probe.reachable);
  if (probes.length > 0 && unreachable.length === probes.length) {
    throw new VerifyError(`Nothing is listening at ${new URL(endpoint).host}.`, {
      hint: `Tried ${probes.map((p) => p.address).join(", ")}. Is the instance running?`,
    });
  }
  if (unreachable.length > 0) {
    const families = unreachable.map((probe) => `${probe.address} (IPv${probe.family}, ${probe.reason})`);
    throw new VerifyError(
      `${new URL(endpoint).host} resolves to an address that refuses connections: ${families.join(", ")}.`,
      {
        hint:
          "Some clients will pick that address and hang. The server is probably bound to one address family only -- bind it to :: so it serves both.",
      },
    );
  }

  let init;
  try {
    init = await rpc(endpoint, key, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agentdash-connect", version: "0.1.0" },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new VerifyError(`No answer from ${endpoint} within 15s`, {
        hint: "Is the instance running, and are you on the same network?",
      });
    }
    throw new VerifyError(`Could not reach ${endpoint}: ${error?.message ?? error}`, {
      hint: "Check the address. On a LAN this is usually a .local name, not an IP.",
    });
  }

  if (init.response.status === 401 || init.response.status === 403) {
    throw new VerifyError("The instance answered, but rejected that key.", {
      hint: "Keys are shown once when minted. If this one was truncated on copy, mint a new one.",
    });
  }
  if (init.response.status === 404) {
    throw new VerifyError(`No MCP endpoint at ${endpoint}.`, {
      hint: "That instance may predate the built-in MCP endpoint. Check its version.",
    });
  }
  if (!init.response.ok) {
    throw new VerifyError(`${endpoint} returned HTTP ${init.response.status}.`);
  }
  if (init.body?.error) {
    throw new VerifyError(`The server refused the handshake: ${init.body.error.message ?? "unknown error"}`);
  }

  const result = init.body?.result ?? {};
  let toolCount = 0;
  try {
    const listed = await rpc(endpoint, key, "tools/list", {});
    toolCount = listed.body?.result?.tools?.length ?? 0;
  } catch {
    // A working handshake is the thing that matters; a tool count is colour.
  }

  return {
    serverName: result?.serverInfo?.name ?? null,
    serverVersion: result?.serverInfo?.version ?? null,
    toolCount,
    hasInstructions: typeof result?.instructions === "string" && result.instructions.length > 0,
  };
}
