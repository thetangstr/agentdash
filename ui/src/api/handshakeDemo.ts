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
  // Other keys (payer/payee/reachable/decision/…) can appear too.
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
};

export const handshakeDemoApi = {
  // Advance the demo one step. Resolves the two gates via approve() below.
  go: () => api.post<HandshakeAdvanceResult>("/handshake-demo/go", {}),
  // Resolve a human-in-the-loop approval gate. Body {} — board-authed.
  approve: (approvalId: string) => api.post<unknown>(`/approvals/${approvalId}/approve`, {}),
};
