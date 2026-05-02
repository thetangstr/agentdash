---
description: Weekly read-only digest of upstream/paperclip commits, classified against doc/UPSTREAM-POLICY.md
---

You are running the **upstream digest** workflow.

This is the routine that operationalizes [doc/UPSTREAM-POLICY.md](../doc/UPSTREAM-POLICY.md).
Per that policy, AgentDash does **not** merge or cherry-pick from upstream automatically.
This command produces a **classified report** of what is new on `upstream/master`, and
nothing else — no fetches that mutate state beyond `git fetch upstream`, no merges, no
cherry-picks. The human (or you, in a separate session) decides what to do with it.

## What to do when invoked

1. **Run the digest script.** This fetches upstream and classifies every commit ahead of HEAD.
   ```sh
   bash scripts/upstream-digest.sh
   ```
   Output: `doc/upstream-digests/YYYY-MM-DD.md` plus a one-line stdout summary.

2. **Read the new digest file** with the Read tool. Quote the Summary table verbatim so the
   user sees the bucket counts at a glance.

3. **Read the "Worth a look" section.** For each row (there should usually be 0–10 per week):
   - State whether it passes all four cherry-pick gates from the rubric:
     1. Target is in the "still inherited" list — the script's `inherited` reason already
        confirms this; sanity-check by looking at the file paths.
     2. Fix is specific and bounded — judge from the subject line and file count.
     3. We have a concrete reason to care — usually NO unless the user has flagged the
        related subsystem in this conversation. Default position: skip unless asked.
     4. Doesn't touch AgentDash-modified files in a way that requires redesign — re-check
        against the conflict-prone list in [UPSTREAM-POLICY.md](../doc/UPSTREAM-POLICY.md#conflict-prone-files-every-upstream-merge-hits-these).
   - For each row, give a one-line verdict: **CHERRY-PICK** (rare), **WATCH** (worth knowing
     about for future), or **SKIP** (default).

4. **Do not actually run `git cherry-pick` or any merge command** unless the user explicitly
   says "cherry-pick \<sha\>". Even with auto-merge authorization, an autonomous cherry-pick
   from a digest is out of scope for this skill — the whole point of "reference, don't merge"
   is that a human is in the loop.

5. **Report.** Post a short summary back to the user:
   - Bucket counts (one line)
   - Cherry-pick recommendations (usually "none this week")
   - Path to the markdown digest file

## Cadence

Designed to run weekly via `/schedule` or a remote routine. The output file is dated, so
running twice the same day overwrites; running on different days produces a history under
`doc/upstream-digests/`. Old digests can be pruned at any time — they're commit-classification
snapshots, not load-bearing state.

## When NOT to use

- If the user wants to **actually take** an upstream commit, route to a manual cherry-pick
  per [UPSTREAM-POLICY.md](../doc/UPSTREAM-POLICY.md#ad-hoc-cherry-pick-rare). This skill
  produces the report; it does not act on it.
- If the user wants to **bulk-merge upstream**, push back: that contradicts the policy and
  the cost calculus that produced it (the doc lists the alternatives we ruled out).
