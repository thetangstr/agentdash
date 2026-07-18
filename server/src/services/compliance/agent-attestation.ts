// Typed wrapper for "every agent action emits a Clockchain attestation".
// This is the company-wide adoption entry point: any service (billing,
// approvals, identity, news-ingest, …) can call `attestAgentAction` to
// anchor an action on the Clockchain ledger and get back an
// independently-verifiable Agent Attested Receipt.
//
// Goals:
//   - One-line adoption for callers (`attestAgentAction({ agentId, action, inputs, outputs })`).
//   - Wait=false by default for hot paths (submit without blocking; poll
//     with `completeAgentAttestation` later). Wait=true is for cold paths
//     where the caller needs the confirmed receipt before continuing.
//   - Idempotency keys default to a stable hash of (agentId, action,
//     inputs, outputs) so retries don't double-charge the log budget.
//   - Errors are surfaced — never swallowed — so a missed attestation is
//     recorded as a failure rather than a receiptless success.
import { createHash } from "node:crypto";
import type { ClockchainClient, NormalizedReceipt } from "./clockchain-client.js";
import { normalizeReceipt } from "./clockchain-client.js";

export interface AgentActionInput {
  agentId: string;
  /** Stable verb-noun identifier, e.g. "billing.disburse", "approval.sign". */
  action: string;
  /** The exact decision inputs that produced the action (fingerprint-bound). */
  inputs: Record<string, unknown>;
  /** The exact decision outputs the action produced. */
  outputs: Record<string, unknown>;
  /** Block until confirmed on-chain. Default false (submit, don't block). */
  wait?: boolean;
  /** Max ms to wait for confirmation when wait=true. Default 15000. */
  waitMs?: number;
  /** Override the auto-derived idempotency key for retry safety. */
  idempotencyKey?: string;
}

export interface AgentAttestationReceipt {
  /** The raw receipt payload as returned by the MCP (clockchain.receipt/v1). */
  raw: Record<string, unknown>;
  /** Flattened receipt columns for our audit tables. */
  normalized: NormalizedReceipt;
  /** Whether the receipt has been confirmed on-chain (blockHeight populated). */
  confirmed: boolean;
  /** The idempotency key the caller can reuse to safely retry. */
  idempotencyKey: string;
}

// SHA-256 hex of the canonicalized payload — same input → same key → safe
// retries. We canonicalize via deep sorted-keys because object key order is
// otherwise nondeterministic across runtimes, and JSON.stringify's array
// replacer only filters top-level keys (nested keys with different names
// would be silently dropped, producing identical hashes for distinct payloads).
function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = deepSortKeys(obj[k]);
      return acc;
    }, {});
  }
  return value;
}

function deriveIdempotencyKey(payload: {
  agentId: string;
  action: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify(deepSortKeys(payload));
  return createHash("sha256").update(canonical).digest("hex");
}

function isConfirmed(receipt: Record<string, unknown>): boolean {
  const anchor = (receipt.anchor && typeof receipt.anchor === "object"
    ? receipt.anchor : {}) as Record<string, unknown>;
  const blockHeight = anchor.blockHeight ?? receipt.blockHeight;
  return typeof blockHeight === "string" && blockHeight.length > 0 && blockHeight !== "null";
}

export async function attestAgentAction(
  client: ClockchainClient,
  req: AgentActionInput,
): Promise<AgentAttestationReceipt> {
  const idempotencyKey = req.idempotencyKey ?? deriveIdempotencyKey({
    agentId: req.agentId,
    action: req.action,
    inputs: req.inputs,
    outputs: req.outputs,
  });
  const raw = await client.attest("attest_action", {
    agent_id: req.agentId,
    action: req.action,
    inputs: req.inputs,
    outputs: req.outputs,
    wait: req.wait ?? false,
    wait_ms: req.waitMs,
    idempotency_key: idempotencyKey,
  });
  return {
    raw,
    normalized: normalizeReceipt(raw),
    confirmed: isConfirmed(raw),
    idempotencyKey,
  };
}

/** Poll half of the non-blocking submit path. Returns the same shape as attestAgentAction. */
export async function completeAgentAttestation(
  client: ClockchainClient,
  pendingReceipt: AgentAttestationReceipt,
): Promise<AgentAttestationReceipt> {
  const raw = await client.attest("complete_attestation", { receipt: pendingReceipt.raw });
  return {
    raw,
    normalized: normalizeReceipt(raw),
    confirmed: isConfirmed(raw),
    idempotencyKey: pendingReceipt.idempotencyKey,
  };
}

/**
 * Keyless, third-party verification — what an outside auditor runs with NO
 * Clockchain account. Goes against the IMMUTABLE on-chain block, so a
 * tampered record cache cannot redirect the check.
 */
export async function verifyAgentReceipt(
  client: ClockchainClient,
  receipt: AgentAttestationReceipt | Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = "raw" in receipt ? receipt.raw : receipt;
  return client.attest("verify_receipt", { receipt: payload });
}