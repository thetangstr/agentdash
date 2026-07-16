// Manual Slice-1 exercise: grant + verify against real testnet.
// Run: AGENTDASH_ATTESTATION_ENABLED=true CLOCKCHAIN_MCP_KEY=<key> pnpm tsx scripts/mandate-demo.ts
import { clockchainEnabled, clockchainService } from "../server/src/services/clockchain.js";

async function main() {
  if (!clockchainEnabled()) { console.error("Set AGENTDASH_ATTESTATION_ENABLED=true and CLOCKCHAIN_MCP_KEY."); process.exit(1); }
  const svc = clockchainService();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const scope = { actions: ["attest"], demo: "slice1-manual" };
  const anchor = await svc.delegateAuthority({ parentDid: "did:demo:atlas", childDid: "did:demo:vega", scope, until });
  console.log("anchored:", anchor);
  const verdict = await svc.verifyDelegationAt({ parentDid: "did:demo:atlas", childDid: "did:demo:vega", scope, until, at: new Date().toISOString(), ledgerId: anchor.ledgerId, blockHeight: anchor.blockHeight });
  console.log("verdict:", verdict);
}
main().catch((e) => { console.error(e); process.exit(1); });
