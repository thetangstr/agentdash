#!/usr/bin/env bash
# doc-hygiene.sh — Document health scanner for AgentDash
#
# Inspired by Claude Code's memory management patterns:
#   - Size caps (40KB per file, 200 lines for indexes)
#   - Staleness detection (age-based warnings)
#   - Duplicate detection
#   - Orphan detection (unreferenced docs)
#
# Usage:
#   bash scripts/doc-hygiene.sh              # Full report
#   bash scripts/doc-hygiene.sh --fix        # Report + interactive cleanup
#   bash scripts/doc-hygiene.sh --archive    # Archive stale plans (non-interactive)
#   bash scripts/doc-hygiene.sh --json       # Machine-readable output

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# --- Configuration (inspired by Claude Code constants) ---
MAX_FILE_BYTES=40960        # 40KB — CC's MAX_MEMORY_CHARACTER_COUNT
MAX_INDEX_LINES=200         # CC's MAX_ENTRYPOINT_LINES
STALE_DAYS=30               # Days before a doc is considered stale
WARN_DAYS=14                # Days before a warning
PLAN_ARCHIVE_DIR="doc/plans/archive"
DOC_DIRS=("doc" ".claude/commands" "." )
DOC_EXTENSIONS=("md")

# --- State ---
ISSUES_FOUND=0
WARNINGS_FOUND=0
FILES_SCANNED=0
FIX_MODE=false
ARCHIVE_MODE=false
JSON_MODE=false

# --- Parse args ---
for arg in "$@"; do
  case "$arg" in
    --fix)     FIX_MODE=true ;;
    --archive) ARCHIVE_MODE=true ;;
    --json)    JSON_MODE=true ;;
    --help|-h)
      echo "Usage: bash scripts/doc-hygiene.sh [--fix] [--archive] [--json]"
      echo ""
      echo "  --fix      Interactive cleanup prompts"
      echo "  --archive  Auto-archive stale plans"
      echo "  --json     Machine-readable output"
      exit 0
      ;;
  esac
done

# --- Helpers ---
now_epoch=$(date +%s)

file_age_days() {
  local file="$1"
  local mtime
  # Use git log date if available, fall back to filesystem mtime
  mtime=$(git log -1 --format="%at" -- "$file" 2>/dev/null || stat -f "%m" "$file" 2>/dev/null || echo "$now_epoch")
  echo $(( (now_epoch - mtime) / 86400 ))
}

file_size_bytes() {
  wc -c < "$1" 2>/dev/null | tr -d ' '
}

file_line_count() {
  wc -l < "$1" 2>/dev/null | tr -d ' '
}

human_size() {
  local bytes=$1
  if (( bytes >= 1048576 )); then
    echo "$((bytes / 1048576))MB"
  elif (( bytes >= 1024 )); then
    echo "$((bytes / 1024))KB"
  else
    echo "${bytes}B"
  fi
}

age_label() {
  local days=$1
  if (( days == 0 )); then echo "today"
  elif (( days == 1 )); then echo "yesterday"
  else echo "${days} days ago"
  fi
}

is_referenced() {
  local filename="$1"
  local basename
  basename=$(basename "$filename")
  # Check if referenced anywhere in the repo (excluding itself and node_modules)
  local count
  count=$(grep -rl --include='*.md' --include='*.ts' --include='*.tsx' --include='*.js' \
    --exclude-dir=node_modules --exclude-dir=.git \
    "$basename" "$REPO_ROOT" 2>/dev/null | grep -v "$filename" | head -5 | wc -l | tr -d ' ')
  (( count > 0 ))
}

# --- Output ---
section() {
  if ! $JSON_MODE; then
    echo ""
    echo "━━━ $1 ━━━"
  fi
}

issue() {
  ISSUES_FOUND=$((ISSUES_FOUND + 1))
  if ! $JSON_MODE; then
    echo "  ✗ $1"
  fi
}

warn() {
  WARNINGS_FOUND=$((WARNINGS_FOUND + 1))
  if ! $JSON_MODE; then
    echo "  ⚠ $1"
  fi
}

ok() {
  if ! $JSON_MODE; then
    echo "  ✓ $1"
  fi
}

info() {
  if ! $JSON_MODE; then
    echo "  · $1"
  fi
}

# ============================================================
# SCAN 1: Oversized files (CC pattern: 40KB cap)
# ============================================================
section "Oversized Documents (>${MAX_FILE_BYTES}B / $(human_size $MAX_FILE_BYTES) cap)"

oversized_files=()
while IFS= read -r -d '' file; do
  FILES_SCANNED=$((FILES_SCANNED + 1))
  size=$(file_size_bytes "$file")
  if (( size > MAX_FILE_BYTES )); then
    rel="${file#$REPO_ROOT/}"
    oversized_files+=("$rel")
    issue "$rel — $(human_size "$size") ($(( size * 100 / MAX_FILE_BYTES ))% of cap)"
  fi
done < <(find "$REPO_ROOT" -name '*.md' \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/dist/*' \
  -print0 2>/dev/null)

if (( ${#oversized_files[@]} == 0 )); then
  ok "No oversized files"
fi

# ============================================================
# SCAN 2: Stale documents (CC pattern: age warnings)
# ============================================================
section "Stale Documents (>${STALE_DAYS} days untouched)"

stale_files=()
warning_files=()
while IFS= read -r -d '' file; do
  rel="${file#$REPO_ROOT/}"
  # Skip archive directory
  [[ "$rel" == *"/archive/"* ]] && continue
  age=$(file_age_days "$file")
  if (( age > STALE_DAYS )); then
    stale_files+=("$rel")
    issue "$rel — last modified $(age_label "$age")"
  elif (( age > WARN_DAYS )); then
    warning_files+=("$rel")
    warn "$rel — last modified $(age_label "$age")"
  fi
done < <(find "$REPO_ROOT/doc" -name '*.md' -print0 2>/dev/null)

if (( ${#stale_files[@]} == 0 && ${#warning_files[@]} == 0 )); then
  ok "All docs recently maintained"
fi

# ============================================================
# SCAN 3: Duplicate directories (CC pattern: single source of truth)
# ============================================================
section "Duplicate Directories"

check_duplicate_dirs() {
  local dir1="$1" dir2="$2" label="$3"
  if [[ -d "$REPO_ROOT/$dir1" && -d "$REPO_ROOT/$dir2" ]]; then
    local count1 count2
    count1=$(find "$REPO_ROOT/$dir1" -name '*.md' | wc -l | tr -d ' ')
    count2=$(find "$REPO_ROOT/$dir2" -name '*.md' | wc -l | tr -d ' ')
    issue "$label: $dir1 (${count1} files) vs $dir2 (${count2} files)"
    return 0
  fi
  return 1
}

dup_found=false
if check_duplicate_dirs "doc/maw" "doc/multi-agent-workflow" "MAW docs"; then
  dup_found=true
fi

if ! $dup_found; then
  ok "No duplicate directories"
fi

# ============================================================
# SCAN 4: Orphaned docs (CC pattern: referenced memories only)
# ============================================================
section "Orphaned Documents (unreferenced in codebase)"

orphan_count=0
# Check doc/ root files only (plans checked separately)
while IFS= read -r -d '' file; do
  rel="${file#$REPO_ROOT/}"
  basename=$(basename "$file")
  # Skip common files that don't need references
  [[ "$basename" == "README.md" || "$basename" == "CHANGELOG.md" || "$basename" == "LICENSE.md" ]] && continue
  if ! is_referenced "$rel"; then
    orphan_count=$((orphan_count + 1))
    warn "$rel — not referenced anywhere"
    (( orphan_count >= 15 )) && { info "(showing first 15)"; break; }
  fi
done < <(find "$REPO_ROOT/doc" -maxdepth 1 -name '*.md' -print0 2>/dev/null)

if (( orphan_count == 0 )); then
  ok "All root docs are referenced"
fi

# ============================================================
# SCAN 5: Plan file health (CC pattern: session-scoped plans)
# ============================================================
section "Plan Files Health"

plans_dir="$REPO_ROOT/doc/plans"
if [[ -d "$plans_dir" ]]; then
  total_plans=$(find "$plans_dir" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
  info "Total plans: $total_plans"

  stale_plan_count=0
  superseded_plans=()

  while IFS= read -r -d '' file; do
    rel="${file#$REPO_ROOT/}"
    age=$(file_age_days "$file")
    basename=$(basename "$file")

    # Check for supersession markers in first 10 lines (status/header area only)
    if head -10 "$file" | grep -qi "superseded\|replaced by\|deprecated\|^.*status:.*deferred" 2>/dev/null; then
      superseded_plans+=("$rel")
      issue "$rel — marked as superseded/deferred"
    elif (( age > STALE_DAYS )) && ! is_referenced "$rel"; then
      stale_plan_count=$((stale_plan_count + 1))
      warn "$rel — stale ($(age_label "$age")), unreferenced"
    fi
  done < <(find "$plans_dir" -maxdepth 1 -name '*.md' -print0 2>/dev/null)

  # Archive superseded plans if requested
  if $ARCHIVE_MODE && (( ${#superseded_plans[@]} > 0 )); then
    mkdir -p "$REPO_ROOT/$PLAN_ARCHIVE_DIR"
    echo ""
    info "Archiving ${#superseded_plans[@]} superseded plans..."
    for plan in "${superseded_plans[@]}"; do
      mv "$REPO_ROOT/$plan" "$REPO_ROOT/$PLAN_ARCHIVE_DIR/"
      info "  Archived: $plan"
    done
  fi
else
  ok "No plans directory"
fi

# ============================================================
# SCAN 6: CLAUDE.md health (CC pattern: index size caps)
# ============================================================
section "CLAUDE.md Health"

claude_md="$REPO_ROOT/CLAUDE.md"
if [[ -f "$claude_md" ]]; then
  lines=$(file_line_count "$claude_md")
  size=$(file_size_bytes "$claude_md")
  info "CLAUDE.md: $lines lines, $(human_size "$size")"

  if (( lines > MAX_INDEX_LINES )); then
    warn "CLAUDE.md exceeds ${MAX_INDEX_LINES}-line recommended cap ($lines lines)"
  else
    ok "CLAUDE.md within size limits"
  fi

  # Check for stale references
  stale_refs=0
  while IFS= read -r line; do
    # Extract file paths from markdown links and backtick references
    ref=$(echo "$line" | grep -oE '`[^`]+\.(md|ts|sh)`' | tr -d '`' | head -1)
    if [[ -n "$ref" && ! -f "$REPO_ROOT/$ref" ]]; then
      issue "Broken reference in CLAUDE.md: $ref"
      stale_refs=$((stale_refs + 1))
    fi
  done < "$claude_md"

  if (( stale_refs == 0 )); then
    ok "All CLAUDE.md references valid"
  fi
fi

# ============================================================
# SCAN 7: Command file bloat (MAW commands)
# ============================================================
section "MAW Command Files"

commands_dir="$REPO_ROOT/.claude/commands"
if [[ -d "$commands_dir" ]]; then
  total_cmd_lines=0
  while IFS= read -r -d '' file; do
    lines=$(file_line_count "$file")
    size=$(file_size_bytes "$file")
    basename=$(basename "$file")
    total_cmd_lines=$((total_cmd_lines + lines))
    if (( size > MAX_FILE_BYTES )); then
      warn "$basename — $(human_size "$size"), $lines lines (consider splitting)"
    else
      info "$basename — $lines lines, $(human_size "$size")"
    fi
  done < <(find "$commands_dir" -name '*.md' -print0 2>/dev/null)
  info "Total command doc lines: $total_cmd_lines"
fi

# ============================================================
# SCAN 8: Empty files
# ============================================================
section "Empty Files"

empty_count=0
while IFS= read -r -d '' file; do
  size=$(file_size_bytes "$file")
  if (( size == 0 )); then
    rel="${file#$REPO_ROOT/}"
    warn "$rel — empty (0 bytes)"
    empty_count=$((empty_count + 1))
  fi
done < <(find "$REPO_ROOT" -name '*.md' \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/dist/*' \
  -print0 2>/dev/null)

if (( empty_count == 0 )); then
  ok "No empty markdown files"
fi

# ============================================================
# SCAN 9: Task tracking files
# ============================================================
section "Task Tracking Files"

for task_file in "$REPO_ROOT/doc/TASKS.md" "$REPO_ROOT/doc/TASKS-mcp.md"; do
  if [[ -f "$task_file" ]]; then
    rel="${task_file#$REPO_ROOT/}"
    age=$(file_age_days "$task_file")
    lines=$(file_line_count "$task_file")
    size=$(file_size_bytes "$task_file")

    # Count checked vs unchecked items
    checked=$(grep -c '\[x\]' "$task_file" 2>/dev/null || echo 0)
    unchecked=$(grep -c '\[ \]' "$task_file" 2>/dev/null || echo 0)
    total_items=$((checked + unchecked))

    info "$rel — $lines lines, $(human_size "$size"), $total_items items ($checked done, $unchecked open)"

    if (( age > STALE_DAYS )); then
      warn "$rel — last modified $(age_label "$age"), may be stale"
    fi
    if (( total_items > 0 && checked * 100 / total_items > 80 )); then
      warn "$rel — ${checked}/${total_items} items complete, consider archiving completed items"
    fi
  fi
done

# ============================================================
# Summary
# ============================================================
section "Summary"

if ! $JSON_MODE; then
  echo ""
  echo "  Files scanned:  $FILES_SCANNED"
  echo "  Issues found:   $ISSUES_FOUND"
  echo "  Warnings:       $WARNINGS_FOUND"
  echo ""

  if (( ISSUES_FOUND == 0 && WARNINGS_FOUND == 0 )); then
    echo "  ✓ Documentation is healthy!"
  elif (( ISSUES_FOUND > 0 )); then
    echo "  Run with --fix for interactive cleanup or --archive to auto-archive stale plans."
  else
    echo "  Minor warnings only. Run with --fix to review."
  fi
  echo ""
fi

# JSON output
if $JSON_MODE; then
  cat <<EOF
{
  "files_scanned": $FILES_SCANNED,
  "issues": $ISSUES_FOUND,
  "warnings": $WARNINGS_FOUND,
  "healthy": $(( ISSUES_FOUND == 0 && WARNINGS_FOUND == 0 ? 1 : 0 ))
}
EOF
fi

exit $(( ISSUES_FOUND > 0 ? 1 : 0 ))
