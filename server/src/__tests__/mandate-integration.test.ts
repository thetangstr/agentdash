import { describe, expect, it } from "vitest";
import { clockchainEnabled, clockchainService } from "../services/clockchain.ts";

const run = clockchainEnabled() ? describe : describe.skip;

run("Clockchain integration (real testnet)", () => {
  it("anchors a delegate_authority record and verifies it valid-at-T", async () => {
    const svc = clockchainService();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const scope = { actions: ["attest"], demo: "slice1" };
    const anchor = await svc.delegateAuthority({ parentDid: "did:demo:atlas", childDid: "did:demo:vega", scope, until });
    expect(anchor.anchored).toBe(true);
    expect(anchor.ledgerId).toBeTruthy();

    const inside = await svc.verifyDelegationAt({ parentDid: "did:demo:atlas", childDid: "did:demo:vega", scope, until, at: new Date().toISOString(), ledgerId: anchor.ledgerId, blockHeight: anchor.blockHeight });
    expect(inside.status).toBe("authorized");

    const after = await svc.verifyDelegationAt({ parentDid: "did:demo:atlas", childDid: "did:demo:vega", scope, until, at: new Date(Date.now() + 7_200_000).toISOString(), ledgerId: anchor.ledgerId, blockHeight: anchor.blockHeight });
    expect(after.status).toBe("unauthorized");
  }, 30_000);
});
