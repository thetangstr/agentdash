// Public API for the compliance module.
// EU AI Act Art.12 + SEC 17a-4 audit-readiness: the company-wide Clockchain
// attestation surface. Any service can import from here to anchor agent
// actions on the Clockchain ledger and get back independently-verifiable
// Agent Attested Receipts.
export {
  makeClockchainClient,
  normalizeReceipt,
  type ClockchainClient,
  type NormalizedReceipt,
} from "./clockchain-client.js";

export {
  attestAgentAction,
  completeAgentAttestation,
  verifyAgentReceipt,
  type AgentActionInput,
  type AgentAttestationReceipt,
} from "./agent-attestation.js";
// (ci: re-triggered after a flaky verify hang; no functional change)
