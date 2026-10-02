#!/bin/bash
# AgentDash: apply the per-uid egress allow-list (spike R3).
#
#   egress-apply.sh [spec.json]
#
# Reads the typed spec (default /etc/sandbox/egress.spec.json), resolves every
# allow-listed DNS name and each identity's uid, feeds the resolved spec to
# render-egress.mjs, and applies the result with `nft -f`. The apply is a
# single nftables transaction — declare-if-missing, delete, recreate — so a
# bad spec or render failure leaves the PREVIOUS table in force and this
# script exits non-zero. Failing closed is the whole point: "applied" is
# never printed without a committed ruleset.
#
# DNS resolution happens ONCE here, at apply time — identities marked
# "dns": false (the agent) get their allow-listed hosts pinned into
# /etc/hosts instead of a DNS rule, so they can reach the endpoint but
# cannot use resolver traffic as a covert channel. If a required name fails
# to resolve the whole apply fails (fail-closed).
#
# Must run as root with CAP_NET_ADMIN (container) or as the systemd unit
# sandbox-egress.service (VM image).
set -euo pipefail

SPEC="${1:-/etc/sandbox/egress.spec.json}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Resolve uid + dns in one node pass; emits the spec with a `resolved` block.
# (exit 1 on unresolvable required host -> set -e aborts before nft runs)
RESOLVED="$(node -e '
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const spec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const uids = {};
const hosts = {};
for (const [name, ident] of Object.entries(spec.identities ?? {})) {
  const user = ident.user ?? name;
  uids[name] = Number(execFileSync("id", ["-u", user], { encoding: "utf8" }).trim());
  for (const rule of ident.allow ?? []) {
    for (const h of rule.hosts ?? []) {
      if (hosts[h]) continue;
      // getent ahostsv4 prints "IP STREAM host" per line; dedupe.
      let out = "";
      try {
        out = execFileSync("getent", ["ahostsv4", h], { encoding: "utf8" });
      } catch {
        out = "";
      }
      hosts[h] = [...new Set(out.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean))];
      if (hosts[h].length === 0 && rule.optional !== true) {
        throw new Error(`DNS resolution returned nothing for ${h}`);
      }
    }
  }
}
spec.resolved = { uids, hosts };
process.stdout.write(JSON.stringify(spec));
' "$SPEC")"

TABLE="$(node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(s.table??"sandbox_egress")' <<<"$RESOLVED")"

# Render to a temp file first. Any render failure exits here (set -e) with
# the live table untouched — no delete-then-hope.
RENDERED="$(mktemp)"
APPLY="$(mktemp)"
trap 'rm -f "$RENDERED" "$APPLY"' EXIT
node "$HERE/render-egress.mjs" >"$RENDERED" <<<"$RESOLVED"

# Atomic replace in ONE transaction: declare-if-missing (so delete never
# fails on first boot), delete, recreate. nft -f applies the whole file as a
# single netlink batch — a syntax error aborts the batch and leaves the old
# table running.
{
  printf 'table inet %s {}\n' "$TABLE"
  printf 'delete table inet %s\n' "$TABLE"
  cat "$RENDERED"
} >"$APPLY"
nft -f "$APPLY"

# Pin allow-listed hosts for dns:false identities into /etc/hosts (managed
# block, replaced on every apply). The agent resolves ONLY these names and
# has no DNS egress, so query traffic can't tunnel data out.
node -e '
const fs = require("node:fs");
const spec = JSON.parse(process.argv[1]);
const hostsFile = process.argv[2];
const BEGIN = "# sandbox-pinned-begin (egress-apply.sh: dns:false identities)";
const END = "# sandbox-pinned-end";
let cur = fs.existsSync(hostsFile) ? fs.readFileSync(hostsFile, "utf8") : "";
cur = cur.replace(new RegExp("\\n?" + BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" + END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n?", "g"), "");
const lines = [];
for (const [name, ident] of Object.entries(spec.identities ?? {})) {
  if (ident.dns !== false) continue;
  for (const rule of ident.allow ?? []) {
    for (const h of rule.hosts ?? []) {
      for (const ip of spec.resolved?.hosts?.[h] ?? []) lines.push(`${ip}\t${h}`);
    }
  }
}
if (lines.length > 0) {
  cur = cur.replace(/\n+$/, "") + "\n" + BEGIN + "\n" + [...new Set(lines)].sort().join("\n") + "\n" + END + "\n";
}
fs.writeFileSync(hostsFile, cur);
' "$RESOLVED" /etc/hosts

echo "sandbox-egress: applied $(basename "$SPEC")"
