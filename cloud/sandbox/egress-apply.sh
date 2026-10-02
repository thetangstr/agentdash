#!/bin/sh
# AgentDash: apply the per-uid egress allow-list (spike R3).
#
#   egress-apply.sh [spec.json]
#
# Reads the typed spec (default /etc/sandbox/egress.spec.json), resolves every
# allow-listed DNS name and each identity's uid, feeds the resolved spec to
# render-egress.mjs, and applies the result with `nft -f`. The ruleset always
# starts with `destroy table`, so repeated runs are idempotent.
#
# DNS resolution happens ONCE here, at apply time — the agent identity is not
# trusted to resolve on its own schedule, and the allow-list is pinned IPs,
# not a hostname regex. If a name fails to resolve the whole apply fails
# (fail-closed: a missing allow host must not silently widen or narrow the
# ruleset).
#
# Must run as root with CAP_NET_ADMIN (container) or as the systemd unit
# sandbox-egress.service (VM image).
set -eu

SPEC="${1:-/etc/sandbox/egress.spec.json}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Resolve uid + dns in one node pass; emits the spec with a `resolved` block.
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

TABLE=$(printf '%s' "$RESOLVED" | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(s.table??"sandbox_egress")')

# Idempotent apply: delete the table if it exists, then load the fresh
# ruleset. (`destroy table` would be nicer but needs nftables >= 1.1;
# bookworm ships 1.0.6.) A failed delete of a missing table must not abort.
if nft list table inet "$TABLE" >/dev/null 2>&1; then
  nft delete table inet "$TABLE"
fi
printf '%s' "$RESOLVED" | node "$HERE/render-egress.mjs" | nft -f -
echo "sandbox-egress: applied $(basename "$SPEC")"
