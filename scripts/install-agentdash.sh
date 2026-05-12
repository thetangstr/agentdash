#!/usr/bin/env bash
# install-agentdash.sh — One-line install script for AgentDash
#
# Usage:
#   curl -fsSL https://get.agentdash.ai | bash
#
# Or with options:
#   curl -fsSL https://get.agentdash.ai | bash -s -- --version 0.1.0 --dir ~/agentdash

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
REPO="thetangstr/agentdash"
INSTALL_DIR="${AGENTDASH_DIR:-${HOME}/agentdash}"
VERSION="latest"
FORCE=false

# ── Parse arguments ───────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --version=*) VERSION="${arg#*=}"; shift ;;
    --dir=*) INSTALL_DIR="${arg#*=}"; shift ;;
    --force) FORCE=true; shift ;;
  esac
done

# Allow piping arguments: curl ... | bash -s -- --version 0.1.0
if [[ "${1:-}" == "--" ]]; then shift; fi
for arg in "$@"; do
  case "$arg" in
    --version=*) VERSION="${arg#*=}"; shift ;;
    --dir=*) INSTALL_DIR="${arg#*=}"; shift ;;
    --force) FORCE=true; shift ;;
  esac
done

# ── OS Detection ─────────────────────────────────────────────────────────────
detect_os() {
  case "$(uname -s)" in
    Darwin*) echo "darwin" ;;
    Linux*)  echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo " unsupported" >&2; exit 1 ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "amd64" ;;
    arm64|aarch64)  echo "arm64" ;;
    *)
      echo " unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

# ── Download URL ─────────────────────────────────────────────────────────────
get_download_url() {
  local os=$1
  local arch=$2
  local ext="tar.gz"
  local filename="agentdash-${os}-${arch}.${ext}"

  if [[ "$VERSION" == "latest" ]]; then
    local tag
    tag=$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"tag_name": "v?([^"]+)".*/\1/')
    echo "https://github.com/${REPO}/releases/download/${tag}/${filename}"
  else
    echo "https://github.com/${REPO}/releases/download/v${VERSION}/${filename}"
  fi
}

# ── Install ─────────────────────────────────────────────────────────────────
install() {
  local os=$(detect_os)
  local arch=$(detect_arch)
  local url=$(get_download_url "$os" "$arch")

  echo "==> Installing AgentDash ${VERSION:-latest} for ${os}-${arch}"
  echo "    URL: $url"

  # Create install directory
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  # Download and extract
  echo "    Downloading..."
  if command -v curl >/dev/null 2>&1; then
    curl -fSL "$url" -o "agentdash.tar.gz"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "agentdash.tar.gz" "$url"
  else
    echo "    Error: curl or wget is required to download AgentDash" >&2
    exit 1
  fi

  echo "    Extracting..."
  tar -xzf "agentdash.tar.gz"
  rm -f "agentdash.tar.gz"

  # Make executable
  chmod +x "${INSTALL_DIR}/agentdash" 2>/dev/null || true
  chmod +x "${INSTALL_DIR}/bin/agentdash" 2>/dev/null || true

  echo ""
  echo "==> AgentDash installed to ${INSTALL_DIR}"
  echo ""
  echo "    Add to PATH:"
  echo "      export PATH=\${HOME}/agentdash:\${PATH}"
  echo ""
  echo "    Run setup:"
  echo "      agentdash setup"
  echo ""
  echo "    Start:"
  echo "      agentdash start"
}

# ── Check if already installed ───────────────────────────────────────────────
check_existing() {
  if [[ -f "${INSTALL_DIR}/agentdash" ]] || [[ -f "${INSTALL_DIR}/bin/agentdash" ]]; then
    if [[ "$FORCE" != "true" ]]; then
      echo "==> AgentDash is already installed at ${INSTALL_DIR}"
      echo "    Use --force to reinstall"
      exit 0
    fi
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────
echo ""
echo "    __          __             __                      __  ___"
echo "   / /  ___    / /  ___  ___  / /  __ __ ___ _ _____ / /_/ _ |"
echo "  / _ \/ -_)  / _ \/ _ \/ _ \/ _ \/ // // _ \`/ /_ // / / __ |||"
echo " /_//_/\__/  /_//_/\___/\___/_//_/\_, / \_,_/__//_//_/ /_/ | ||"
echo "                                  /___/"
echo ""
echo "Installing AgentDash — AI agent team orchestration"
echo ""

check_existing
install

echo "    Done!"
