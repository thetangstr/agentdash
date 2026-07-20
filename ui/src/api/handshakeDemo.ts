import { api } from "./client";

// Client for the turnkey Agent Trust Handshake demo (board-authed).
// The server contract is step-based + idempotent: each POST /handshake-demo/go
// advances the scripted-real flow one step and PAUSES at the two human
// approval gates. Every live Clockchain MCP call made during the advance is
// returned as `clockchainCalls` so the demo surface can show exactly what the
// gateway returned. See server/src/routes/handshake-demo.ts.

export type HandshakeStepStatus = "done" | "waiting_approval" | "ready" | "blocked";

export type ZkPermissionProof = {
  scheme: string;
  proofHash: string;
  publicSignals: {
    authority: string;
    scope: string;
    validAt: number;
    nullifier: string;
  };
  anchored: boolean;
  note?: string;
};

// Per-step metadata the server returns alongside a run (optional — older
// responses omit it, so treat every field as best-effort).
export type StepMeta = {
  estimateSeconds?: number;
  label?: string;
  human?: boolean;
};

// One line of the on-chain anchoring lifecycle (mandate step).
export type AnchoringLifecycleItem = {
  label: string;
  done: boolean;
  detail?: string;
};

export type AnchoringEvidence = {
  ledgerId: string;
  blockHeight: number | null;
  confirmed: boolean;
  lifecycle: AnchoringLifecycleItem[];
  // Present only while NOT confirmed — explains the single-validator lag.
  note?: string;
};

export type HandshakeEvidence = {
  mandateId?: string;
  ledgerId?: string;
  blockHeight?: number | null;
  eventHash?: string;
  counterpartyDid?: string;
  grantorAgent?: string;
  grantorReasoning?: string;
  granteeAgent?: string;
  granteeReasoning?: string;
  zkPermissionProof?: ZkPermissionProof;
  // Newer contract fields (all optional):
  anchoring?: AnchoringEvidence; // on the mandate step
  reasoningSeconds?: number; // seconds the real model took to decide
  decision?: string; // clean one-line verdict, e.g. "APPROVE: within cap and scope"
  // Other keys (payer/payee/reachable/…) can appear too.
  [key: string]: unknown;
};

export type HandshakeStep = {
  key: string;
  title: string;
  status: HandshakeStepStatus;
  detail?: string;
  approvalId?: string;
  evidence?: HandshakeEvidence;
};

export type ClockchainCall = {
  tool: string;
  endpoint: string;
  requestArgs: Record<string, unknown>;
  status: "ok" | "error";
  latencyMs: number;
  response?: unknown;
  rawResponse?: string;
  error?: string;
};

export type HandshakeAdvanceResult = {
  steps: HandshakeStep[];
  done: boolean;
  clockchainCalls: ClockchainCall[];
  // Per-step timing/labels, keyed by step key (seed, discover, onboard, …).
  // Optional so the UI degrades gracefully on older responses.
  stepMeta?: Record<string, StepMeta>;
};

export type HandshakeResetResult = {
  reset: boolean;
  companies: number;
};

export const handshakeDemoApi = {
  // Advance the demo one step. Resolves the two gates via approve() below.
  go: () => api.post<HandshakeAdvanceResult>("/handshake-demo/go", {}),
  // Resolve a human-in-the-loop approval gate. Body {} — board-authed.
  approve: (approvalId: string) => api.post<unknown>(`/approvals/${approvalId}/approve`, {}),
  // Clear the prior run's server state (mandate/attestations/approvals/ZK
  // proofs) so a new run genuinely starts from step 1. Companies + agents
  // persist, so the /:company/handshake URL stays valid.
  reset: () => api.post<HandshakeResetResult>("/handshake-demo/reset", {}),
};
