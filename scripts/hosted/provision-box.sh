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
# variables, and never printed or put on a command line. The founder invite
# code is also written to a mode-600 file in the box's local state directory
# so the operator can hand it to the founder out of band.
#
# Safety: if the box's current variables cannot be read, the script stops.
# It never generates a new auth secret or master key for a box that already
# has a deployment (that would lock everyone out and make every stored company
# secret unreadable) unless --i-know-this-destroys-secrets is given.
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
#   --custom-domain <host> attach <host> (e.g. acme.agentdash.cloud) and print the DNS
#                          records to add; the public URL does not change yet
#   --use-custom-domain    switch the public URL to the attached custom domain; refuses
#                          until Railway reports it verified and it serves HTTPS
#   --rotate-invite        replace the invite code with a fresh one (written to the code file)
#   --close-signup         after the founder's claim: PAPERCLIP_AUTH_DISABLE_SIGN_UP=true,
#                          rotate the invite code to an unrecorded value, delete the code file
#   --open-signup          reopen sign-up (PAPERCLIP_AUTH_DISABLE_SIGN_UP=false); combine with
#                          --rotate-invite to issue a code
#   --no-deploy            converge config only; do not deploy (variable changes are not live)
#   --redeploy             restart the current build with the converged variables
#                          (no new image pull or build). Refuses (exit non-zero) when
#                          --release differs from the box's recorded AGENTDASH_RELEASE_TAG,
#                          since that would silently leave the old code running; run
#                          without --redeploy to upgrade (add --from-source if no image
#                          exists yet), or pass --force-redeploy-same-build to override.
#   --force-redeploy-same-build
#                          allow --redeploy with a --release that does not match the
#                          box's recorded release (only for relabeling a restart; it does
#                          NOT build or pull the new release)
#   --i-know-this-destroys-secrets
#                          allow generating an auth secret / master key on a box that has
#                          already been deployed (only for a box whose data you are discarding)
#
# Env: AGENTDASH_BOX_STATE_DIR (default ~/.agentdash-boxes), RAILWAY_API_TOKEN,
#      RAILWAY_WORKSPACE_ID (only needed with more than one workspace).
#
# See doc/runbooks/hosted-box.md.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

SLUG="" RELEASE="" IMAGE="" FROM_SOURCE=0 CUSTOM_DOMAIN="" USE_CUSTOM=0 ROTATE_INVITE=0 DEPLOY=1 REDEPLOY=0
CLOSE_SIGNUP=0 OPEN_SIGNUP=0 DESTROY_SECRETS=0 FORCE_REDEPLOY_SAME_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --custom-domain) CUSTOM_DOMAIN="$2"; shift 2 ;;
    --use-custom-domain) USE_CUSTOM=1; shift ;;
    --rotate-invite) ROTATE_INVITE=1; shift ;;
    --close-signup) CLOSE_SIGNUP=1; shift ;;
    --open-signup) OPEN_SIGNUP=1; shift ;;
    --i-know-this-destroys-secrets) DESTROY_SECRETS=1; shift ;;
    --no-deploy) DEPLOY=0; shift ;;
    --redeploy) REDEPLOY=1; shift ;;
    --force-redeploy-same-build) FORCE_REDEPLOY_SAME_BUILD=1; shift ;;
    -h|--help) sed -n '2,56p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$SLUG" ] || die "--slug is required"
[ -n "$RELEASE" ] || die "--release is required"
validate_slug "$SLUG"
[ "$CLOSE_SIGNUP$OPEN_SIGNUP" != "11" ] || die "--close-signup and --open-signup are exclusive"
[ "$CLOSE_SIGNUP$ROTATE_INVITE" != "11" ] || die "--close-signup already rotates the code to an unrecorded value"
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
  validate_new_slug "$SLUG"
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
if [ -z "$(postgres_service_id_of "$PROJECT_JSON")" ]; then
  say "adding Postgres"
  (cd "$STATE_DIR" && railway add --database postgres >/dev/null)
  # The template deploys asynchronously; wait for the service to exist.
  for _ in $(seq 1 30); do
    PROJECT_JSON="$(find_project "$PROJECT_NAME")"
    [ -z "$(postgres_service_id_of "$PROJECT_JSON")" ] || break
    sleep 5
  done
fi
PG_ID="$(postgres_service_id_of "$PROJECT_JSON")"
PG_NAME="$(jq -r --arg id "$PG_ID" '[.services.edges[].node | select(.id == $id)][0].name' <<<"$PROJECT_JSON")"
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
ATTACHED_CUSTOM="$(custom_domain "$PROJECT_ID" "$ENV_ID" "$WEB_ID")"
if [ -n "$CUSTOM_DOMAIN" ] && [ "$ATTACHED_CUSTOM" != "$CUSTOM_DOMAIN" ]; then
  say "attaching custom domain ${CUSTOM_DOMAIN}"
  gql 'mutation($i:CustomDomainCreateInput!){ customDomainCreate(input:$i){ domain status { dnsRecords { hostlabel recordType requiredValue } } } }' \
    "$(jq -n --arg p "$PROJECT_ID" --arg e "$ENV_ID" --arg s "$WEB_ID" --arg d "$CUSTOM_DOMAIN" \
        '{i:{projectId:$p, environmentId:$e, serviceId:$s, domain:$d, targetPort:3100}}')" \
    | jq -r '.data.customDomainCreate.status.dnsRecords[] | "    DNS: \(.recordType) \(.hostlabel) -> \(.requiredValue)"' >&2
  say "add those records at the DNS host, wait for Railway to verify, then re-run with --use-custom-domain"
  ATTACHED_CUSTOM="$CUSTOM_DOMAIN"
fi
# The public URL is the Railway host until the operator switches, and stays
# the custom host once switched (read back from the live variable).
CURRENT_PUBLIC="$(variable_value "$PROJECT_ID" "$ENV_ID" "$WEB_ID" PAPERCLIP_PUBLIC_URL)" \
  || die "could not read the box's current PAPERCLIP_PUBLIC_URL; refusing to continue"
PUBLIC_HOST="$HOST"
if [ -n "$ATTACHED_CUSTOM" ] && [ "$CURRENT_PUBLIC" = "https://${ATTACHED_CUSTOM}" ]; then
  PUBLIC_HOST="$ATTACHED_CUSTOM"
fi
if [ "$USE_CUSTOM" = "1" ]; then
  [ -n "$ATTACHED_CUSTOM" ] || die "--use-custom-domain: no custom domain is attached (use --custom-domain first)"
  [ "$(custom_domain_verified "$PROJECT_ID" "$ENV_ID" "$WEB_ID")" = "true" ] \
    || die "Railway has not verified ${ATTACHED_CUSTOM} yet; check the CNAME and TXT records and retry"
  curl -fsS --max-time 15 -o /dev/null "https://${ATTACHED_CUSTOM}/api/health" \
    || die "https://${ATTACHED_CUSTOM} does not serve yet (certificate or DNS still pending); retry later"
  PUBLIC_HOST="$ATTACHED_CUSTOM"
  say "switching the public URL to https://${ATTACHED_CUSTOM} (live after the redeploy)"
fi
PUBLIC_URL="https://${PUBLIC_HOST}"
ALLOWED="$HOST"; [ -z "$ATTACHED_CUSTOM" ] || ALLOWED="${ATTACHED_CUSTOM},${HOST}"
say "public URL ${PUBLIC_URL}"

# --- 6. Variables -------------------------------------------------------------
# The hosted-box boot guard (#726, PR #729) refuses to start a box with
# AGENTDASH_DEPLOYMENT_KIND=hosted unless: authenticated mode, an https
# PAPERCLIP_PUBLIC_URL, AGENTDASH_HERMES_MANAGED_PROFILES=true, and gated
# sign-up (AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE=true + AGENTDASH_INVITE_CODES).
# Everything below satisfies it. See doc/deploy/railway.md from #729.
# AGENTDASH_TRIAL_ANONYMOUS=false: the anonymous Test Drive creates a company,
# and a hosted box holds exactly one (#725); the guard refuses "true".
# A failed read must never look like "no variables": that would regenerate
# the live secrets over the real ones.
EXISTING="$(variable_names "$PROJECT_ID" "$ENV_ID" "$WEB_ID")" \
  || die "could not read the box's current variables; refusing to continue (nothing was changed)"
has_var() { grep -qx "$1" <<<"$EXISTING"; }

# --redeploy only restarts the current build with converged variables; it never
# pulls or builds a new image. Pairing it with a --release that does not match
# the box's own record is almost always an operator meaning to upgrade and
# silently keeping the old code running instead.
if [ "$REDEPLOY" = "1" ] && [ "$FORCE_REDEPLOY_SAME_BUILD" = "0" ] && has_var AGENTDASH_RELEASE_TAG; then
  CURRENT_RELEASE="$(variable_value "$PROJECT_ID" "$ENV_ID" "$WEB_ID" AGENTDASH_RELEASE_TAG)" \
    || die "could not read the box's current AGENTDASH_RELEASE_TAG; refusing to continue"
  if [ -n "$CURRENT_RELEASE" ] && [ "$CURRENT_RELEASE" != "$RELEASE" ]; then
    die "--redeploy restarts the current build; to upgrade to ${RELEASE} run without --redeploy \
(add --from-source if no image exists). Pass --force-redeploy-same-build if you really mean to \
restart the current build under the ${RELEASE} label."
  fi
fi

LAST_DEPLOYMENT_LINE="$(latest_deployment "$PROJECT_ID" "$ENV_ID" "$WEB_ID")" \
  || die "could not read the box's deployments; refusing to continue"
read -r LAST_DEPLOYMENT _ <<<"$LAST_DEPLOYMENT_LINE" || true
if [ -n "$LAST_DEPLOYMENT" ] && [ "$DESTROY_SECRETS" = "0" ]; then
  for secret in BETTER_AUTH_SECRET PAPERCLIP_SECRETS_MASTER_KEY AGENTDASH_INVITE_CODES; do
    has_var "$secret" || die "box has been deployed but ${secret} is missing; generating a new one would \
lock users out or make stored secrets unreadable. Restore it from escrow, or pass \
--i-know-this-destroys-secrets if this box's data is being discarded."
  done
fi

VARS_FILE="$(mktemp "${STATE_DIR}/vars.XXXXXX")"
chmod 600 "$VARS_FILE"
NEW_CODE_FILE=""
cleanup_tmp() { rm -f "$VARS_FILE" "${STATE_DIR}"/secret.* 2>/dev/null || true; }
trap cleanup_tmp EXIT

jq -n \
  --arg url "$PUBLIC_URL" --arg allowed "$ALLOWED" --arg release "$RELEASE" --arg slug "$SLUG" --arg pg "$PG_NAME" '{
    PORT: "3100",
    PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
    PAPERCLIP_PUBLIC_URL: $url,
    PAPERCLIP_AUTH_PUBLIC_BASE_URL: $url,
    BILLING_PUBLIC_BASE_URL: $url,
    PAPERCLIP_ALLOWED_HOSTNAMES: $allowed,
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    DATABASE_URL: ("${{" + $pg + ".DATABASE_URL}}"),
    AGENTDASH_SELF_SERVE_BOOTSTRAP: "true",
    AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: "true",
    AGENTDASH_INVITE_VALIDATION_URL: ($url + "/api/invites/validate"),
    AGENTDASH_FREE_AGENT_CAP: "2",
    AGENTDASH_DEPLOYMENT_KIND: "hosted",
    AGENTDASH_HERMES_MANAGED_PROFILES: "true",
    AGENTDASH_TRIAL_ANONYMOUS: "false",
    AGENTDASH_RELEASE_TAG: $release,
    AGENTDASH_BOX_SLUG: $slug
  }' >"$VARS_FILE"

# add_secret NAME FILE: merge a secret from a mode-600 file (jq --rawfile), never argv.
add_secret() {
  local tmp; tmp="$(mktemp "${STATE_DIR}/vars.XXXXXX")"; chmod 600 "$tmp"
  jq --arg k "$1" --rawfile v "$2" '. + {($k): $v}' <"$VARS_FILE" >"$tmp" && mv "$tmp" "$VARS_FILE"
}
add_plain() { # add_plain NAME VALUE (non-secret)
  local tmp; tmp="$(mktemp "${STATE_DIR}/vars.XXXXXX")"; chmod 600 "$tmp"
  jq --arg k "$1" --arg v "$2" '. + {($k): $v}' <"$VARS_FILE" >"$tmp" && mv "$tmp" "$VARS_FILE"
}
if ! has_var BETTER_AUTH_SECRET; then
  say "generating BETTER_AUTH_SECRET"
  f="$(new_secret_file "$STATE_DIR")"; write_random_hex "$f" 32; add_secret BETTER_AUTH_SECRET "$f"
fi
if ! has_var PAPERCLIP_SECRETS_MASTER_KEY; then
  say "generating PAPERCLIP_SECRETS_MASTER_KEY"
  f="$(new_secret_file "$STATE_DIR")"; write_random_b64 "$f" 32; add_secret PAPERCLIP_SECRETS_MASTER_KEY "$f"
fi
if [ "$CLOSE_SIGNUP" = "1" ]; then
  # Close the door: sign-up off, and the code replaced by one nobody holds
  # (it keeps the #726 guard's "invite codes configured" condition true too).
  say "closing sign-up: PAPERCLIP_AUTH_DISABLE_SIGN_UP=true, invite code rotated to an unrecorded value"
  add_plain PAPERCLIP_AUTH_DISABLE_SIGN_UP "true"
  f="$(new_secret_file "$STATE_DIR")"; write_invite_code "$f"; add_secret AGENTDASH_INVITE_CODES "$f"
elif ! has_var AGENTDASH_INVITE_CODES || [ "$ROTATE_INVITE" = "1" ]; then
  say "generating a new invite code (written to ${INVITE_FILE} once Railway has it)"
  NEW_CODE_FILE="$(new_secret_file "$STATE_DIR")"; write_invite_code "$NEW_CODE_FILE"
  add_secret AGENTDASH_INVITE_CODES "$NEW_CODE_FILE"
fi
[ "$OPEN_SIGNUP" = "0" ] || { say "reopening sign-up"; add_plain PAPERCLIP_AUTH_DISABLE_SIGN_UP "false"; }

upsert_variables "$PROJECT_ID" "$ENV_ID" "$WEB_ID" "$VARS_FILE" \
  || die "variable update failed; nothing was changed on the box and no code file was written"
say "variables converged: $(jq -r 'keys | join(" ")' <"$VARS_FILE")"

# Only now, with Railway holding it, does the new code reach the code file.
if [ -n "$NEW_CODE_FILE" ]; then
  mv -f "$NEW_CODE_FILE" "$INVITE_FILE"; chmod 600 "$INVITE_FILE"
fi
if [ "$CLOSE_SIGNUP" = "1" ]; then
  rm -f "$INVITE_FILE"
fi
if [ "$DEPLOY" = "0" ] && { [ "$ROTATE_INVITE" = "1" ] || [ "$CLOSE_SIGNUP" = "1" ] || [ "$OPEN_SIGNUP" = "1" ] || [ "$USE_CUSTOM" = "1" ]; }; then
  echo "WARNING: --no-deploy: the running box still uses its OLD settings, and the OLD invite code" >&2
  echo "         stays valid, until you run this script again with --redeploy." >&2
fi

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
  PREV_DEPLOYMENT="$LAST_DEPLOYMENT"
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
  1. The invite code is in ${INVITE_FILE} (mode 600). It is NOT single-use:
     anyone holding it can sign up until step 4. Hand it to the founder out of
     band; never paste it into chat, a ticket or a commit.
  2. The founder runs:   scripts/hosted/claim-box.sh ${PUBLIC_URL} --code-file <path to the code>
     It asks for their name, email and a password, and creates their account.
  3. The founder signs in at ${PUBLIC_URL}/auth and creates their company.
     The first company on a fresh box makes its creator the instance admin.
  4. The operator closes sign-up (teammates then join by company invite, which needs #731):
       scripts/hosted/provision-box.sh --slug ${SLUG} --release ${RELEASE} --close-signup --redeploy
     (config-only change, same release ${RELEASE}: --redeploy is correct here.)
  5. To upgrade this box to a new release later, run WITHOUT --redeploy (it only
     restarts the current build; it does not pull or build the new release):
       scripts/hosted/provision-box.sh --slug ${SLUG} --release <new tag> [--from-source]
EOF
