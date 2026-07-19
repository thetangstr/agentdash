// First real Clockchain MCP client in AgentDash. Server-side only.
// Flag-gated; NEVER on an agent run's critical path (spec §B, §B2).
// NOTE: authorization is AgentDash-enforced, not Clockchain-enforced.
// Field mappings verified live against mcp.clockchain.network tools/list (2026-07-17).

import { createHash } from "node:crypto";

const MCP_URL = () => process.env.CLOCKCHAIN_MCP_URL || "https://mcp.clockchain.network/mcp";
const MCP_KEY = () => process.env.CLOCKCHAIN_MCP_KEY || "";
const TIMEOUT_MS = () => Number(process.env.CLOCKCHAIN_MCP_TIMEOUT_MS ?? 10000);
// Proceed with writes while the validator pool is degraded (testnet/demo policy).
// Off by default — mainnet leaves this false so degraded writes are refused,
// never silently reported as anchored.
const ALLOW_DEGRADED = () => process.env.CLOCKCHAIN_ALLOW_DEGRADED === "true";
const degradedWrite = (): Record<string, unknown> => (ALLOW_DEGRADED() ? { allow_degraded: true } : {});

export function clockchainEnabled(): boolean {
  return process.env.AGENTDASH_ATTESTATION_ENABLED === "true" && MCP_KEY().length > 0;
}

export type DelegateAuthorityInput = { parentDid: string; childDid: string; scope: string[]; until: string };
export type DelegateAuthorityResult = { anchored: boolean; ledgerId?: string; blockHeight?: number };
export type DelegationVerdict = { status: "authorized" | "unauthorized" | "unavailable"; reason?: string; ledgerId?: string; scope?: string[]; spendCapCents?: number };

export type AttestResult = {
  attested: boolean;
  ledgerId?: string;
  blockHeight?: number;
  eventHash?: string;
  status?: "anchored" | "pending" | "degraded";
};

// Minimal StreamableHTTP JSON-RPC tools/call, SSE-frame tolerant (mirrors
// clockchain-research/src/lib/mcp-client.ts). Returns the parsed tool result
// object, or throws — callers wrap so nothing propagates to a critical path.
async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  // Timeout/abort so a hanging gateway can never stall a caller. On abort,
  // fetch rejects -> the caller's try/catch returns the safe degraded value.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
  try {
    const res = await fetch(MCP_URL(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": MCP_KEY() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: controller.signal,
    });
    const raw = await res.text();
    const json = parseRpc(raw);
    // Gateway signals tool errors as HTTP 200 + { isError: true } content — surface as a thrown
    // so callers' catch returns the safe degraded value (never a silent false-positive).
    const text = json?.result?.content?.[0]?.text;
    if (json?.result?.isError) throw new Error(typeof text === "string" ? text : "clockchain tool error");
    if (typeof text === "string") { try { return JSON.parse(text); } catch { return { text }; } }
    return json?.result ?? {};
  } finally {
    clearTimeout(timer);
  }
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
  // Mandate grant: anchor {parent_did, child_did, scope[], until}.
  async function delegateAuthority(input: DelegateAuthorityInput): Promise<DelegateAuthorityResult> {
    if (!clockchainEnabled()) return { anchored: false };
    try {
      const r = await callTool("delegate_authority", {
        parent_did: input.parentDid, child_did: input.childDid, scope: input.scope, until: input.until, ...degradedWrite(),
      });
      const ledgerId = r.ledgerId ?? r.anchor?.ledgerId;
      if (!ledgerId) return { anchored: false };
      return { anchored: true, ledgerId, blockHeight: r.blockHeight ?? r.anchor?.blockHeight };
    } catch { return { anchored: false }; }
  }

  // Confirm a ledger entry is real + anchored on-chain (used to verify a mandate's grant anchor).
  async function getLogEntry(ledgerId: string): Promise<{ found: boolean; anchored: boolean; blockHeight?: number; status?: string }> {
    if (!clockchainEnabled()) return { found: false, anchored: false };
    try {
      const r = await callTool("get_log_entry", { ledger_id: ledgerId });
      if (!r || !r.ledgerId) return { found: false, anchored: false };
      const status = r.status ?? r.anchorStatus;
      return { found: true, anchored: status === "anchored" || Boolean(r.blockHeight), blockHeight: r.blockHeight, status };
    } catch { return { found: false, anchored: false }; }
  }

  // Provision an agent identity. The gateway requires the caller to supply the did + document.
  // We derive a stable did from the agentId so re-grants are idempotent per agent.
  async function mintIdentity(input: { agentId: string; name?: string; metadata?: Record<string, unknown> }): Promise<{ minted: boolean; did?: string; ledgerId?: string }> {
    if (!clockchainEnabled()) return { minted: false };
    try {
      // Derive a stable, did-safe did from the agentId. The gateway rejects long/UUID-form
      // did segments in delegate_authority (verified live), so use a short dash-free hash.
      const did = `did:clockchain:agentdash:${createHash("sha256").update(input.agentId).digest("hex").slice(0, 16)}`;
      const document = { kind: "agent", name: input.name ?? "agent", agentId: input.agentId, ...(input.metadata ?? {}) };
      const r = await callTool("mint_identity", { did, document, ...degradedWrite() });
      const ok = Boolean(r.did ?? r.docHash ?? r.ledgerId);
      if (!ok) return { minted: false };
      return { minted: true, did: r.did ?? did, ledgerId: r.ledgerId ?? r.anchor?.ledgerId };
    } catch { return { minted: false }; }
  }

  async function resolveAgent(did: string): Promise<{ found: boolean; did?: string }> {
    if (!clockchainEnabled()) return { found: false };
    try {
      const r = await callTool("resolve_agent", { agent_id: did });
      const resolved = r.did ?? r.identity?.did;
      return resolved ? { found: true, did: resolved } : { found: false };
    } catch { return { found: false }; }
  }

  // KYA: is this counterparty identity valid right now (valid-at-T)?
  async function verifyIdentityAt(input: { did: string; at: string }): Promise<{ status: "valid" | "invalid" | "unavailable" }> {
    if (!clockchainEnabled()) return { status: "unavailable" };
    try {
      const r = await callTool("verify_identity_at", { did: input.did, at: input.at });
      const valid = r.authorized ?? r.valid;
      return { status: valid ? "valid" : "invalid" };
    } catch { return { status: "unavailable" }; }
  }

  // Attest an action as the agent — returns a self-verifying receipt.
  async function attestAction(input: { agentDid: string; action: string; inputs?: Record<string, unknown>; outputs?: Record<string, unknown> }): Promise<AttestResult> {
    if (!clockchainEnabled()) return { attested: false };
    try {
      const r = await callTool("attest_action", {
        agent_id: input.agentDid, action: input.action, inputs: input.inputs ?? {}, outputs: input.outputs ?? {}, ...degradedWrite(),
      });
      const ledgerId = r.ledgerId ?? r.anchor?.ledgerId;
      const eventHash = r.eventHash;
      if (!ledgerId && !eventHash) return { attested: false };
      const blockHeight = r.blockHeight ?? r.anchor?.blockHeight;
      const status = (r.status ?? r.anchor?.status) as ("anchored" | "pending" | "degraded" | undefined);
      // Default from blockHeight, NOT ledgerId: a ledgerId without a confirmed block is "pending"
      // (submitted but not anchored). Defaulting it to "anchored" would be a false positive.
      return { attested: true, ledgerId, eventHash, blockHeight, status: status ?? (blockHeight != null ? "anchored" : "pending") };
    } catch { return { attested: false }; }
  }

  return { delegateAuthority, getLogEntry, mintIdentity, resolveAgent, verifyIdentityAt, attestAction };
}
