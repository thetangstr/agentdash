#!/bin/zsh
# Keep the tailnet TLS certificate alive.
#
# `tailscale cert` issues a real Let's Encrypt certificate for the .ts.net
# name. That certificate is what lets a laptop reach this box over HTTPS with
# no mkcert root installed -- which is the only workable path onto an
# MDM-managed Mac, where a non-admin user cannot trust a private root at all.
#
# Let's Encrypt certificates last 90 days. Nothing renews this one on its own:
# `tailscale cert` renews when it is ASKED to, and Caddy holds the file it read
# at startup. So without this job the client's HTTPS access works for three
# months and then breaks on a Tuesday for no visible reason -- the failure mode
# this repo keeps running into, arriving on a timer.
#
# Safe to run daily and safe to run repeatedly. Tailscale only actually
# reissues when the certificate is inside its renewal window; on every other
# day this is a no-op that costs a few milliseconds.

set -eu

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

CONF="$HOME/.config/agentdash"
TLS="$CONF/tls"
CERT="$TLS/ts.crt"
KEY="$TLS/ts.key"

log() { print -r -- "$(date '+%Y-%m-%d %H:%M:%S') $1"; }

TS_NAME=$(tailscale status --json 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,''))}catch(e){}})" || true)

if [ -z "$TS_NAME" ]; then
  log "no tailnet name (tailscaled down?) — nothing to renew"
  exit 0
fi

# Fingerprint before, so we only reload Caddy when the file actually changed.
BEFORE=$(shasum -a 256 "$CERT" 2>/dev/null | awk '{print $1}' || echo none)

if ! tailscale cert --cert-file "$CERT" --key-file "$KEY" "$TS_NAME" >/dev/null 2>&1; then
  # Loud, because a silent failure here is a certificate that expires later.
  log "ERROR: tailscale cert failed for $TS_NAME — cert expires $(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | sed 's/notAfter=//')"
  exit 1
fi

AFTER=$(shasum -a 256 "$CERT" 2>/dev/null | awk '{print $1}' || echo none)

if [ "$BEFORE" = "$AFTER" ]; then
  log "no change — $TS_NAME valid until $(openssl x509 -in "$CERT" -noout -enddate | sed 's/notAfter=//')"
  exit 0
fi

# Caddy reads the certificate off disk at load, so a renewed file that nobody
# reloads is still the old certificate on the wire.
if caddy reload --config "$CONF/Caddyfile" >/dev/null 2>&1; then
  log "renewed $TS_NAME (valid until $(openssl x509 -in "$CERT" -noout -enddate | sed 's/notAfter=//')) and reloaded Caddy"
else
  log "ERROR: renewed $TS_NAME but 'caddy reload' failed — the old certificate is still being served"
  exit 1
fi
