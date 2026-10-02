#!/usr/bin/env node
// AgentDash: renders the per-uid egress allow-list (spike R3) as an nftables
// ruleset. This file is intentionally self-contained — it must run inside the
// sandbox image where the repo is not available. The control-plane TypeScript
// wrapper (cloud/src/sandbox/egress-spec.ts) validates input with zod and then
// shells out to THIS file, so there is exactly one renderer implementation and
// the unit tests exercise the artifact the image actually ships.
//
// Input on stdin (JSON):
//   {
//     "version": 1,
//     "table": "sandbox_egress",
//     "dnsServers": ["169.254.169.253"],
//     "identities": {
//       "agent":  { "user": "agent",  "dns": true,  "allow": [ ... ] },
//       "svc":    { "user": "svc",    "dns": true,  "allow": [ ... ] },
//       "signer": { "user": "signer", "dns": false, "allow": [ ... ] }
//     },
//     "resolved": {
//       "uids":  { "agent": 1101, "svc": 1103, "signer": 1102 },
//       "hosts": { "mcp.clockchain.network": ["203.0.113.10"], ... }
//     }
//   }
//
// Each allow entry: { "hosts": ["api.z.ai"], "cidrs": ["10.0.0.0/8"],
//                     "ports": [443], "proto": "tcp", "optional": false }
// Hostnames are rendered as the IPs supplied in resolved.hosts; resolution
// happens in egress-apply.sh so the renderer itself is pure and testable.
// An unresolved host fails the render UNLESS the entry is "optional" — meant
// for hosts that legitimately do not exist yet (e.g. a sink endpoint pending
// a mint service); the omission is emitted as a comment so the rendered
// ruleset still records the intent for evidence.
//
// Output on stdout: a complete nftables table block. Re-application is
// idempotent because egress-apply.sh deletes the table first (the modern
// `destroy` statement needs nftables >= 1.1; Debian bookworm ships 1.0.6).
//
// Rule shape (output hook only; nothing inbound is ever opened):
//   - loopback and uid 0 are accepted early (root owns nft anyway; SSM and
//     the egress applier need it)
//   - per identity: optional DNS to dnsServers only, then one accept rule per
//     allow entry, then a final reject for every managed uid — anything not
//     allow-listed fails fast (ECONNREFUSED) instead of hanging on drop.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TABLE_RE = /^[a-z_][a-z0-9_]*$/;
const USER_RE = /^[a-z_][a-z0-9_-]*$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const CIDR4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;

function fail(msg) {
  process.stderr.write(`render-egress: ${msg}\n`);
  process.exit(2);
}

function ipv4Ok(ip) {
  return IPV4_RE.test(ip) && ip.split(".").every((o) => Number(o) <= 255);
}

function setLiteral(items) {
  return `{ ${items.join(", ")} }`;
}

export function render(spec) {
  if (spec?.version !== 1) fail("spec.version must be 1");
  const table = spec.table ?? "sandbox_egress";
  if (!TABLE_RE.test(table)) fail(`bad table name ${JSON.stringify(table)}`);

  const dns = spec.dnsServers ?? [];
  for (const d of dns) if (!ipv4Ok(d)) fail(`bad dns server ${JSON.stringify(d)}`);

  const identities = spec.identities ?? {};
  const resolved = spec.resolved ?? {};
  const uids = resolved.uids ?? {};
  const hosts = resolved.hosts ?? {};

  const names = Object.keys(identities).sort();
  if (names.length === 0) fail("spec.identities is empty");

  const managedUids = [];
  const lines = [];
  lines.push(`table inet ${table} {`);
  lines.push("  chain output {");
  lines.push("    type filter hook output priority 0; policy drop;");
  lines.push('    oifname "lo" accept');
  lines.push("    meta skuid 0 accept");

  for (const name of names) {
    const ident = identities[name];
    if (!USER_RE.test(name)) fail(`bad identity name ${JSON.stringify(name)}`);
    const user = ident.user ?? name;
    if (!USER_RE.test(user)) fail(`bad user ${JSON.stringify(user)} for identity ${name}`);
    const uid = uids[name];
    if (!Number.isInteger(uid) || uid < 1) fail(`resolved.uids[${JSON.stringify(name)}] missing or not a positive integer`);
    managedUids.push(uid);

    if (ident.dns !== false && dns.length > 0) {
      const dset = setLiteral(dns);
      lines.push(`    meta skuid ${uid} ip daddr ${dset} udp dport 53 accept`);
      lines.push(`    meta skuid ${uid} ip daddr ${dset} tcp dport 53 accept`);
    }

    for (const rule of ident.allow ?? []) {
      const proto = rule.proto ?? "tcp";
      if (proto !== "tcp" && proto !== "udp") fail(`bad proto ${JSON.stringify(proto)}`);
      const ports = rule.ports;
      if (!Array.isArray(ports) || ports.length === 0) fail("allow entry needs ports");
      for (const p of ports) if (!Number.isInteger(p) || p < 1 || p > 65535) fail(`bad port ${JSON.stringify(p)}`);

      const addrs = [];
      const skipped = [];
      for (const c of rule.cidrs ?? []) {
        if (!CIDR4_RE.test(c)) fail(`bad cidr ${JSON.stringify(c)}`);
        addrs.push(c);
      }
      for (const h of rule.hosts ?? []) {
        if (!HOST_RE.test(h)) fail(`bad host ${JSON.stringify(h)}`);
        const ips = hosts[h];
        if (!Array.isArray(ips) || ips.length === 0) {
          if (rule.optional === true) {
            skipped.push(h);
            continue;
          }
          fail(`host ${JSON.stringify(h)} was not resolved — resolved.hosts must cover every allow host`);
        }
        for (const ip of ips) {
          if (!ipv4Ok(ip)) fail(`resolved host ${h} to bad ip ${JSON.stringify(ip)}`);
          addrs.push(ip);
        }
      }
      for (const h of skipped) {
        lines.push(`    # unresolved (optional): ${h} — declared in spec, no addresses rendered`);
      }
      if (addrs.length === 0) {
        if (skipped.length === 0) fail("allow entry produced no addresses");
        continue; // every host was optional and unresolved: no rule, but recorded above
      }

      const unique = [...new Set(addrs)].sort();
      lines.push(
        `    meta skuid ${uid} ip daddr ${setLiteral(unique)} ${proto} dport ${setLiteral([...ports].sort((a, b) => a - b))} accept`,
      );
    }
  }

  // Fail fast for managed identities; all other non-root uids hit the drop policy.
  lines.push(`    meta skuid ${setLiteral(managedUids)} reject with icmpx type port-unreachable`);
  lines.push("  }");
  lines.push("}");
  return lines.join("\n") + "\n";
}

// CLI: read the resolved spec from stdin, write the ruleset to stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    try {
      process.stdout.write(render(JSON.parse(input)));
    } catch (err) {
      fail(err instanceof SyntaxError ? `bad JSON: ${err.message}` : String(err?.message ?? err));
    }
  });
}
