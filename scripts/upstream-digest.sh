#!/usr/bin/env bash
# Weekly upstream/paperclip digest, per doc/UPSTREAM-POLICY.md.
#
# Classifies each upstream commit not yet in HEAD against three buckets:
#   - inherited   (in "still inherited" list — fixes here may be worth cherry-picking)
#   - agentdash   (in "100% AgentDash" list — upstream has nothing to fix here, skip)
#   - conflict    (in "conflict-prone wiring" list — almost never worth a cherry-pick alone)
#
# Emits a markdown report to doc/upstream-digests/YYYY-MM-DD.md plus a stdout summary.
# Read-only — fetches upstream, never merges.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

OUT_DIR="doc/upstream-digests"
mkdir -p "$OUT_DIR"
DATE_STAMP="$(date -u +%Y-%m-%d)"
OUT_FILE="$OUT_DIR/$DATE_STAMP.md"

echo "Fetching upstream..." >&2
git fetch upstream --quiet

# Pick the right upstream branch — most paperclip clones use master.
UPSTREAM_REF="upstream/master"
if ! git rev-parse --verify --quiet "$UPSTREAM_REF" >/dev/null; then
  UPSTREAM_REF="upstream/main"
fi

RAW="$(mktemp)"
trap 'rm -f "$RAW"' EXIT

# One pass: subject + author + date + changed files for every commit ahead of HEAD.
git log "$UPSTREAM_REF" ^HEAD --reverse \
  --format='::COMMIT::%H%n%an%n%ai%n%s' \
  --name-only > "$RAW"

TOTAL=$(grep -c '^::COMMIT::' "$RAW" || true)

# Classification regexes — keep aligned with doc/UPSTREAM-POLICY.md.
# "inherited" = a fix here may matter to us.
INHERITED_RE='^(server/src/services/heartbeat|server/src/middleware/auth\.ts|server/src/agent-auth-jwt|packages/adapters/(claude|codex|cursor|gemini|opencode|pi|openclaw|hermes|process|http)/|packages/plugins/sdk/|server/src/services/(issues|projects|comments|approvals|wakeup|workspace-operations|secret|company-skills|agent-instructions)|packages/db/src/schema/(issues|projects|comments|approvals|agents|companies|company_memberships|agent_api_keys|secrets|company_skills|skills|workspaces)|packages/auth/|server/src/services/board-auth|server/src/realtime/|cli/src/)'

# "agentdash" = pure AgentDash surface, upstream cannot have a fix.
AGENTDASH_RE='^(server/src/(routes|services)/(billing|crm|pipelines?|policy|policies|policy-engine|autoresearch|hubspot|onboarding|action[_-]?proposals?|kill[_-]?switch|skill[_-]versions?|assess|operator[_-]?feed|inbox|budget[_-]?forecast|capacity|track[_-]?b)|ui/src/pages/(Billing|CRM|Pipeline|Policies|AutoResearch|HubSpot|Onboarding|ActionProposals?|Assess|KillSwitch|Capacity|OperatorFeed)|packages/db/src/schema/(billing|plan|crm|pipeline|policy|autoresearch|hubspot|onboarding|action_proposal|kill_switch|skill_version|assess|operator_feed|budget_forecast)|doc/(PRD|BUSINESS-PLAN|SOP-deployment|SPEC-implementation|CUJ-STATUS|UPSTREAM-POLICY|multi-agent-workflow))'

# "conflict-prone wiring" = high-conflict files that are pure wiring.
CONFLICT_RE='^(ui/src/App\.tsx|ui/src/components/(Sidebar|Layout)\.tsx|server/src/app\.ts|server/src/index\.ts|packages/shared/src/(constants|index)\.ts|packages/db/src/schema/index\.ts|README\.md|ui/index\.html|CHANGELOG\.md)$'

# Security/CVE keywords boost the score.
SECURITY_RE='(CVE-|security|vulnerab|XSS|SQLi|SSRF|RCE|auth bypass|escalation|injection)'

# Score buckets:  WORTH=>=2  OTHER=0..1  SKIP=<0
declare -a WORTH_LIST=()
WORTH_COUNT=0
OTHER_COUNT=0
SKIP_AGENTDASH=0
SKIP_CONFLICT=0

# Closes #280: per-commit dependency feasibility check. A commit can touch
# inherited files (path classification → score 3) but still fail to cherry-
# pick cleanly because it depends on symbols/files introduced in earlier
# upstream commits we never took. Cheapest signal: count the NEW files the
# commit adds and the total churn. Above thresholds → "needs-followon".
# Reviewers still see the commit in the worth-a-look section, but with a
# clear "expect peer cherry-picks" warning.
#
# Thresholds picked from the 2026-05-14 cherry-pick attempt named in the
# issue: eb452fba30 added 4 files + 125 lines of helpers; c445e59256 added
# a new authorType field path; d1a8c873b2 added 3 new files. A threshold
# of NEW_FILES ≥ 2 OR CHURN > 300 catches all three.
DEPCHECK_NEW_FILES_THRESHOLD=2
DEPCHECK_CHURN_THRESHOLD=300

# Run the feasibility probe for a commit SHA. Echoes one of:
#   "drop-in"        — small, no new files
#   "needs-followon" — over threshold; cherry-pick will probably bring deps
# Cheap: two `git show` calls per commit, ~0.1s each.
depcheck_classify() {
  local sha="$1"
  local new_files churn
  new_files=$(git show --diff-filter=A --name-only --format='' "$sha" 2>/dev/null | grep -c . || true)
  churn=$(git show --shortstat --format='' "$sha" 2>/dev/null \
    | tr ',' '\n' \
    | grep -oE '[0-9]+ (insertion|deletion)' \
    | awk '{ s += $1 } END { print s+0 }')
  if [ "${new_files:-0}" -ge "$DEPCHECK_NEW_FILES_THRESHOLD" ] \
     || [ "${churn:-0}" -gt "$DEPCHECK_CHURN_THRESHOLD" ]; then
    echo "needs-followon"
  else
    echo "drop-in"
  fi
}

# Stream-parse the log.
sha=""; author=""; date=""; subject=""; files=()
inherited=0; agentdash=0; conflict=0; other=0

flush_commit() {
  [ -z "$sha" ] && return
  # Decide bucket from path classification first.
  local score reason
  if [ "$agentdash" -gt 0 ]; then
    score=-3; reason="agentdash-owned"
  elif [ "$inherited" -gt 0 ]; then
    score=3; reason="inherited"
  elif [ "$conflict" -gt 0 ] && [ "$other" -eq 0 ]; then
    score=-2; reason="conflict-only"
  else
    score=0; reason="other"
  fi
  # Security keyword bumps the score within the same direction; never promotes
  # an "agentdash-owned" or "conflict-only" commit into WORTH (we still don't
  # care about an upstream auth fix to a file we've replaced wholesale).
  if [ "$score" -ge 0 ] && echo "$subject" | grep -Eqi "$SECURITY_RE"; then
    score=$((score + 2))
    reason="${reason}+security"
  fi
  # Final bucket counters — single counted, sum equals TOTAL.
  if [ "$score" -ge 2 ]; then
    WORTH_COUNT=$((WORTH_COUNT + 1))
  elif [ "$score" -ge 0 ]; then
    OTHER_COUNT=$((OTHER_COUNT + 1))
  elif [ "$score" -eq -2 ]; then
    SKIP_CONFLICT=$((SKIP_CONFLICT + 1))
  else
    SKIP_AGENTDASH=$((SKIP_AGENTDASH + 1))
  fi
  local file_count="${#files[@]}"
  local file_summary=""
  if [ "$file_count" -gt 0 ]; then
    file_summary=$(printf '%s\n' "${files[@]}" | head -3 | paste -sd ',' -)
  fi
  local extra=""
  if [ "$file_count" -gt 3 ]; then
    extra=" (+$((file_count - 3)) more)"
  fi
  # Closes #280: only probe feasibility for candidates we'd otherwise
  # flag as worth-a-look. Cheaper than running it on every commit.
  local feasibility=""
  if [ "$score" -ge 2 ]; then
    feasibility=$(depcheck_classify "$sha")
  fi
  local entry="${score}|${sha}|${date%% *}|${author}|${reason}|${feasibility}|${subject}|${file_summary}${extra}"
  if [ "$score" -ge 2 ]; then
    WORTH_LIST+=("$entry")
  fi
}

while IFS= read -r line; do
  if [[ "$line" == ::COMMIT::* ]]; then
    flush_commit
    sha="${line#::COMMIT::}"
    author=""; date=""; subject=""
    files=()
    inherited=0; agentdash=0; conflict=0; other=0
    state=author
    continue
  fi
  if [ -z "$line" ]; then
    state=files
    continue
  fi
  case "${state:-}" in
    author) author="$line"; state=date ;;
    date)   date="$line"; state=subject ;;
    subject) subject="$line"; state=files ;;
    files)
      files+=("$line")
      if [[ "$line" =~ $AGENTDASH_RE ]]; then agentdash=$((agentdash + 1))
      elif [[ "$line" =~ $INHERITED_RE ]]; then inherited=$((inherited + 1))
      elif [[ "$line" =~ $CONFLICT_RE ]]; then conflict=$((conflict + 1))
      else other=$((other + 1)); fi
      ;;
  esac
done < "$RAW"
flush_commit

# Sort worth-a-look list by score desc, then date desc.
WORTH_SORTED="$(printf '%s\n' "${WORTH_LIST[@]:-}" | sort -t'|' -k1,1nr -k3,3r)"

# Emit markdown.
{
  echo "# Upstream digest — $DATE_STAMP"
  echo
  echo "Snapshot of \`$UPSTREAM_REF\` against this branch. Generated by \`scripts/upstream-digest.sh\`."
  echo "See [doc/UPSTREAM-POLICY.md](../UPSTREAM-POLICY.md) for the cherry-pick rubric."
  echo
  echo "## Summary"
  echo
  echo "| Bucket | Count | What it means |"
  echo "|---|---|---|"
  echo "| Worth a look (score ≥ 2) | $WORTH_COUNT | Touches files we still inherit. Review for cherry-pick. |"
  echo "| Skip — agentdash-owned | $SKIP_AGENTDASH | Touches code we own; upstream has no fix here. |"
  echo "| Skip — conflict-only wiring | $SKIP_CONFLICT | Only touches App.tsx / Sidebar / app.ts / shared constants. |"
  echo "| Skip — other (tests, docs, unrelated) | $OTHER_COUNT | Doesn't touch any classified path. |"
  echo "| **Total upstream commits ahead** | **$TOTAL** | (sum equals total) |"
  echo
  if [ "$WORTH_COUNT" -gt 0 ]; then
    echo "## Worth a look"
    echo
    echo "Sorted by score (security boost = +2), then date desc."
    echo
    echo "**Feasibility** (per #280): \`drop-in\` = small diff, no new files →"
    echo "expect a clean cherry-pick. \`needs-followon\` = adds ≥2 new files"
    echo "or churns >300 lines → cherry-pick will probably reference symbols"
    echo "introduced in earlier upstream commits; expect to chain follow-on"
    echo "cherry-picks. The flag is a heuristic, not a guarantee."
    echo
    echo "| Score | SHA | Date | Author | Reason | Feasibility | Subject | Files |"
    echo "|---|---|---|---|---|---|---|---|"
    while IFS='|' read -r score sha date author reason feasibility subject files; do
      [ -z "$score" ] && continue
      short="${sha:0:10}"
      printf '| %s | \`%s\` | %s | %s | %s | %s | %s | %s |\n' \
        "$score" "$short" "$date" "$author" "$reason" "$feasibility" "$subject" "$files"
    done <<< "$WORTH_SORTED"
    echo
  fi
  echo "## Action"
  echo
  echo "If a row above looks worth taking, cherry-pick it per the rubric in"
  echo "[doc/UPSTREAM-POLICY.md](../UPSTREAM-POLICY.md):"
  echo
  echo '```sh'
  echo "git cherry-pick <sha>"
  echo "pnpm -r typecheck && pnpm test:run && pnpm build"
  echo "# Then log the cherry-pick in doc/UPSTREAM-POLICY.md."
  echo '```'
  echo
  echo "If nothing above looks worth taking, this digest is the receipt — close the loop and move on."
} > "$OUT_FILE"

echo "Wrote $OUT_FILE"
echo "Worth=$WORTH_COUNT  SkipAgentdash=$SKIP_AGENTDASH  SkipConflict=$SKIP_CONFLICT  Other=$OTHER_COUNT  Total=$TOTAL"
