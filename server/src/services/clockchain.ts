// First real Clockchain MCP client in AgentDash. Server-side only.
// Flag-gated; NEVER on an agent run's critical path (spec §B, §B2).
// NOTE: authorization is AgentDash-enforced, not Clockchain-enforced.

const MCP_URL = () => process.env.CLOCKCHAIN_MCP_URL || "https://mcp.clockchain.network/mcp";
const MCP_KEY = () => process.env.CLOCKCHAIN_MCP_KEY || "";

export function clockchainEnabled(): boolean {
  return process.env.AGENTDASH_ATTESTATION_ENABLED === "true" && MCP_KEY().length > 0;
}

export type DelegateAuthorityInput = { parentDid: string; childDid: string; scope: Record<string, unknown>; until: string };
export type DelegateAuthorityResult = { anchored: boolean; ledgerId?: string; blockHeight?: number; scheme?: string };
export type VerifyDelegationInput = DelegateAuthorityInput & { at: string; ledgerId?: string; blockHeight?: number };
export type DelegationVerdict = { status: "authorized" | "unauthorized" | "unavailable"; reason?: string; grantedAt?: string; expiresAt?: string; revokedAt?: string; ledgerId?: string };

// Minimal StreamableHTTP JSON-RPC tools/call, SSE-frame tolerant (mirrors
// clockchain-research/src/lib/mcp-client.ts). Returns the parsed tool result
// object, or throws — callers wrap so nothing propagates to a critical path.
async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(MCP_URL(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": MCP_KEY() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const json = parseRpc(raw);
  const text = json?.result?.content?.[0]?.text;
  if (typeof text === "string") { try { return JSON.parse(text); } catch { return { text }; } }
  return json?.result ?? {};
}

function parseRpc(raw: string): any {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // SSE: take the last `data:` line
  const lines = trimmed.split("\n").filter((l) => l.startsWith("data:"));
  const last = lines[lines.length - 1]?.slice(5).trim();
  return last ? JSON.parse(last) : {};
}

export function clockchainService() {
  async function delegateAuthority(input: DelegateAuthorityInput): Promise<DelegateAuthorityResult> {
    if (!clockchainEnabled()) return { anchored: false };
    try {
      const r = await callTool("delegate_authority", {
        parent: input.parentDid, child: input.childDid, scope: input.scope, until: input.until,
      });
      const ledgerId = r.ledgerId ?? r.anchor?.ledgerId;
      if (!ledgerId) return { anchored: false };
      return { anchored: true, ledgerId, blockHeight: r.blockHeight ?? r.anchor?.blockHeight, scheme: r.scheme ?? r.anchor?.scheme };
    } catch { return { anchored: false }; }
  }

  async function verifyDelegationAt(input: VerifyDelegationInput): Promise<DelegationVerdict> {
    if (!clockchainEnabled()) return { status: "unavailable" };
    try {
      const r = await callTool("verify_delegation_at", {
        parent_did: input.parentDid, child_did: input.childDid, scope: input.scope,
        until: input.until, at: input.at, ledger_id: input.ledgerId, block_height: input.blockHeight,
      });
      const authorized = r.authorized ?? r.valid;
      return {
        status: authorized ? "authorized" : "unauthorized",
        reason: r.reason,
        grantedAt: r.grantedAt, expiresAt: r.expiresAt, revokedAt: r.revokedAt,
        ledgerId: r.evidence?.delegationLedgerId ?? input.ledgerId,
      };
    } catch { return { status: "unavailable" }; }
  }

  return { delegateAuthority, verifyDelegationAt };
}
