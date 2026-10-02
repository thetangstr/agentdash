// AgentDash: spike tests for the egress spec -> nftables render path (R3).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  egressSpecDigest,
  egressSpecSchema,
  renderEgressRuleset,
  type ResolvedEgressSpec,
} from "../sandbox/egress-spec.js";

const SANDBOX_DIR = fileURLToPath(new URL("../../sandbox", import.meta.url));

const RESOLVED: ResolvedEgressSpec["resolved"] = {
  uids: { agent: 1101, signer: 1102, svc: 1103 },
  hosts: {
    "api.z.ai": ["203.0.113.10"],
    "mcp.clockchain.network": ["203.0.113.20", "203.0.113.21"],
    "telemetry.agentdash.internal": ["10.0.0.50"],
    "ethereum-sepolia-rpc.publicnode.com": ["203.0.113.60"],
    "kms.us-east-1.amazonaws.com": ["10.0.0.10"],
  },
};

function resolvedSpec(): ResolvedEgressSpec {
  const spec = egressSpecSchema.parse(
    JSON.parse(readFileSync(join(SANDBOX_DIR, "egress.spec.json"), "utf8")),
  );
  return { ...spec, resolved: RESOLVED };
}

describe("egressSpecSchema", () => {
  it("parses the shipped image spec", () => {
    const spec = resolvedSpec();
    expect(Object.keys(spec.identities).sort()).toEqual(["agent", "signer", "svc"]);
  });

  it("rejects an allow rule with no hosts or cidrs", () => {
    expect(() =>
      egressSpecSchema.parse({
        version: 1,
        identities: { agent: { user: "agent", allow: [{ ports: [443] }] } },
      }),
    ).toThrow();
  });

  it("rejects a hostname that would inject nftables syntax", () => {
    const spec = resolvedSpec();
    spec.identities.agent.allow[0]!.hosts = ['evil"]; drop ruleset; --'];
    expect(() => egressSpecSchema.parse(spec)).toThrow();
  });

  it("rejects unknown top-level keys (strict)", () => {
    const spec = { ...resolvedSpec(), extra: true };
    expect(() => egressSpecSchema.parse(spec)).toThrow();
  });
});

describe("renderEgressRuleset", () => {
  it("renders a complete table with drop policy and per-uid rules", () => {
    const ruleset = renderEgressRuleset(resolvedSpec());
    expect(ruleset).toMatch(/^table inet sandbox_egress \{/);
    expect(ruleset).toContain("policy drop");
    expect(ruleset).toContain('oifname "lo" accept');
    expect(ruleset).toContain("meta skuid 0 accept");
    // agent (1101): model endpoint + clockchain MCP
    expect(ruleset).toContain("meta skuid 1101 ip daddr { 203.0.113.10 } tcp dport { 443 } accept");
    expect(ruleset).toContain(
      "meta skuid 1101 ip daddr { 203.0.113.20, 203.0.113.21 } tcp dport { 443 } accept",
    );
    // svc (1103): telemetry + sepolia
    expect(ruleset).toContain("meta skuid 1103 ip daddr { 10.0.0.50 } tcp dport { 443 } accept");
    // signer (1102): IMDSv2 credentials endpoint + KMS only
    expect(ruleset).toContain("meta skuid 1102 ip daddr { 169.254.169.254/32 } tcp dport { 80 } accept");
    expect(ruleset).toContain("meta skuid 1102 ip daddr { 10.0.0.10 } tcp dport { 443 } accept");
    // dns to the VPC resolver for identities with dns:true (svc, signer)…
    expect(ruleset).toContain("meta skuid 1103 ip daddr { 169.254.169.253 } udp dport 53 accept");
    expect(ruleset).toContain("meta skuid 1102 ip daddr { 169.254.169.253 } udp dport 53 accept");
    // …but NOT the agent (dns:false — hosts are /etc/hosts-pinned instead)
    expect(ruleset).not.toContain("meta skuid 1101 ip daddr { 169.254.169.253 }");
    // managed identities reject fast
    expect(ruleset).toContain(
      "meta skuid { 1101, 1102, 1103 } reject with icmpx type port-unreachable",
    );
  });

  it("is deterministic", () => {
    expect(renderEgressRuleset(resolvedSpec())).toBe(renderEgressRuleset(resolvedSpec()));
  });

  it("fails when a host was not resolved (fail-closed)", () => {
    const spec = resolvedSpec();
    spec.resolved.hosts = {};
    expect(() => renderEgressRuleset(spec)).toThrow();
  });
});

describe("egressSpecDigest", () => {
  it("is stable and changes with the spec", () => {
    const a = egressSpecDigest(resolvedSpec());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(egressSpecDigest(resolvedSpec()));
    const b = { ...resolvedSpec() };
    b.identities = { ...b.identities, agent: { ...b.identities.agent, dns: true } };
    expect(egressSpecDigest(b)).not.toBe(a);
  });
});
