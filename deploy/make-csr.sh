#!/bin/zsh
# Generate a private key and a certificate signing request for MKThink IT to sign.
#
# This exists because the mkcert route is a dead end on their fleet. Getting
# `rootCA.pem` onto a laptop is easy; *trusting* it is the hard part, and on an
# MDM-managed Mac a non-admin user cannot do it at all -- Apple removed silent
# CLI trust, so the keychain prompts for admin credentials no matter how the
# file arrived. Four people clicking through a browser warning forever is not a
# deployment.
#
# The way out is a certificate their machines ALREADY trust: one issued by
# MKThink's own internal CA. Then nothing new is trusted anywhere, and the
# warning disappears for every managed Mac at once.
#
# IT signs a CSR; they never need our private key, and it never leaves this
# machine. That is the point of a CSR and it is worth saying out loud when you
# hand it over -- it is usually the first question.
#
# Usage:
#   deploy/make-csr.sh agentdash.mkthink.com [extra-san ...]
#
# Example with the LAN IP as an additional SAN:
#   deploy/make-csr.sh agentdash.mkthink.com 10.50.10.129

set -eu
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$PATH"

FQDN="${1:-}"
if [ -z "$FQDN" ]; then
  print -u2 "usage: deploy/make-csr.sh <fqdn> [extra-san ...]"
  print -u2 "  e.g. deploy/make-csr.sh agentdash.mkthink.com 10.50.10.129"
  exit 2
fi
shift

OUT="$HOME/.config/agentdash/tls"
mkdir -p "$OUT"

# SANs. A modern client ignores CN entirely and reads only subjectAltName, so
# the FQDN has to appear in BOTH -- a CSR with the name only in CN produces a
# certificate no browser will accept.
SAN="DNS:${FQDN}"
for extra in "$@"; do
  if [[ "$extra" =~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
    SAN="${SAN},IP:${extra}"
  else
    SAN="${SAN},DNS:${extra}"
  fi
done

KEY="$OUT/${FQDN}.key"
CSR="$OUT/${FQDN}.csr"

# 2048-bit RSA rather than EC: some enterprise CAs still refuse EC CSRs, and a
# rejected CSR costs another round-trip with IT. Not worth the elegance.
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$KEY" \
  -out "$CSR" \
  -subj "/CN=${FQDN}/O=MKThink/OU=AgentDash" \
  -addext "subjectAltName=${SAN}" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null

chmod 600 "$KEY"
chmod 644 "$CSR"

print -P "%F{green}CSR written%f"
print "  key (NEVER send this) : $KEY"
print "  csr (send this to IT) : $CSR"
print ""
print -P "%BWhat IT receives%b"
openssl req -in "$CSR" -noout -subject -reqopt no_version 2>/dev/null | sed 's/^/  /'
openssl req -in "$CSR" -noout -text | grep -A1 "Subject Alternative Name" | tail -1 | sed 's/^ */  SANs: /'
print ""
print -P "%BWhen they send the signed certificate back%b"
print "  1. Save it as        $OUT/${FQDN}.crt"
print "  2. If they also send an intermediate/chain, append it to that file"
print "     (server cert FIRST, then intermediates -- order matters)."
print "  3. Point Caddy at it and reload:"
print "       $OUT/${FQDN}.crt  +  $KEY"
print "  4. Verify with a real client, not -k:"
print "       curl -sS -o /dev/null -w '%{http_code}\\n' https://${FQDN}:3112/api/health"
print ""
print "  A 200 with no --cacert is the whole test: it means the system trust"
print "  store accepted it, which is exactly what every laptop will do."
