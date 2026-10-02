#!/bin/sh
# AgentDash: sandbox image entrypoint (spike). In the VM image this is the
# systemd unit graph (sandbox-egress.service -> sandbox-signerd.service ->
# sandbox-forwarder.service -> agent runtime); in the container it is one
# supervised script so the same topology is exercisable under docker run
# --cap-add NET_ADMIN.
set -eu

# 1. Egress allow-list first — nothing else gets to speak until it is up.
#    set -e + the script's own fail-closed apply mean a bad spec aborts boot.
/opt/sandbox/egress-apply.sh /etc/sandbox/egress.spec.json

# 2. Signer socket dir: signer owns it; setgid makes the socket inherit group
#    signsock so agent+svc (group members) can CONNECT (0660) while the key at
#    /etc/sandbox-signer (signer:signer 0700) stays unreadable to them.
#    /run/sandbox is group-writable + setgid + STICKY (3770): runshare members
#    can create files (agent writes run.log, ctl writes state) but cannot
#    unlink or rename each other's files.
install -d -o signer -g signsock -m 2750 /run/sandbox-signer
install -d -o root   -g runshare -m 3770 /run/sandbox

# 3. Signer daemon as the `signer` identity. --generate mints the prototype
#    file key on first boot; Phase 1 replaces it with the KMS adapter.
su -s /bin/sh signer -c "exec node /opt/sandbox/signerd.mjs \
  --socket /run/sandbox-signer/sign.sock \
  --policy /etc/sandbox-signer/policy.json \
  --key-file /etc/sandbox-signer/signing-key.pem --generate" &

# 4. Telemetry forwarder as the `svc` identity.
su -s /bin/sh svc -c "exec node /opt/sandbox/forwarder.mjs" &

# 5. Agent runtime placeholder. In the real image this is the Hermes launch
#    under the `agent` identity; for the spike we hand the container a shell.
if [ $# -gt 0 ]; then
  exec "$@"
fi
exec sleep infinity
