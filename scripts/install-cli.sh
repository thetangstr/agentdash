#!/usr/bin/env bash
# AgentDash: install the `agentdash` CLI onto the user's PATH.
#
# Picks the best writable directory in this order:
#   1. /usr/local/bin (Intel Mac default, common on Linux)
#   2. /opt/homebrew/bin (Apple Silicon Mac default with Homebrew)
#   3. ~/.local/bin (modern XDG default; works without sudo)
#
# Creates a symlink at <chosen-dir>/agentdash → bin/agentdash. Also
# symlinks `paperclipai` so the legacy command name still works.
#
# If the chosen directory isn't on PATH, prints the export line the user
# needs to add to their shell rc.
set -e

REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
WRAPPER="$REPO_ROOT/bin/agentdash"

if [ ! -x "$WRAPPER" ]; then
  echo "Marking $WRAPPER executable…"
  chmod +x "$WRAPPER"
fi

CANDIDATES=(
  "/usr/local/bin"
  "/opt/homebrew/bin"
  "$HOME/.local/bin"
)

# If a previous install left a symlink that points somewhere else, we'll
# overwrite it. We never overwrite a regular file.
choose_target() {
  for dir in "${CANDIDATES[@]}"; do
    # Existing dir, writable → use it.
    if [ -d "$dir" ] && [ -w "$dir" ]; then
      echo "$dir"
      return 0
    fi
    # Doesn't exist yet but the parent is writable → create it (only for
    # ~/.local/bin; we don't auto-create system dirs).
    if [ "$dir" = "$HOME/.local/bin" ] && [ -w "$HOME" ]; then
      mkdir -p "$dir"
      echo "$dir"
      return 0
    fi
  done
  return 1
}

if ! TARGET_DIR="$(choose_target)"; then
  echo "agentdash: couldn't find a writable directory for the CLI symlink." >&2
  echo "agentdash: tried ${CANDIDATES[*]}" >&2
  echo "agentdash: try \`sudo bash $0\` or create one of those dirs writable." >&2
  exit 1
fi

create_symlink() {
  local name="$1"
  local target="$TARGET_DIR/$name"

  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ ! -L "$target" ]; then
      echo "agentdash: refusing to overwrite regular file at $target" >&2
      echo "agentdash: rename or remove it first, then re-run." >&2
      return 1
    fi
    rm -f "$target"
  fi
  ln -s "$WRAPPER" "$target"
  echo "  ✓ $target → $WRAPPER"
}

echo "Installing AgentDash CLI symlinks into $TARGET_DIR…"
create_symlink "agentdash"
create_symlink "paperclipai"

# PATH check — warn the user if the target dir isn't already on PATH.
case ":$PATH:" in
  *":$TARGET_DIR:"*)
    echo ""
    echo "Done. Try \`agentdash --help\` from any directory."
    ;;
  *)
    echo ""
    echo "agentdash: $TARGET_DIR isn't on your PATH yet."
    case "$SHELL" in
      */zsh)  RC="$HOME/.zshrc"  ;;
      */bash) RC="$HOME/.bashrc" ;;
      *)      RC="your shell rc" ;;
    esac
    echo "agentdash: add this line to $RC and re-open your terminal:"
    echo ""
    echo "    export PATH=\"$TARGET_DIR:\$PATH\""
    echo ""
    ;;
esac
