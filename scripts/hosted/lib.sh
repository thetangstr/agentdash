#!/usr/bin/env bash
# AgentDash: shared helpers for the hosted-box scripts (doc/runbooks/hosted-box.md).
#
# Sourced, never run. Talks to Railway's public GraphQL API with the token the
# Railway CLI already holds, so the scripts never need a second credential.
#
# Secret handling rules, enforced here:
#   - No secret ever appears on a command line (argv is readable by every
#     process on the machine). Secrets move through stdin, pipes, or mode-600
#     files that jq reads with --rawfile / --slurpfile. Only shell builtins
#     (printf) ever hold a secret as an argument.
#   - The Railway token reaches curl through a --config read from a pipe.
#   - The scripts refuse to run with xtrace on (bash -x would print secrets).
#   - Nothing prints a variable VALUE; callers ask for names, or pipe values
#     straight into the file or tool that needs them.

set -euo pipefail

# Refuse xtrace: `bash -x` or `set -x` would echo every secret we handle.
case "$-" in
  *x*) set +x; echo "error: refusing to run with xtrace (bash -x / set -x); it would print secrets" >&2; exit 2 ;;
esac

RAILWAY_GQL_URL="${RAILWAY_GQL_URL:-https://backboard.railway.com/graphql/v2}"
BOX_STATE_ROOT="${AGENTDASH_BOX_STATE_DIR:-${HOME}/.agentdash-boxes}"
BOX_PROJECT_PREFIX="agentdash-box-"

# Projects these scripts must never touch, even by name collision.
PROTECTED_PROJECTS=("agentdash" "agentdash-demo" "yarda-backend-v2" "perceptive-integrity")

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*" >&2; }

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
  done
}

# Prints a curl config line carrying the auth header. Only builtins touch the
# token, and the output goes to curl through a pipe (--config -) or an fd.
railway_auth_config() {
  local token=""
  if [ -n "${RAILWAY_API_TOKEN:-}" ]; then
    token="$RAILWAY_API_TOKEN"
  else
    local cfg="${HOME}/.railway/config.json"
    [ -f "$cfg" ] || die "no Railway credentials: run 'railway login' or set RAILWAY_API_TOKEN"
    token="$(jq -r '.user.token // empty' <"$cfg")"
    [ -n "$token" ] || die "the Railway CLI is not logged in: run 'railway login'"
  fi
  printf 'header = "Authorization: Bearer %s"\n' "$token"
}

# gql '<query>' [<variables-json>]
#   Variables come from the second argument (IDs only, never secrets) or, when
#   it is "-", from stdin (use this whenever a value might be secret).
#   Prints the JSON response; returns non-zero on transport or GraphQL errors.
gql() {
  local query="$1" vars="${2:-}" body_file resp rc=0
  body_file="$(mktemp "${TMPDIR:-/tmp}/agentdash-gql.XXXXXX")"
  chmod 600 "$body_file"
  if [ "$vars" = "-" ]; then
    jq -c --arg q "$query" '{query: $q, variables: .}' >"$body_file" || { rm -f "$body_file"; return 1; }
  else
    [ -n "$vars" ] || vars='{}'
    jq -nc --arg q "$query" --argjson v "$vars" '{query: $q, variables: $v}' >"$body_file" \
      || { rm -f "$body_file"; return 1; }
  fi
  resp="$(railway_auth_config | curl -sS --fail-with-body --config - \
      -H 'Content-Type: application/json' \
      --data-binary "@${body_file}" \
      "$RAILWAY_GQL_URL")" || rc=$?
  rm -f "$body_file"
  if [ "$rc" -ne 0 ]; then
    echo "Railway API request failed (curl exit ${rc}): $(jq -c '[.errors[]?.message]' <<<"${resp:-null}" 2>/dev/null || true)" >&2
    return 1
  fi
  if ! jq -e 'type == "object"' <<<"$resp" >/dev/null 2>&1; then
    echo "Railway API returned a non-JSON response" >&2
    return 1
  fi
  if [ "$(jq -r 'has("errors")' <<<"$resp")" = "true" ]; then
    echo "Railway API error: $(jq -c '[.errors[].message]' <<<"$resp")" >&2
    return 1
  fi
  printf '%s' "$resp"
}

workspace_id() {
  if [ -n "${RAILWAY_WORKSPACE_ID:-}" ]; then
    printf '%s' "$RAILWAY_WORKSPACE_ID"
    return
  fi
  local ids
  ids="$(gql 'query { me { workspaces { id } } }' | jq -r '.data.me.workspaces[].id')" \
    || die "could not read Railway workspaces"
  [ "$(wc -l <<<"$ids" | tr -d ' ')" = "1" ] \
    || die "more than one Railway workspace; set RAILWAY_WORKSPACE_ID"
  printf '%s' "$ids"
}

assert_box_project_name() {
  local name="$1" p
  for p in "${PROTECTED_PROJECTS[@]}"; do
    [ "$name" != "$p" ] || die "refusing to touch protected project '$name'"
  done
  case "$name" in
    "${BOX_PROJECT_PREFIX}"*) ;;
    *) die "refusing to touch '$name': box projects are named ${BOX_PROJECT_PREFIX}<slug>" ;;
  esac
}

# Box slugs are capped at 16 at creation so the restore project
# "<slug>-restore" (up to 24) is itself a valid new slug.
validate_slug() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}[a-z0-9]$ ]] && [ "${#1}" -le 32 ] \
    || die "slug must be 3-32 chars of a-z, 0-9 and '-', starting with a letter"
}
BOX_SLUG_MAX=16
validate_new_slug() {
  validate_slug "$1"
  case "$1" in
    *-restore) [ "${#1}" -le $((BOX_SLUG_MAX + 8)) ] || die "restore slugs are '<box slug>-restore' with a box slug of at most ${BOX_SLUG_MAX} chars" ;;
    *) [ "${#1}" -le "$BOX_SLUG_MAX" ] || die "new box slugs are at most ${BOX_SLUG_MAX} chars (so '<slug>-restore' can always be created)" ;;
  esac
}

# find_project <name> -> the project JSON {id,name,environments,services} or nothing.
# Pages through every project in the workspace. Dies if the listing fails, so
# "not found" always means not found, never "the API call broke".
find_project() {
  local name="$1" ws cursor="" page found
  ws="$(workspace_id)"
  while :; do
    page="$(gql 'query($w:String!,$after:String){ projects(workspaceId:$w, first:50, after:$after){
          pageInfo { hasNextPage endCursor }
          edges { node {
            id name
            environments { edges { node { id name } } }
            services { edges { node { id name
              serviceInstances { edges { node { environmentId source { image } } } } } } }
          } } } }' "$(jq -nc --arg w "$ws" --arg a "$cursor" '{w:$w, after:(if $a == "" then null else $a end)}')")" \
      || die "could not list Railway projects"
    found="$(jq -c --arg n "$name" '[.data.projects.edges[].node | select(.name == $n)] | first // empty' <<<"$page")"
    if [ -n "$found" ]; then printf '%s' "$found"; return 0; fi
    [ "$(jq -r '.data.projects.pageInfo.hasNextPage' <<<"$page")" = "true" ] || return 0
    cursor="$(jq -r '.data.projects.pageInfo.endCursor' <<<"$page")"
  done
}

env_id_of() { jq -r '[.environments.edges[].node | select(.name == "production")][0].id // empty' <<<"$1"; }
service_id_of() { jq -r --arg s "$2" '[.services.edges[].node | select(.name == $s)][0].id // empty' <<<"$1"; }

# The box's database: the service running Railway's Postgres template image,
# whatever it is named. Falls back to the name "Postgres".
postgres_service_id_of() {
  jq -r '([.services.edges[].node
            | select(any(.serviceInstances.edges[]?.node.source.image // ""; test("postgres"; "i")))][0].id)
         // ([.services.edges[].node | select(.name == "Postgres")][0].id)
         // empty' <<<"$1"
}

# variable_names <projectId> <envId> <serviceId>
# Fails (non-zero) if the read fails or the response has no variables object:
# callers must never mistake "could not read" for "not set".
variable_names() {
  local resp
  resp="$(gql 'query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s, unrendered:true) }' \
    "$(jq -nc --arg p "$1" --arg e "$2" --arg s "$3" '{p:$p,e:$e,s:$s}')")" || return 1
  jq -e '.data.variables | type == "object"' <<<"$resp" >/dev/null || { echo "Railway returned no variables object" >&2; return 1; }
  jq -r '.data.variables | keys[]' <<<"$resp"
}

# variable_value <projectId> <envId> <serviceId> <NAME>  (for piping into a file only; never echo it)
variable_value() {
  local resp
  resp="$(gql 'query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }' \
    "$(jq -nc --arg p "$1" --arg e "$2" --arg s "$3" '{p:$p,e:$e,s:$s}')")" || return 1
  jq -r --arg k "$4" '.data.variables[$k] // empty' <<<"$resp"
}

# upsert_variables <projectId> <envId> <serviceId> <json-object-file>
# The variables stay in the mode-600 file and a pipe; never on argv.
upsert_variables() {
  local p="$1" e="$2" s="$3" file="$4"
  jq -c --arg p "$p" --arg e "$e" --arg s "$s" \
      '{i: {projectId:$p, environmentId:$e, serviceId:$s, variables: ., skipDeploys: true}}' <"$file" \
    | gql 'mutation($i:VariableCollectionUpsertInput!){ variableCollectionUpsert(input:$i) }' - >/dev/null
}

domains_json() {
  gql 'query($p:String!,$e:String!,$s:String!){ domains(projectId:$p, environmentId:$e, serviceId:$s){
         serviceDomains { domain } customDomains { domain status { verified certificateStatus } } } }' \
    "$(jq -nc --arg p "$1" --arg e "$2" --arg s "$3" '{p:$p,e:$e,s:$s}')"
}
service_domain() { domains_json "$@" | jq -r '.data.domains.serviceDomains[0].domain // empty'; }
custom_domain() { domains_json "$@" | jq -r '.data.domains.customDomains[0].domain // empty'; }
custom_domain_verified() { domains_json "$@" | jq -r '.data.domains.customDomains[0].status.verified // false'; }

# volume_instances <projectId> -> lines "volumeInstanceId serviceId mountPath volumeName"
volume_instances() {
  gql 'query($p:String!){ project(id:$p){ volumes { edges { node { name
         volumeInstances { edges { node { id serviceId mountPath } } } } } } } }' \
    "$(jq -nc --arg p "$1" '{p:$p}')" \
    | jq -r '.data.project.volumes.edges[].node as $v
             | $v.volumeInstances.edges[].node
             | "\(.id) \(.serviceId) \(.mountPath) \($v.name)"'
}

# Secret generators write straight to a mode-600 file (openssl's argv holds
# only the length, never the value).
new_secret_file() { local f; f="$(mktemp "$1/secret.XXXXXX")"; chmod 600 "$f"; printf '%s' "$f"; }
write_random_hex() { openssl rand -hex "$2" | tr -d '\n' >"$1"; }
write_random_b64() { openssl rand -base64 "$2" | tr -d '\n' >"$1"; }
# A human-typeable invite code with ~100 bits of entropy.
write_invite_code() { { printf 'AGD-'; openssl rand -hex 13 | tr '[:lower:]' '[:upper:]' | tr -d '\n'; } >"$1"; }

box_state_dir() {
  local dir="${BOX_STATE_ROOT}/$1"
  mkdir -p "$dir"
  chmod 700 "$BOX_STATE_ROOT" "$dir"
  printf '%s' "$dir"
}

# wait_for_health <https-url> <timeout-seconds>
wait_for_health() {
  local url="$1" timeout="$2" start body
  start="$(date +%s)"
  while :; do
    body="$(curl -s --max-time 10 "$url/api/health" || true)"
    if [ "$(jq -r '.status // empty' <<<"$body" 2>/dev/null)" = "ok" ]; then
      printf '%s' "$body"
      return 0
    fi
    [ $(( $(date +%s) - start )) -lt "$timeout" ] || return 1
    sleep 10
  done
}

# latest_deployment <projectId> <envId> <serviceId> -> "id status" of the newest deployment ("" if none)
latest_deployment() {
  gql 'query($p:String!,$e:String!,$s:String!){ deployments(first:1, input:{projectId:$p, environmentId:$e, serviceId:$s}) { edges { node { id status } } } }' \
    "$(jq -nc --arg p "$1" --arg e "$2" --arg s "$3" '{p:$p,e:$e,s:$s}')" \
    | jq -r '.data.deployments.edges[0].node | "\(.id // "") \(.status // "")"'
}

# wait_for_new_deployment <projectId> <envId> <serviceId> <previous-id> <timeout-seconds>
# Waits until a deployment newer than <previous-id> reaches a terminal state.
# Returns 0 on SUCCESS, 1 otherwise.
wait_for_new_deployment() {
  local start id status
  start="$(date +%s)"
  while :; do
    read -r id status <<<"$(latest_deployment "$1" "$2" "$3" || echo "- -")"
    if [ -n "$id" ] && [ "$id" != "-" ] && [ "$id" != "$4" ]; then
      case "$status" in
        SUCCESS) return 0 ;;
        FAILED|CRASHED|REMOVED|SKIPPED) echo "deployment ${id} ended ${status}" >&2; return 1 ;;
      esac
    fi
    [ $(( $(date +%s) - start )) -lt "$5" ] || { echo "timed out waiting for deployment" >&2; return 1; }
    sleep "${AGENTDASH_BOX_POLL_SECONDS:-15}"
  done
}
