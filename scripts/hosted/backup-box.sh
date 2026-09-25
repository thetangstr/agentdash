#!/usr/bin/env bash
# AgentDash: back up one hosted box, and optionally prove the backup restores.
#
# What a backup is (doc/runbooks/hosted-box.md, "Backups"):
#   1. db.dump      pg_dump (custom format) of the box's Postgres
#   2. volume.tgz   tar of the web service's /paperclip Volume (Paperclip home;
#                   Hermes home, profiles and ledgers once #721 lands)
#   3. Railway volume snapshots of both volumes (best effort; plan-dependent)
# The secrets master key is NOT in the backup: it lives in the Railway
# variable PAPERCLIP_SECRETS_MASTER_KEY and must be escrowed separately.
#
# --restore-test restores db.dump into a throwaway local Postgres container
# (never over live data), compares row counts for the core tables against the
# live database, checks volume.tgz lists cleanly, prints the timings, and
# removes the container.
#
# Usage:
#   scripts/hosted/backup-box.sh --slug <slug> [--restore-test] [--out <dir>]
#
# Needs: railway (logged in), jq, curl, docker. Output dir is mode 700 and
# defaults to ~/.agentdash-boxes/<slug>/backups/<UTC timestamp>.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

SLUG="" RESTORE_TEST=0 OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    --restore-test) RESTORE_TEST=1; shift ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$SLUG" ] || die "--slug is required"
validate_slug "$SLUG"
require_tools railway jq curl docker base64

PROJECT_NAME="${BOX_PROJECT_PREFIX}${SLUG}"
assert_box_project_name "$PROJECT_NAME"
STATE_DIR="$(box_state_dir "$SLUG")"
PROJECT_JSON="$(find_project "$PROJECT_NAME")"
[ -n "$PROJECT_JSON" ] || die "no project ${PROJECT_NAME}"
PROJECT_ID="$(jq -r .id <<<"$PROJECT_JSON")"
ENV_ID="$(env_id_of "$PROJECT_JSON")"
PG_ID="$(postgres_service_id_of "$PROJECT_JSON")"
WEB_ID="$(service_id_of "$PROJECT_JSON" web)"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-${STATE_DIR}/backups/${STAMP}}"
mkdir -p "$OUT"; chmod 700 "$OUT" "$(dirname "$OUT")"
umask 077

# A box's Postgres has no public endpoint. Open a TCP proxy for the duration of
# the backup and delete it on exit, so the database is reachable from the
# internet (password-protected) only while this script runs.
PROXY_ID=""
ENV_FILE="$(mktemp "${STATE_DIR}/pgenv.XXXXXX")"
close_proxy() {
  rm -f "$ENV_FILE"
  if [ -n "$PROXY_ID" ]; then
    gql 'mutation($id:String!){ tcpProxyDelete(id:$id) }' "$(jq -n --arg id "$PROXY_ID" '{id:$id}')" >/dev/null \
      && say "closed the temporary Postgres TCP proxy" \
      || echo "warning: could not delete TCP proxy ${PROXY_ID}; delete it in the Railway dashboard" >&2
  fi
}
trap close_proxy EXIT
PROXY="$(gql 'mutation($i:TCPProxyCreateInput!){ tcpProxyCreate(input:$i){ id domain proxyPort } }' \
  "$(jq -n --arg e "$ENV_ID" --arg s "$PG_ID" '{i:{environmentId:$e, serviceId:$s, applicationPort:5432}}')")" \
  || die "could not open a TCP proxy to Postgres"
PROXY_ID="$(jq -r .data.tcpProxyCreate.id <<<"$PROXY")"
PROXY_HOST="$(jq -r '.data.tcpProxyCreate.domain | rtrimstr(".")' <<<"$PROXY")"
PROXY_PORT="$(jq -r .data.tcpProxyCreate.proxyPort <<<"$PROXY")"
say "opened a temporary Postgres TCP proxy"
# Credentials go to docker through an env file (mode 600), never argv or output.
{
  printf 'PGHOST=%s\nPGPORT=%s\n' "$PROXY_HOST" "$PROXY_PORT"
  printf 'PGUSER=%s\n' "$(variable_value "$PROJECT_ID" "$ENV_ID" "$PG_ID" PGUSER)"
  printf 'PGPASSWORD=%s\n' "$(variable_value "$PROJECT_ID" "$ENV_ID" "$PG_ID" PGPASSWORD)"
  printf 'PGDATABASE=%s\n' "$(variable_value "$PROJECT_ID" "$ENV_ID" "$PG_ID" PGDATABASE)"
  printf 'PGSSLMODE=require\nPGCONNECT_TIMEOUT=10\n'
} >"$ENV_FILE"
for _ in $(seq 1 30); do
  docker run --rm --env-file "$ENV_FILE" postgres:18 pg_isready -q >/dev/null 2>&1 && break
  sleep 5
done

PG_MAJOR="$(docker run --rm --env-file "$ENV_FILE" postgres:18 psql -Atc "show server_version_num" | cut -c1-2)"
PG_IMAGE="postgres:${PG_MAJOR}"
say "server is Postgres ${PG_MAJOR}; using ${PG_IMAGE} client"

# --- 1. Postgres dump ---------------------------------------------------------
t0="$(date +%s)"
docker run --rm --env-file "$ENV_FILE" -v "$OUT:/out" "$PG_IMAGE" \
  pg_dump --format=custom --no-owner --no-privileges --file=/out/db.dump
say "db.dump $(du -h "$OUT/db.dump" | cut -f1) in $(( $(date +%s) - t0 ))s"

# --- 2. Volume tarball (base64 over railway ssh, so binary survives the PTY) --
t0="$(date +%s)"
if (cd "$STATE_DIR" && railway ssh --project "$PROJECT_ID" --environment production --service web -- sh -c "'tar czf - -C /paperclip . 2>/dev/null | base64 -w0'") \
    | tr -d '\r' | base64 -d >"$OUT/volume.tgz" 2>/dev/null && tar tzf "$OUT/volume.tgz" >/dev/null 2>&1; then
  say "volume.tgz $(du -h "$OUT/volume.tgz" | cut -f1), $(tar tzf "$OUT/volume.tgz" | wc -l | tr -d ' ') entries, in $(( $(date +%s) - t0 ))s"
else
  echo "warning: could not export /paperclip over railway ssh; rely on the Railway volume snapshot" >&2
  rm -f "$OUT/volume.tgz"
fi

# --- 3. Railway volume snapshots (best effort) ---------------------------------
while read -r vi_id _svc mount _name; do
  [ -n "$vi_id" ] || continue
  if gql 'mutation($v:String!,$n:String){ volumeInstanceBackupCreate(volumeInstanceId:$v, name:$n){ workflowId } }' \
      "$(jq -n --arg v "$vi_id" --arg n "manual-${STAMP}" '{v:$v,n:$n}')" >/dev/null 2>&1; then
    say "Railway snapshot requested for ${mount}"
  else
    echo "warning: Railway snapshot refused for ${mount} (Hobby plans cannot snapshot volumes)" >&2
  fi
done < <(volume_instances "$PROJECT_ID")

# --- 4. Manifest (names and counts only, no values) ----------------------------
COUNT_SQL="select 'companies',count(*) from companies union all select 'users',count(*) from \"user\"
  union all select 'agents',count(*) from agents union all select 'issues',count(*) from issues
  union all select 'memberships',count(*) from company_memberships
  union all select 'instance_admins',count(*) from instance_user_roles where role='instance_admin'
  union all select 'migrations',count(*) from drizzle.__drizzle_migrations
  union all select 'public_tables',count(*) from information_schema.tables where table_schema='public'
  union all select 'public_columns',count(*) from information_schema.columns where table_schema='public'"
docker run --rm --env-file "$ENV_FILE" "$PG_IMAGE" psql -At -F= -c "$COUNT_SQL" >"$OUT/live-counts.txt"
jq -n --arg slug "$SLUG" --arg at "$STAMP" --arg pg "$PG_MAJOR" \
  --arg release "$(variable_value "$PROJECT_ID" "$ENV_ID" "$WEB_ID" AGENTDASH_RELEASE_TAG)" \
  '{slug:$slug, takenAt:$at, postgresMajor:$pg, release:$release,
    masterKey:"not included: Railway variable PAPERCLIP_SECRETS_MASTER_KEY, escrow separately"}' >"$OUT/manifest.json"
say "backup written to ${OUT}"

[ "$RESTORE_TEST" = "1" ] || exit 0

# --- 5. Restore test into a scratch container ---------------------------------
NAME="agentdash-restore-test-${SLUG}-$$"
SCRATCH_ENV="$(mktemp "${STATE_DIR}/scratchenv.XXXXXX")"
{ printf 'POSTGRES_PASSWORD='; openssl rand -hex 16; printf 'POSTGRES_DB=restore\n'; } >"$SCRATCH_ENV"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -f "$SCRATCH_ENV"; close_proxy; }
trap cleanup EXIT
say "restore test: starting scratch ${PG_IMAGE} container ${NAME}"
docker run -d --name "$NAME" --env-file "$SCRATCH_ENV" \
  -v "$OUT:/in:ro" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 30); do
  docker exec "$NAME" pg_isready -U postgres -d restore >/dev/null 2>&1 && break
  sleep 1
done
t0="$(date +%s)"
docker exec "$NAME" pg_restore --no-owner --no-privileges -U postgres -d restore /in/db.dump 2>"$OUT/restore-stderr.txt" || true
RESTORE_SECS=$(( $(date +%s) - t0 ))
docker exec "$NAME" psql -U postgres -d restore -At -F= -c "$COUNT_SQL" >"$OUT/restored-counts.txt"
if diff -u "$OUT/live-counts.txt" "$OUT/restored-counts.txt"; then
  say "restore test PASSED in ${RESTORE_SECS}s: $(tr '\n' ' ' <"$OUT/restored-counts.txt")"
  [ -s "$OUT/restore-stderr.txt" ] && echo "note: pg_restore warnings in $OUT/restore-stderr.txt" >&2
else
  die "restore test FAILED: restored counts differ from live (see $OUT)"
fi
if [ -f "$OUT/volume.tgz" ]; then
  mkdir -p "$OUT/volume-restore-test" && tar xzf "$OUT/volume.tgz" -C "$OUT/volume-restore-test" \
    && say "volume.tgz extracts cleanly ($(find "$OUT/volume-restore-test" -type f | wc -l | tr -d ' ') files)"
  rm -rf "$OUT/volume-restore-test"
fi
