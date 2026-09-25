#!/usr/bin/env bash
# AgentDash: shared helpers for the hosted-box scripts (doc/runbooks/hosted-box.md).
#
# Sourced, never run. Talks to Railway's public GraphQL API with the token the
# Railway CLI already holds, so the scripts never need a second credential.
# Nothing here prints a variable VALUE; callers ask for names or pipe values
# straight into the tool that needs them.

set -euo pipefail

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

railway_token() {
  if [ -n "${RAILWAY_API_TOKEN:-}" ]; then
    printf '%s' "$RAILWAY_API_TOKEN"
    return
  fi
  local cfg="${HOME}/.railway/config.json"
  [ -f "$cfg" ] || die "no Railway credentials: run 'railway login' or set RAILWAY_API_TOKEN"
  local token
  token="$(jq -r '.user.token // empty' "$cfg")"
  [ -n "$token" ] || die "the Railway CLI is not logged in: run 'railway login'"
  printf '%s' "$token"
}

# gql '<query>' '<variables-json>'  -> prints the JSON response, dies on errors.
# The request body goes through stdin so no value ever lands on a command line.
gql() {
  local query="$1" vars="${2:-}"
  [ -n "$vars" ] || vars='{}'
  local resp
  resp="$(jq -n --arg q "$query" --argjson v "$vars" '{query: $q, variables: $v}' \
    | curl -sS --fail-with-body "$RAILWAY_GQL_URL" \
        -H "Authorization: Bearer $(railway_token)" \
        -H 'Content-Type: application/json' \
        -d @-)" || { echo "Railway API request failed: $(jq -c '[.errors[]?.message]' <<<"${resp:-{\}}" 2>/dev/null)" >&2; return 1; }
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
  ids="$(gql 'query { me { workspaces { id } } }' | jq -r '.data.me.workspaces[].id')"
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

validate_slug() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}[a-z0-9]$ ]] \
    || die "slug must be 3-32 chars of a-z, 0-9 and '-', starting with a letter"
}

# find_project <name> -> prints the project JSON {id,name,environments,services} or nothing
find_project() {
  local name="$1"
  gql 'query($w:String!){ projects(workspaceId:$w){ edges { node {
          id name
          environments { edges { node { id name } } }
          services { edges { node { id name } } }
        } } } }' "$(jq -n --arg w "$(workspace_id)" '{w:$w}')" \
    | jq -c --arg n "$name" '[.data.projects.edges[].node | select(.name == $n)] | first // empty'
}

env_id_of() { jq -r '[.environments.edges[].node | select(.name == "production")][0].id // empty' <<<"$1"; }
service_id_of() { jq -r --arg s "$2" '[.services.edges[].node | select(.name == $s)][0].id // empty' <<<"$1"; }

# variable_names <projectId> <envId> <serviceId>
variable_names() {
  gql 'query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s, unrendered:true) }' \
    "$(jq -n --arg p "$1" --arg e "$2" --arg s "$3" '{p:$p,e:$e,s:$s}')" \
    | jq -r '.data.variables | keys[]'
}

# variable_value <projectId> <envId> <serviceId> <NAME>  (for piping only; never echo it)
variable_value() {
  gql 'query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }' \
    "$(jq -n --arg p "$1" --arg e "$2" --arg s "$3" '{p:$p,e:$e,s:$s}')" \
    | jq -r --arg k "$4" '.data.variables[$k] // empty'
}

# upsert_variables <projectId> <envId> <serviceId> <json-object-file>
# Reads the variables from a file (mode 600) so values never touch argv.
upsert_variables() {
  local p="$1" e="$2" s="$3" file="$4"
  gql 'mutation($i:VariableCollectionUpsertInput!){ variableCollectionUpsert(input:$i) }' \
    "$(jq -c --arg p "$p" --arg e "$e" --arg s "$s" \
        '{i: {projectId:$p, environmentId:$e, serviceId:$s, variables: ., skipDeploys: true}}' "$file")" \
    >/dev/null
}

service_domain() {
  gql 'query($p:String!,$e:String!,$s:String!){ domains(projectId:$p, environmentId:$e, serviceId:$s){
         serviceDomains { domain } customDomains { domain } } }' \
    "$(jq -n --arg p "$1" --arg e "$2" --arg s "$3" '{p:$p,e:$e,s:$s}')" \
    | jq -r '.data.domains.serviceDomains[0].domain // empty'
}

custom_domain() {
  gql 'query($p:String!,$e:String!,$s:String!){ domains(projectId:$p, environmentId:$e, serviceId:$s){
         customDomains { domain } } }' \
    "$(jq -n --arg p "$1" --arg e "$2" --arg s "$3" '{p:$p,e:$e,s:$s}')" \
    | jq -r '.data.domains.customDomains[0].domain // empty'
}

# volume_instances <projectId> -> lines "volumeInstanceId serviceId mountPath volumeName"
volume_instances() {
  gql 'query($p:String!){ project(id:$p){ volumes { edges { node { name
         volumeInstances { edges { node { id serviceId mountPath } } } } } } } }' \
    "$(jq -n --arg p "$1" '{p:$p}')" \
    | jq -r '.data.project.volumes.edges[].node as $v
             | $v.volumeInstances.edges[].node
             | "\(.id) \(.serviceId) \(.mountPath) \($v.name)"'
}

random_hex() { openssl rand -hex "$1"; }
random_b64() { openssl rand -base64 "$1" | tr -d '\n'; }
# A human-typeable invite code with ~100 bits of entropy.
random_invite_code() {
  printf 'AGD-%s' "$(openssl rand -hex 13 | tr '[:lower:]' '[:upper:]')"
}

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

# latest_deployment <projectId> <envId> <serviceId> -> "id status" of the newest deployment
latest_deployment() {
  gql 'query($p:String!,$e:String!,$s:String!){ deployments(first:1, input:{projectId:$p, environmentId:$e, serviceId:$s}) { edges { node { id status } } } }' \
    "$(jq -n --arg p "$1" --arg e "$2" --arg s "$3" '{p:$p,e:$e,s:$s}')" \
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
    if [ -n "$id" ] && [ "$id" != "$4" ]; then
      case "$status" in
        SUCCESS) return 0 ;;
        FAILED|CRASHED|REMOVED|SKIPPED) echo "deployment ${id} ended ${status}" >&2; return 1 ;;
      esac
    fi
    [ $(( $(date +%s) - start )) -lt "$5" ] || { echo "timed out waiting for deployment" >&2; return 1; }
    sleep 15
  done
}
