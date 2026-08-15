/**
 * Prove the link and the key work together BEFORE writing any config.
 *
 * The failure this prevents is the one people actually hit: config is written,
 * the harness starts, and the mistake surfaces much later as a tool call that
 * quietly does nothing. A wrong key, a typo'd host, and an instance that is
 * simply down all look identical at that point. Here they are three different
 * messages, delivered before anything has been changed on disk.
 */

const PROTOCOL_VERSION = "2024-11-05";

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
