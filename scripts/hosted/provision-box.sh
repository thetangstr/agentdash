#!/usr/bin/env bash
# AgentDash: provision (or re-converge) one hosted box on Railway.
#
# One box = one customer = one Railway project named agentdash-box-<slug>
# (D-S1, D-S4; each box in its own project so one box's private network
# cannot reach another's). The project holds a Postgres service, a `web`
# service running the AgentDash image, and a Volume at /paperclip.
#
# Idempotent: re-running converges the box. Secrets (auth secret, secrets
# master key, founder invite code) are generated once, stored ONLY as Railway
# variables, and never printed. The founder invite code is additionally
# written to a mode-600 file in the box's local state directory so the
# operator can hand it to the founder out of band.
#
# Usage:
#   scripts/hosted/provision-box.sh --slug <slug> --release <vYYYY.MDD.N> [options]
#
# Options:
#   --slug <slug>          box name; project becomes agentdash-box-<slug>
#   --release <tag>        release tag, e.g. v2026.924.0
#   --image <ref>          image to run (default ghcr.io/thetangstr/agentdash:<tag without v>)
#   --from-source          build the release tag's Dockerfile on Railway instead of pulling
#                          an image (use when GHCR has no image for the tag)
#   --custom-domain <host> also attach <host> (e.g. acme.agentdash.cloud) and print DNS records
#   --rotate-invite        replace the founder invite code with a fresh one
#   --no-deploy            converge config only; do not deploy
#   --redeploy             restart the current build with the converged variables
#                          (no new image pull or build); use after --rotate-invite
#
# Env: AGENTDASH_BOX_STATE_DIR (default ~/.agentdash-boxes), RAILWAY_API_TOKEN,
#      RAILWAY_WORKSPACE_ID (only needed with more than one workspace).
#
# See doc/runbooks/hosted-box.md.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

SLUG="" RELEASE="" IMAGE="" FROM_SOURCE=0 CUSTOM_DOMAIN="" ROTATE_INVITE=0 DEPLOY=1 REDEPLOY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --custom-domain) CUSTOM_DOMAIN="$2"; shift 2 ;;
    --rotate-invite) ROTATE_INVITE=1; shift ;;
    --no-deploy) DEPLOY=0; shift ;;
    --redeploy) REDEPLOY=1; shift ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$SLUG" ] || die "--slug is required"
[ -n "$RELEASE" ] || die "--release is required"
validate_slug "$SLUG"
[[ "$RELEASE" =~ ^v[0-9]{4}\.[0-9]{3,4}\.[0-9]+$ ]] || die "--release must look like v2026.924.0"
require_tools railway jq curl openssl git

PROJECT_NAME="${BOX_PROJECT_PREFIX}${SLUG}"
assert_box_project_name "$PROJECT_NAME"
STATE_DIR="$(box_state_dir "$SLUG")"
INVITE_FILE="${STATE_DIR}/founder-invite-code.txt"
[ -n "$IMAGE" ] || IMAGE="ghcr.io/thetangstr/agentdash:${RELEASE#v}"

say "Railway account: $(railway whoami 2>/dev/null | sed -n 's/.*Logged in as \([^ ]*\).*/\1/p')"

# --- 0. Image preflight: GHCR must actually have the tag (anonymous pull). ---
if [ "$FROM_SOURCE" = "0" ] && [ "$DEPLOY" = "1" ] && [ "$REDEPLOY" = "0" ]; then
  repo="${IMAGE#ghcr.io/}"; repo="${repo%:*}"; tag="${IMAGE##*:}"
  if [[ "$IMAGE" == ghcr.io/* ]]; then
    pull_token="$(curl -s "https://ghcr.io/token?scope=repository:${repo}:pull" | jq -r .token)"
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${pull_token}" \
      -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' \
      "https://ghcr.io/v2/${repo}/manifests/${tag}")"
    [ "$code" = "200" ] || die "no image at ${IMAGE} (HTTP ${code}). Use --from-source, or build the tag's image first (runbook section 'Images')."
  fi
fi

# --- 1. Project ---------------------------------------------------------------
PROJECT_JSON="$(find_project "$PROJECT_NAME")"
if [ -z "$PROJECT_JSON" ]; then
  say "creating project ${PROJECT_NAME}"
  gql 'mutation($i:ProjectCreateInput!){ projectCreate(input:$i){ id } }' \
    "$(jq -n --arg n "$PROJECT_NAME" --arg w "$(workspace_id)" \
        '{i:{name:$n, workspaceId:$w, defaultEnvironmentName:"production",
             description:"AgentDash hosted box (doc/runbooks/hosted-box.md)"}}')" >/dev/null
  PROJECT_JSON="$(find_project "$PROJECT_NAME")"
fi
PROJECT_ID="$(jq -r .id <<<"$PROJECT_JSON")"
ENV_ID="$(env_id_of "$PROJECT_JSON")"
[ -n "$PROJECT_ID" ] && [ -n "$ENV_ID" ] || die "project ${PROJECT_NAME} has no production environment"
say "project ${PROJECT_NAME} (${PROJECT_ID})"

# The CLI is used only from the box's own state directory, never from a repo checkout.
(cd "$STATE_DIR" && railway link --project "$PROJECT_ID" --environment production >/dev/null)

# --- 2. Postgres (Railway template: generates its own password, own volume) ---
if [ -z "$(service_id_of "$PROJECT_JSON" Postgres)" ]; then
  say "adding Postgres"
  (cd "$STATE_DIR" && railway add --database postgres >/dev/null)
  # The template deploys asynchronously; wait for the service to exist.
  for _ in $(seq 1 30); do
    PROJECT_JSON="$(find_project "$PROJECT_NAME")"
    [ -z "$(service_id_of "$PROJECT_JSON" Postgres)" ] || break
    sleep 5
  done
fi
PG_ID="$(service_id_of "$PROJECT_JSON" Postgres)"
[ -n "$PG_ID" ] || die "Postgres service did not appear"

# --- 3. web service -----------------------------------------------------------
if [ -z "$(service_id_of "$PROJECT_JSON" web)" ]; then
  say "creating web service"
  gql 'mutation($i:ServiceCreateInput!){ serviceCreate(input:$i){ id } }' \
    "$(jq -n --arg p "$PROJECT_ID" --arg e "$ENV_ID" '{i:{projectId:$p, environmentId:$e, name:"web"}}')" >/dev/null
  PROJECT_JSON="$(find_project "$PROJECT_NAME")"
fi
WEB_ID="$(service_id_of "$PROJECT_JSON" web)"
[ -n "$WEB_ID" ] || die "web service did not appear"

# --- 4. Volume at /paperclip (Paperclip home; Hermes home once #721 lands) ----
if ! volume_instances "$PROJECT_ID" | awk -v s="$WEB_ID" '$2==s && $3=="/paperclip"' | grep -q .; then
  say "adding volume at /paperclip"
  gql 'mutation($i:VolumeCreateInput!){ volumeCreate(input:$i){ id } }' \
    "$(jq -n --arg p "$PROJECT_ID" --arg e "$ENV_ID" --arg s "$WEB_ID" \
        '{i:{projectId:$p, environmentId:$e, serviceId:$s, mountPath:"/paperclip"}}')" >/dev/null
fi

# --- 5. Public domain ---------------------------------------------------------
HOST="$(service_domain "$PROJECT_ID" "$ENV_ID" "$WEB_ID")"
if [ -z "$HOST" ]; then
  say "generating Railway domain"
  gql 'mutation($i:ServiceDomainCreateInput!){ serviceDomainCreate(input:$i){ domain } }' \
    "$(jq -n --arg e "$ENV_ID" --arg s "$WEB_ID" '{i:{environmentId:$e, serviceId:$s, targetPort:3100}}')" >/dev/null
  HOST="$(service_domain "$PROJECT_ID" "$ENV_ID" "$WEB_ID")"
fi
[ -n "$HOST" ] || die "no Railway domain"
# A custom domain attached on an earlier run stays the public name.
[ -n "$CUSTOM_DOMAIN" ] || CUSTOM_DOMAIN="$(custom_domain "$PROJECT_ID" "$ENV_ID" "$WEB_ID")"
if [ -n "$CUSTOM_DOMAIN" ] && [ "$(custom_domain "$PROJECT_ID" "$ENV_ID" "$WEB_ID")" != "$CUSTOM_DOMAIN" ]; then
  say "attaching custom domain ${CUSTOM_DOMAIN}"
  gql 'mutation($i:CustomDomainCreateInput!){ customDomainCreate(input:$i){ domain status { dnsRecords { hostlabel recordType requiredValue } } } }' \
    "$(jq -n --arg p "$PROJECT_ID" --arg e "$ENV_ID" --arg s "$WEB_ID" --arg d "$CUSTOM_DOMAIN" \
        '{i:{projectId:$p, environmentId:$e, serviceId:$s, domain:$d, targetPort:3100}}')" \
    | jq -r '.data.customDomainCreate.status.dnsRecords[] | "    DNS: \(.recordType) \(.hostlabel) -> \(.requiredValue)"' >&2
fi
PUBLIC_HOST="${CUSTOM_DOMAIN:-$HOST}"
PUBLIC_URL="https://${PUBLIC_HOST}"
ALLOWED="$HOST"; [ -z "$CUSTOM_DOMAIN" ] || ALLOWED="${CUSTOM_DOMAIN},${HOST}"
say "public URL ${PUBLIC_URL}"

# --- 6. Variables -------------------------------------------------------------
# The hosted-box boot guard (#726, PR #729) refuses to start a box with
# AGENTDASH_DEPLOYMENT_KIND=hosted unless: authenticated mode, an https
# PAPERCLIP_PUBLIC_URL, AGENTDASH_HERMES_MANAGED_PROFILES=true, and gated
# sign-up (AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE=true + AGENTDASH_INVITE_CODES).
# Everything below satisfies it. See doc/deploy/railway.md from #729.
EXISTING="$(variable_names "$PROJECT_ID" "$ENV_ID" "$WEB_ID" || true)"
has_var() { grep -qx "$1" <<<"$EXISTING"; }

VARS_FILE="$(mktemp "${STATE_DIR}/vars.XXXXXX")"
chmod 600 "$VARS_FILE"
trap 'rm -f "$VARS_FILE"' EXIT

jq -n \
  --arg url "$PUBLIC_URL" --arg allowed "$ALLOWED" --arg release "$RELEASE" --arg slug "$SLUG" '{
    PORT: "3100",
    PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
    PAPERCLIP_PUBLIC_URL: $url,
    PAPERCLIP_AUTH_PUBLIC_BASE_URL: $url,
    BILLING_PUBLIC_BASE_URL: $url,
    PAPERCLIP_ALLOWED_HOSTNAMES: $allowed,
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    DATABASE_URL: "${{Postgres.DATABASE_URL}}",
    AGENTDASH_SELF_SERVE_BOOTSTRAP: "true",
    AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: "true",
    AGENTDASH_INVITE_VALIDATION_URL: ($url + "/api/invites/validate"),
    AGENTDASH_FREE_AGENT_CAP: "2",
    AGENTDASH_DEPLOYMENT_KIND: "hosted",
    AGENTDASH_HERMES_MANAGED_PROFILES: "true",
    AGENTDASH_RELEASE_TAG: $release,
    AGENTDASH_BOX_SLUG: $slug
  }' >"$VARS_FILE"

add_secret() { # add_secret NAME VALUE  (value arrives from a generator, not argv of any external tool)
  local tmp; tmp="$(mktemp "${STATE_DIR}/vars.XXXXXX")"; chmod 600 "$tmp"
  jq --arg k "$1" --arg v "$2" '. + {($k): $v}' "$VARS_FILE" >"$tmp" && mv "$tmp" "$VARS_FILE"
}
has_var BETTER_AUTH_SECRET || { say "generating BETTER_AUTH_SECRET"; add_secret BETTER_AUTH_SECRET "$(random_hex 32)"; }
has_var PAPERCLIP_SECRETS_MASTER_KEY || { say "generating PAPERCLIP_SECRETS_MASTER_KEY"; add_secret PAPERCLIP_SECRETS_MASTER_KEY "$(random_b64 32)"; }
if ! has_var AGENTDASH_INVITE_CODES || [ "$ROTATE_INVITE" = "1" ]; then
  say "generating founder invite code -> ${INVITE_FILE}"
  code="$(random_invite_code)"
  add_secret AGENTDASH_INVITE_CODES "$code"
  umask 077
  printf '%s\n' "$code" >"$INVITE_FILE"
  chmod 600 "$INVITE_FILE"
  unset code
fi
upsert_variables "$PROJECT_ID" "$ENV_ID" "$WEB_ID" "$VARS_FILE"
say "variables converged: $(jq -r 'keys | join(" ")' "$VARS_FILE")"

# --- 7. Service settings (health check, restarts, source, start command) -------
# Railway mounts the Volume root-owned, and the image's entrypoint drops to the
# `node` user, so a fresh /paperclip is not writable (EACCES on first boot).
# The start command hands the mount to `node` while still root, then runs the
# image's own entrypoint and command. If Railway ever wraps this in the image
# ENTRYPOINT instead, we are already `node` and it runs the server directly.
START_CMD='/bin/sh -c "if [ \"$(id -u)\" = 0 ]; then chown node:node /paperclip && exec docker-entrypoint.sh node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js; else exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js; fi"'
# The image source is only changed when this run deploys that image, so a
# config-only or redeploy run never repoints a source-built box at an image.
if [ "$FROM_SOURCE" = "1" ] || [ "$REDEPLOY" = "1" ] || [ "$DEPLOY" = "0" ]; then
  SOURCE_JSON='null'
else
  SOURCE_JSON="$(jq -n --arg i "$IMAGE" '{image:$i}')"
fi
gql 'mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:$i) }' \
  "$(jq -n --arg s "$WEB_ID" --arg e "$ENV_ID" --arg start "$START_CMD" --argjson src "$SOURCE_JSON" '{s:$s, e:$e, i:(
      {healthcheckPath:"/api/health", healthcheckTimeout:300, startCommand:$start,
       restartPolicyType:"ON_FAILURE", restartPolicyMaxRetries:3, numReplicas:1}
      + (if $src == null then {} else {source:$src} end))}')" >/dev/null

# --- 8. Deploy ----------------------------------------------------------------
if [ "$DEPLOY" = "1" ]; then
  read -r PREV_DEPLOYMENT _ <<<"$(latest_deployment "$PROJECT_ID" "$ENV_ID" "$WEB_ID")"
  if [ "$REDEPLOY" = "1" ]; then
    say "redeploying the current build with the converged variables"
    gql 'mutation($s:String!,$e:String!){ serviceInstanceRedeploy(serviceId:$s, environmentId:$e) }' \
      "$(jq -n --arg s "$WEB_ID" --arg e "$ENV_ID" '{s:$s, e:$e}')" >/dev/null
    HEALTH_TIMEOUT=900
  elif [ "$FROM_SOURCE" = "1" ]; then
    REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
    git -C "$REPO_ROOT" fetch -q origin "refs/tags/${RELEASE}:refs/tags/${RELEASE}" 2>/dev/null || true
    git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/${RELEASE}" >/dev/null || die "tag ${RELEASE} not found"
    SRC_DIR="$(mktemp -d)"
    git -C "$REPO_ROOT" archive --format=tar "$RELEASE" | tar -x -C "$SRC_DIR"
    say "uploading ${RELEASE} ($(git -C "$REPO_ROOT" rev-parse --short "${RELEASE}^{commit}")) for a Railway build"
    (cd "$STATE_DIR" && railway up "$SRC_DIR" --path-as-root --service web --detach >/dev/null)
    rm -rf "$SRC_DIR"
    HEALTH_TIMEOUT=1800
  else
    say "deploying ${IMAGE}"
    gql 'mutation($s:String!,$e:String!){ serviceInstanceDeployV2(serviceId:$s, environmentId:$e) }' \
      "$(jq -n --arg s "$WEB_ID" --arg e "$ENV_ID" '{s:$s, e:$e}')" >/dev/null
    HEALTH_TIMEOUT=900
  fi
  say "waiting for the new deployment (up to $((HEALTH_TIMEOUT / 60)) min)"
  wait_for_new_deployment "$PROJECT_ID" "$ENV_ID" "$WEB_ID" "$PREV_DEPLOYMENT" "$HEALTH_TIMEOUT" \
    || die "deployment did not succeed; read its logs in the Railway dashboard (project ${PROJECT_NAME}, service web)"
  HEALTH="$(wait_for_health "https://${HOST}" 300)" || die "box did not become healthy; check 'railway logs' from ${STATE_DIR}"
  MODE="$(jq -r .deploymentMode <<<"$HEALTH")"
  [ "$MODE" = "authenticated" ] || die "box is healthy but deploymentMode=${MODE}; refusing to hand it over"
  say "healthy: $(jq -c '{status,deploymentMode,bootstrapStatus,selfServeBootstrap}' <<<"$HEALTH")"
fi

cat <<EOF

Box ${PROJECT_NAME}: ${PUBLIC_URL}

Founder claim (the founder does this; we never see their password):
  1. The one-time invite code is in ${INVITE_FILE} (mode 600).
     Hand it to the founder out of band; never paste it into chat or a ticket.
  2. The founder runs:   scripts/hosted/claim-box.sh ${PUBLIC_URL} --code-file <path to the code>
     It asks for their name, email and a password, and creates their account.
  3. The founder signs in at ${PUBLIC_URL}/auth and creates their company.
     The first company on a fresh box makes its creator the instance admin.
  4. The operator rotates the code so it cannot be reused:
       scripts/hosted/provision-box.sh --slug ${SLUG} --release ${RELEASE} --rotate-invite --redeploy
EOF
