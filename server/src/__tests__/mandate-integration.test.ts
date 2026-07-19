import { describe, expect, it } from "vitest";
import { clockchainEnabled, clockchainService } from "../services/clockchain.ts";

// Live testnet round-trip through the corrected AgentDash client. Skipped unless the
// attestation flag + key are set. Verifies the field mappings that broke when mocked
// (snake_case args, scope as array, mint_identity wants did+document, allow_degraded).
const run = clockchainEnabled() ? describe : describe.skip;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const waitAnchored = async (getEntry: (id: string) => Promise<{ anchored: boolean }>, ledgerId: string, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    const e = await getEntry(ledgerId);
    if (e.anchored) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

run("Clockchain client (real testnet)", () => {
  it("mints identities, grants a mandate, confirms the anchor, KYAs, and attests", async () => {
    const cc = clockchainService();

    // Three demo identities (caller supplies the did; mint derives did:clockchain:agentdash:<agentId>).
    const grantor = await cc.mintIdentity({ agentId: `atlas-${SUFFIX}`, name: "Atlas" });
    const grantee = await cc.mintIdentity({ agentId: `vega-${SUFFIX}`, name: "Vega" });
    const counterparty = await cc.mintIdentity({ agentId: `billie-${SUFFIX}`, name: "Billie" });
    expect(grantor.minted && grantee.minted && counterparty.minted).toBe(true);
    expect(grantor.did && grantee.did && counterparty.did).toBeTruthy();
    expect(counterparty.ledgerId).toBeTruthy();

    // Wait for the counterparty's mint to anchor — KYA requires a mint anchored BEFORE T.
    const anchored = await waitAnchored(cc.getLogEntry, counterparty.ledgerId!, 20);
    expect(anchored).toBe(true);

    // Grant the mandate (scope is an array of allowed actions).
    const mandate = await cc.delegateAuthority({
      parentDid: grantor.did!,
      childDid: grantee.did!,
      scope: ["release_payment"],
      until: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(mandate.anchored).toBe(true);
    expect(mandate.ledgerId).toBeTruthy();

    // Confirm the mandate's anchor is real + anchored on-chain.
    const mandateAnchored = await waitAnchored(cc.getLogEntry, mandate.ledgerId!, 20);
    expect(mandateAnchored).toBe(true);
    const entry = await cc.getLogEntry(mandate.ledgerId!);
    expect(entry.found).toBe(true);
    expect(entry.anchored).toBe(true);

    // KYA the counterparty valid-at-T (T is now, after the mint anchored).
    const kya = await cc.verifyIdentityAt({ did: counterparty.did!, at: new Date().toISOString() });
    expect(kya.status).toBe("valid");

    // Attest the action as the grantee → self-verifying receipt.
    const att = await cc.attestAction({
      agentDid: grantee.did!,
      action: "release_payment",
      inputs: { counterparty: counterparty.did!, invoice: `INV-${SUFFIX}` },
      outputs: { amountCents: 5890000, status: "settled" },
    });
    expect(att.attested).toBe(true);
    expect(att.ledgerId).toBeTruthy();
    expect(att.eventHash).toBeTruthy();
  }, 60_000);
});
