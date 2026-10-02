# AgentDash: per-company sandbox image — local prototype (spike R1/R2/R3).
# The Phase-1 VM image keeps this exact layout but is baked by Packer/Image
# Builder with systemd units instead of entrypoint.sh supervision, and the
# signer's file key is replaced by the KMS adapter.
#
#   docker build -t agentdash-sandbox-spike cloud/sandbox
#   docker run --rm --cap-add NET_ADMIN agentdash-sandbox-spike
#
# Requires --cap-add NET_ADMIN so egress-apply.sh can program nftables inside
# the container's own netns. No other privilege is granted.

FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends nftables iproute2 \
 && rm -rf /var/lib/apt/lists/*

# Identities (R2/R3). UIDs are fixed so the rendered nftables ruleset and the
# image agree, and so evidence can record them. Groups:
#   signsock — may CONNECT to the signer socket (agent, svc). The agent asks
#              for signatures directly; svc needs it because the Clockchain
#              local adapter runs as svc and submits protocol artifacts for
#              signing. Neither can read the key.
#   runshare — shares /run/sandbox (agent writes run.log, svc forwards it);
#              the dir is sticky (3750) so group members cannot unlink each
#              other's files; secret-bearing files inside stay root:svc 0640.
# Shells are nologin — entrypoint su's with -s /bin/sh.
RUN groupadd -g 1100 signsock \
 && groupadd -g 1104 runshare \
 && useradd -u 1101 -m -s /usr/sbin/nologin agent \
 && useradd -u 1102 -m -s /usr/sbin/nologin signer \
 && useradd -u 1103 -m -s /usr/sbin/nologin svc \
 && usermod -aG signsock agent \
 && usermod -aG signsock svc \
 && usermod -aG runshare agent \
 && usermod -aG runshare svc

# /etc/sandbox-signer is traversable only by `signer`; the prototype file key
# is minted by signerd --generate at first boot and is never in the image.
RUN install -d -o signer -g signer -m 0700 /etc/sandbox-signer
COPY signer-policy.json /etc/sandbox-signer/policy.json
RUN chown signer:signer /etc/sandbox-signer/policy.json && chmod 0640 /etc/sandbox-signer/policy.json

COPY egress.spec.json /etc/sandbox/egress.spec.json

COPY render-egress.mjs egress-apply.sh signerd.mjs sandbox-ctl.mjs \
     forwarder.mjs sockcat.mjs entrypoint.sh healthcheck.sh /opt/sandbox/
RUN chmod 0755 /opt/sandbox/*.mjs /opt/sandbox/*.sh

ENTRYPOINT ["/opt/sandbox/entrypoint.sh"]
