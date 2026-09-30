#!/bin/zsh
# Scheduled over-the-air update for a source deployment.
#
# Runs the STANDALONE copy of the OTA apply tool under ~/.agentdash/bin, never
# the one in a release or the checkout: an update that changes the updater must
# not be able to take the tool that repairs it away. The copy is two files
# (ota-apply.mjs plus the ota-release-layout.mjs it imports), installed side by
# side so the relative import resolves.
#
# The copy is refreshed on every run from the release that is SERVING
# (releases/current), and falls back to the checkout only on a box that has no
# release yet. It used to come from the checkout unconditionally, and an apply
# never updates the checkout, so it drifts behind the serving release: the
# daily check ran a legacy updater and reported a commit nothing was serving. A
# healthy `ota-apply.mjs --tag` also installs this wrapper and both tools into
# ~/.agentdash/bin, which is where com.agentdash.update runs this file from.
# The refresh never downgrades: it is skipped when the serving release's
# ota-apply.mjs declares an older UPDATER_VERSION than the installed one (a
# rollback to a release that predates an updater fix), and the two files are
# replaced together or not at all.
#
# The git clone is only a source of releases here (`--repo-dir`): the check
# fetches tags from it and reads nothing else. AGENTDASH_REPO_DIR names it;
# it defaults to AGENTDASH_APP_DIR for plists written before the two were
# separated.
#
# Default posture is CHECK ONLY. `--check` resolves the newest release tag on
# origin/main, measures the diff, and writes available-release.json into the
# deployments state dir — the file the board's read-only status endpoint reads
# to offer an update. Nothing is applied by this job. That default is
# deliberate: a bad commit reaching main can reach a customer's Mini within
# the hour, and on 2026-08-18 exactly that happened — a change that passed
# review broke the agent's heartbeat in production. Rollback exists and is
# tested, but "it repairs itself afterwards" is a weaker promise than "a
# person decided".
#
# Unattended apply is DISABLED. Setting AGENTDASH_UPDATE_APPLY=1 makes this job
# exit non-zero with a clear reason: applying an immutable release layout does
# nothing on a box that serves straight from its git checkout (which is how the
# live customer box runs), and a restart that cannot kickstart still receipts
# "applied" while the old code keeps running. Apply wiring gets its own issue
# once the releases/current bootstrap is decided.
set -eu

INSTANCE="${AGENTDASH_INSTANCE:-mkboard}"
ENV_FILE="${AGENTDASH_ENV_FILE:-$HOME/.config/agentdash/${INSTANCE}.env}"
APP_DIR="${AGENTDASH_APP_DIR:-$HOME/agentdash}"
REPO_DIR="${AGENTDASH_REPO_DIR:-$APP_DIR}"
BIN_DIR="${AGENTDASH_BIN_DIR:-$HOME/.agentdash/bin}"
UPDATER="$BIN_DIR/ota-apply.mjs"
STATE_DIR="${AGENTDASH_OTA_STATE_DIR:-$HOME/.agentdash/deployments}"
RELEASES_ROOT="${AGENTDASH_RELEASES_ROOT:-$HOME/.agentdash/releases}"

export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

TOOLS_DIR="$APP_DIR"
if [ -f "$RELEASES_ROOT/current/scripts/deploy/ota-apply.mjs" ] && [ -f "$RELEASES_ROOT/current/scripts/deploy/ota-release-layout.mjs" ]; then
  TOOLS_DIR="$RELEASES_ROOT/current"
fi

# UPDATER_VERSION declared by an ota-apply.mjs (see that file); 0 when absent,
# which is every updater written before the constant existed.
updater_version() {
  v="$(sed -n 's/^export const UPDATER_VERSION = \([0-9][0-9]*\);$/\1/p' "$1" 2>/dev/null | head -n 1)"
  echo "${v:-0}"
}

# Refresh the installed pair from TOOLS_DIR, but never downgrade it: after a
# rollback to a release that predates an updater fix, releases/current holds
# the OLD updater, and copying it over the installed one would take the fix
# away. Both files are staged first and renamed into place together; if the
# second rename fails the first is put back, so the pair is never mixed.
refresh_updater() {
  src_apply="$TOOLS_DIR/scripts/deploy/ota-apply.mjs"
  src_layout="$TOOLS_DIR/scripts/deploy/ota-release-layout.mjs"
  dst_layout="$BIN_DIR/ota-release-layout.mjs"
  if [ -f "$UPDATER" ]; then
    have="$(updater_version "$UPDATER")"
    offered="$(updater_version "$src_apply")"
    if [ "$offered" -lt "$have" ]; then
      echo "[update] kept the installed updater (version $have); $TOOLS_DIR offers the older version $offered"
      return 0
    fi
  fi
  mkdir -p "$BIN_DIR"
  tmp_apply="$BIN_DIR/.ota-apply.mjs.$$.tmp"
  tmp_layout="$BIN_DIR/.ota-release-layout.mjs.$$.tmp"
  if ! cp "$src_apply" "$tmp_apply" || ! cp "$src_layout" "$tmp_layout" \
    || ! chmod 755 "$tmp_apply" "$tmp_layout"; then
    rm -f "$tmp_apply" "$tmp_layout"
    echo "[update] could not stage the updater from $TOOLS_DIR; $BIN_DIR left as it was" >&2
    return 1
  fi
  prev_layout=""
  if [ -f "$dst_layout" ]; then
    prev_layout="$BIN_DIR/.ota-release-layout.mjs.$$.prev"
    cp -p "$dst_layout" "$prev_layout" || { rm -f "$tmp_apply" "$tmp_layout"; return 1; }
  fi
  if ! mv -f "$tmp_layout" "$dst_layout"; then
    rm -f "$tmp_apply" "$tmp_layout" ${prev_layout:+"$prev_layout"}
    echo "[update] could not install the updater; $BIN_DIR left as it was" >&2
    return 1
  fi
  if ! mv -f "$tmp_apply" "$UPDATER"; then
    if [ -n "$prev_layout" ]; then mv -f "$prev_layout" "$dst_layout"; else rm -f "$dst_layout"; fi
    rm -f "$tmp_apply"
    echo "[update] could not install the updater; $BIN_DIR put back as it was" >&2
    return 1
  fi
  [ -n "$prev_layout" ] && rm -f "$prev_layout"
  return 0
}

refresh_updater

echo "[update] $(date -u +%Y-%m-%dT%H:%M:%SZ) instance=$INSTANCE apply=${AGENTDASH_UPDATE_APPLY:-0} tools=$TOOLS_DIR repo=$REPO_DIR"

if [ "${AGENTDASH_UPDATE_APPLY:-0}" = "1" ]; then
  # Apply is unsupported until the releases/current bootstrap is decided and
  # wired. Refuse loudly rather than fall back to check-only: a silent
  # fallback would leave an operator believing apply works.
  APP_REAL="$(cd "$APP_DIR" 2>/dev/null && pwd -P || echo "")"
  CURRENT_REAL="$(cd "$RELEASES_ROOT/current" 2>/dev/null && pwd -P || echo "")"
  if [ -z "$APP_REAL" ] || [ "$APP_REAL" != "$CURRENT_REAL" ]; then
    echo "[update] REFUSED: AGENTDASH_UPDATE_APPLY=1 but APP_DIR=$APP_DIR does not resolve to $RELEASES_ROOT/current — this box serves straight from a git checkout, where applying a release layout updates nothing the server runs." >&2
    exit 2
  fi
  echo "[update] REFUSED: AGENTDASH_UPDATE_APPLY=1 but unattended apply is unsupported until the releases/current bootstrap is done." >&2
  exit 2
fi

exec node "$UPDATER" \
  --repo-dir "$REPO_DIR" \
  --releases-root "$RELEASES_ROOT" \
  --state-dir "$STATE_DIR" \
  --check
