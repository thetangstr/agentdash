#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${REPO_ROOT:-}" ]; then
  REPO_ROOT="$SCRIPT_ROOT"
fi
# shellcheck source=./release-lib.sh
. "$SCRIPT_ROOT/scripts/release-lib.sh"

dry_run=false
version=""
assets=()
image_digest=""
image_repo=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/create-github-release.sh <version> [--asset <path>]...
      [--image-digest <sha256:...> [--image-repo <registry/path>]] [--dry-run]

Examples:
  ./scripts/create-github-release.sh 2026.318.0
  ./scripts/create-github-release.sh 2026.318.0 --asset /tmp/release-control.json
  ./scripts/create-github-release.sh 2026.318.0 --dry-run

Notes:
  - Run this after pushing the stable tag.
  - Assets are optional; with none, only the release itself is published.
  - Resolves the git remote automatically.
  - In GitHub Actions, origin is used explicitly.
  - If the release already exists, this script updates its title and notes.
  - --image-digest appends a "Container image" section (tag + digest of the
    stable GHCR image, #732) to the notes. The repo defaults to
    ghcr.io/thetangstr/agentdash; see scripts/release-image.mjs.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --asset)
      shift
      [ $# -gt 0 ] || { echo "Error: --asset requires a path." >&2; exit 1; }
      assets+=("$1")
      ;;
    --image-digest)
      shift
      [ $# -gt 0 ] || { echo "Error: --image-digest requires a sha256 digest." >&2; exit 1; }
      image_digest="$1"
      ;;
    --image-repo)
      shift
      [ $# -gt 0 ] || { echo "Error: --image-repo requires a registry path." >&2; exit 1; }
      image_repo="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$version" ]; then
        echo "Error: only one version may be provided." >&2
        exit 1
      fi
      version="$1"
      ;;
  esac
  shift
done

if [ -z "$version" ]; then
  usage
  exit 1
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be a stable calendar version like 2026.318.0." >&2
  exit 1
fi

tag="v$version"
notes_file="$(release_notes_file "$version")"
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -z "${PUBLISH_REMOTE:-}" ] && git_remote_exists origin; then
  PUBLISH_REMOTE=origin
fi
PUBLISH_REMOTE="$(resolve_release_remote)"
if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI is required to create GitHub releases." >&2
  exit 1
fi

GITHUB_REPO="$(github_repo_from_remote "$PUBLISH_REMOTE" || true)"
if [ -z "$GITHUB_REPO" ]; then
  echo "Error: could not determine GitHub repository from remote $PUBLISH_REMOTE." >&2
  exit 1
fi

if [ ! -f "$notes_file" ]; then
  echo "Error: release notes file not found at $notes_file." >&2
  exit 1
fi

# AgentDash (#732): record the stable image's digest in the release body. The
# committed notes file is never modified; the body is the notes plus a
# generated section, written to a temp file.
if [ -n "$image_repo" ] && [ -z "$image_digest" ]; then
  echo "Error: --image-repo requires --image-digest." >&2
  exit 1
fi
if [ -n "$image_digest" ]; then
  image_args=(section "$version" "$image_digest")
  if [ -n "$image_repo" ]; then
    image_args+=(--repo "$image_repo")
  fi
  image_section="$(node "$SCRIPT_ROOT/scripts/release-image.mjs" "${image_args[@]}")"
  body_file="$(mktemp "${TMPDIR:-/tmp}/agentdash-release-notes.XXXXXX")"
  trap 'rm -f "$body_file"' EXIT
  { cat "$notes_file"; printf '\n%s\n' "$image_section"; } > "$body_file"
  notes_file="$body_file"
fi

# Assets are optional, and an empty array must stay expandable.
#
# `"${assets[@]}"` on an empty array is an unbound-variable error under `set -u`
# in bash 3.2, which is what /bin/bash still is on macOS. So running this script
# by hand on a Mac with no `--asset` failed before it did anything, while CI
# never saw it: the release workflow always passes assets, and Ubuntu runners
# ship bash 5. Guarded the way the upload at the end of this file already is.
if [ "${#assets[@]}" -gt 0 ]; then
  for asset in "${assets[@]}"; do
    if [ ! -f "$asset" ]; then
      echo "Error: release asset not found at $asset." >&2
      exit 1
    fi
  done
fi

if [ "$dry_run" = true ]; then
  printf '[dry-run] gh release create %q -R %q --title %q --notes-file %q' "$tag" "$GITHUB_REPO" "$tag" "$notes_file"
  if [ "${#assets[@]}" -gt 0 ]; then
    for asset in "${assets[@]}"; do
      printf ' --asset %q' "$asset"
    done
  fi
  printf '\n'
  if [ -n "$image_digest" ]; then
    printf '[dry-run] release body ends with:\n%s\n' "$image_section"
  fi
  exit 0
fi

if ! git -C "$REPO_ROOT" rev-parse "$tag" >/dev/null 2>&1; then
  echo "Error: local git tag $tag does not exist." >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" ls-remote --exit-code --tags "$PUBLISH_REMOTE" "refs/tags/$tag" >/dev/null 2>&1; then
  echo "Error: remote tag $tag was not found on $PUBLISH_REMOTE. Push the release commit and tag first." >&2
  exit 1
fi

if gh release view "$tag" -R "$GITHUB_REPO" >/dev/null 2>&1; then
  gh release edit "$tag" -R "$GITHUB_REPO" --title "$tag" --notes-file "$notes_file"
  echo "Updated GitHub Release $tag"
else
  gh release create "$tag" -R "$GITHUB_REPO" --title "$tag" --notes-file "$notes_file"
  echo "Created GitHub Release $tag"
fi

if [ "${#assets[@]}" -gt 0 ]; then
  gh release upload "$tag" -R "$GITHUB_REPO" "${assets[@]}" --clobber
  echo "Uploaded ${#assets[@]} release-control asset(s) to $tag"
fi
