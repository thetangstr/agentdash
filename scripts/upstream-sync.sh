#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────
#  AgentDash ← Paperclip Upstream Sync
#
#  Repeatable process to pick up new Paperclip releases.
#  Run from the repo root on any working branch.
#
#  Usage:
#    bash scripts/upstream-sync.sh              # interactive
#    bash scripts/upstream-sync.sh --dry-run    # preview only
# ────────────────────────────────────────────────────────────────
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

SYNC_BRANCH="agentdash-upstream-sync"
BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()  { echo -e "${CYAN}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
err()   { echo -e "${RED}✗${NC} $*"; }

# ── Step 0: Pre-flight checks ──────────────────────────────────
info "Pre-flight checks..."

if ! git remote get-url upstream &>/dev/null; then
  err "No 'upstream' remote. Add it:"
  echo "  git remote add upstream https://github.com/paperclipai/paperclip.git"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]] && ! $DRY_RUN; then
  err "Working directory is dirty. Commit or stash changes first."
  exit 1
fi

ok "Upstream remote: $(git remote get-url upstream)"
ok "Working directory clean"

# ── Step 1: Fetch upstream ──────────────────────────────────────
info "Fetching upstream/master..."
git fetch upstream
ok "Fetched upstream"

# ── Step 2: Find fork point and count new commits ───────────────
MERGE_BASE=$(git merge-base HEAD upstream/master)
NEW_COMMITS=$(git rev-list --count "$MERGE_BASE"..upstream/master)

if [[ "$NEW_COMMITS" -eq 0 ]]; then
  ok "Already up to date with upstream — nothing to sync."
  exit 0
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  $NEW_COMMITS new upstream commits since fork point"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Step 3: Categorize changes ──────────────────────────────────
info "Upstream changes by area:"

count_files() {
  git diff --name-only "$MERGE_BASE"..upstream/master -- "$@" 2>/dev/null | wc -l | tr -d ' '
}

echo "  DB schema/migrations: $(count_files packages/db/src/schema/ packages/db/src/migrations/)"
echo "  Server routes:        $(count_files server/src/routes/)"
echo "  Server services:      $(count_files server/src/services/)"
echo "  Shared validators:    $(count_files packages/shared/src/)"
echo "  UI components:        $(count_files ui/src/)"
echo "  CLI:                  $(count_files cli/)"
echo "  Config/build:         $(count_files package.json pnpm-lock.yaml tsconfig*.json vite.config.*)"
echo ""

# ── Step 4: Show commit summary ─────────────────────────────────
info "Commit summary (non-merge):"
git log --oneline "$MERGE_BASE"..upstream/master --no-merges | while read -r line; do
  echo "  $line"
done
echo ""

# ── Step 5: Preview conflicts ──────────────────────────────────
info "Conflict preview..."
CONFLICT_OUTPUT=$(git merge-tree "$MERGE_BASE" HEAD upstream/master 2>/dev/null || true)
CONFLICT_COUNT=$(echo "$CONFLICT_OUTPUT" | grep -c "CONFLICT" || true)

if [[ "$CONFLICT_COUNT" -gt 0 ]]; then
  warn "$CONFLICT_COUNT file(s) will have merge conflicts"
  # Extract conflicting file names from merge-tree output
  echo "$CONFLICT_OUTPUT" | grep -A1 "CONFLICT" | grep -v "CONFLICT" | grep -v "^--$" | head -10
else
  ok "No merge conflicts detected — clean merge expected"
fi
echo ""

# ── Step 6: AgentDash-specific risk assessment ──────────────────
info "AgentDash risk assessment..."

RISK_FILES=(
  "server/src/app.ts"
  "server/src/index.ts"
  "packages/db/src/schema/index.ts"
  "packages/shared/src/constants.ts"
  "ui/src/App.tsx"
  "ui/src/components/Sidebar.tsx"
)

RISKS=0
for f in "${RISK_FILES[@]}"; do
  if git diff --name-only "$MERGE_BASE"..upstream/master -- "$f" | grep -q .; then
    warn "  Modified: $f (AgentDash touches this file)"
    RISKS=$((RISKS + 1))
  fi
done

if [[ "$RISKS" -eq 0 ]]; then
  ok "No changes to AgentDash-modified core files"
fi
echo ""

# ── Dry run stops here ──────────────────────────────────────────
if $DRY_RUN; then
  info "Dry run complete. Run without --dry-run to perform the merge."
  exit 0
fi

# ── Step 7: Create sync branch and merge ────────────────────────
echo "═══════════════════════════════════════════════════"
echo "  Ready to merge $NEW_COMMITS upstream commits"
echo "═══════════════════════════════════════════════════"
echo ""
read -rp "Proceed with merge on branch '$SYNC_BRANCH'? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  info "Aborted."
  exit 0
fi

# Create or reset sync branch from current HEAD
if git show-ref --verify --quiet "refs/heads/$SYNC_BRANCH"; then
  git checkout "$SYNC_BRANCH"
  git reset --hard "$BASE_BRANCH"
else
  git checkout -b "$SYNC_BRANCH"
fi

info "Merging upstream/master..."
if git merge upstream/master --no-edit; then
  ok "Merge completed cleanly!"
else
  warn "Merge has conflicts. Resolve them, then:"
  echo ""
  echo "  1. Fix conflicts in your editor"
  echo "  2. git add <resolved files>"
  echo "  3. git commit"
  echo "  4. Run verification:"
  echo "     pnpm install && pnpm -r typecheck && pnpm test:run && pnpm build"
  echo "  5. Run onboarding dry-run:"
  echo "     bash scripts/dry-run-onboarding.sh"
  echo "  6. If all pass, merge back:"
  echo "     git checkout $BASE_BRANCH && git merge $SYNC_BRANCH"
  echo ""
  exit 1
fi

# ── Step 8: Verify ──────────────────────────────────────────────
echo ""
info "Running verification suite..."
echo ""

VERIFY_PASS=true

info "Installing dependencies..."
if ! pnpm install --frozen-lockfile 2>/dev/null; then
  pnpm install
fi

info "Type checking..."
if pnpm -r typecheck; then
  ok "Typecheck passed"
else
  err "Typecheck failed"
  VERIFY_PASS=false
fi

info "Running tests..."
if pnpm test:run; then
  ok "Tests passed"
else
  err "Tests failed"
  VERIFY_PASS=false
fi

info "Building..."
if pnpm build; then
  ok "Build passed"
else
  err "Build failed"
  VERIFY_PASS=false
fi

echo ""
if $VERIFY_PASS; then
  echo "═══════════════════════════════════════════════════"
  echo "  ✓ All checks passed!"
  echo "═══════════════════════════════════════════════════"
  echo ""
  echo "  Next steps:"
  echo "    1. Optional: bash scripts/dry-run-onboarding.sh"
  echo "    2. Merge back:  git checkout $BASE_BRANCH && git merge $SYNC_BRANCH"
  echo "    3. Clean up:    git branch -d $SYNC_BRANCH"
else
  echo "═══════════════════════════════════════════════════"
  echo "  ✗ Verification failed — fix issues before merging"
  echo "═══════════════════════════════════════════════════"
  echo ""
  echo "  You are on branch: $SYNC_BRANCH"
  echo "  Fix failures, then re-run verification:"
  echo "    pnpm -r typecheck && pnpm test:run && pnpm build"
  echo "  Then merge back:"
  echo "    git checkout $BASE_BRANCH && git merge $SYNC_BRANCH"
  exit 1
fi
