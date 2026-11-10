---
name: release-changelog
description: >
  Generate the stable Paperclip release changelog at releases/vYYYY.MDD.P.md by
  reading commits, changesets, and merged PR context since the last stable tag.
---

# Release Changelog Skill

<!-- AgentDash: release-ownership-boundary — DO NOT REMOVE OR REORDER THIS BLOCK -->
## AgentDash release-note boundary

- Application/OTA CalVer notes live at `releases/vYYYY.MDD.P.md`; resolve versions with `./scripts/release.sh stable --skip-npm --date YYYY-MM-DD --print-version`.
- Owned `agentdash-connect` semver notes live at `packages/connect/releases/vX.Y.Z.md` and are published only by `.github/workflows/publish-connect.yml`.
- Do not place package-specific notes in `releases/`; the application UI bundles that directory as its own changelog.

The remainder of this skill generates application/OTA notes unless the caller explicitly requests the connector note path above.
<!-- /AgentDash: release-ownership-boundary -->

Generate the user-facing changelog for the **stable** Paperclip release.

## Versioning Model

Paperclip uses **calendar versioning (calver)**:

- Stable releases: `YYYY.MDD.P` (e.g. `2026.318.0`)
- Canary releases: `YYYY.MDD.P-canary.N` (e.g. `2026.318.1-canary.0`)
- Git tags: `vYYYY.MDD.P` for stable, `canary/vYYYY.MDD.P-canary.N` for canary

There are no major/minor/patch bumps. The stable version is derived from the
intended release date (UTC) plus the next same-day stable patch slot.

Output:

- `releases/vYYYY.MDD.P.md`

Important rules:

- even if there are canary releases such as `2026.318.1-canary.0`, the changelog file stays `releases/v2026.318.1.md`
- do not derive versions from semver bump types
- do not create canary changelog files

## Step 0 — Idempotency Check

Before generating anything, check whether the file already exists:

```bash
ls releases/vYYYY.MDD.P.md 2>/dev/null
```

If it exists:

1. read it first
2. present it to the reviewer
3. ask whether to keep it, regenerate it, or update specific sections
4. never overwrite it silently

## Step 1 — Determine the Stable Range

Find the last stable tag:

```bash
git tag --list 'v*' --sort=-version:refname | head -1
git log v{last}..HEAD --oneline --no-merges
```

The stable version comes from one of:

- an explicit maintainer request
- `./scripts/release.sh stable --skip-npm --date YYYY-MM-DD --print-version`
- the release plan already agreed in `doc/RELEASING.md`

Do not derive the changelog version from a canary tag or prerelease suffix.
Do not derive major/minor/patch bumps from API intent — calver uses the date and same-day stable slot.

## Step 2 — Gather the Raw Inputs

Collect release data from:

1. git commits since the last stable tag
2. `.changeset/*.md` files
3. merged PRs via `gh` when available

Useful commands:

```bash
git log v{last}..HEAD --oneline --no-merges
git log v{last}..HEAD --format="%H %s" --no-merges
ls .changeset/*.md | grep -v README.md
gh pr list --state merged --search "merged:>={last-tag-date}" --json number,title,body,labels
```

## Step 3 — Detect Breaking Changes

Look for:

- destructive migrations
- removed or changed API fields/endpoints
- renamed or removed config keys
- `BREAKING:` or `BREAKING CHANGE:` commit signals

Key commands:

```bash
git diff --name-only v{last}..HEAD -- packages/db/src/migrations/
git diff v{last}..HEAD -- packages/db/src/schema/
git diff v{last}..HEAD -- server/src/routes/ server/src/api/
git log v{last}..HEAD --format="%s" | rg -n 'BREAKING CHANGE|BREAKING:|^[a-z]+!:' || true
```

If breaking changes are detected, flag them prominently — they must appear in the
Breaking Changes section with an upgrade path.

## Step 4 — Categorize for Users

<!-- AgentDash: public release notes (www.agentdash.cloud/releases) -->
AgentDash notes after v2026.1105.0 open with exactly these four sections, in
this order (`scripts/ci/check-release-log.mjs` fails the PR otherwise):

1. `What's new`: what a person using AgentDash will notice, in plain words
2. `For admins`: settings, permissions, and what an administrator must decide or do
3. `Upgrade`: migrations, required steps, compatibility
4. `Security`: fixes and changed boundaries, without exploit detail

Every one of the four needs at least one bullet that survives the public-notes
sanitizer (`scripts/docs/public-release-notes.mjs`). It keeps bullets only and
withholds any bullet, with its children, that names the private product
profile, a customer, person or instance, an email or IP address, a private
hostname or the upstream project. Write `- No changes.` for a section with
nothing to report; prose alone publishes empty. These four are what the
public page and the in-app Changelog show first, so write them for a reader
outside the team.

After the four, add any technical sections you need:

- `Breaking Changes` (or `Deprecated` / `Removed`, per `docs/api/versioning.md`)
- `Highlights`
- `Improvements`
- `Fixes`
- `Contributors`

Notes up to and including v2026.1105.0 are historical: never rewrite them into
the new format.

Exclude purely internal refactors, CI changes, and docs-only work unless they materially affect users.

Guidelines:

- group related commits into one user-facing entry
- write from the user perspective
- keep highlights short and concrete
- spell out upgrade actions for breaking changes

### Inline PR and contributor attribution

When a bullet item clearly maps to a merged pull request, add inline attribution at the
end of the entry in this format:

```
- **Feature name** — Description. ([#123](https://github.com/thetangstr/agentdash/pull/123), @contributor1, @contributor2)
```

Rules:

- Only add a PR link when you can confidently trace the bullet to a specific merged PR.
  Use merge commit messages (`Merge pull request #N from user/branch`) to map PRs.
- List the contributor(s) who authored the PR. Use GitHub usernames, not real names or emails.
- If multiple PRs contributed to a single bullet, list them all: `([#10](url), [#12](url), @user1, @user2)`.
- If you cannot determine the PR number or contributor with confidence, omit the attribution
  parenthetical — do not guess.
- Core maintainer commits that don't have an external PR can omit the parenthetical.

## Step 5 — Write the File

Template:

```markdown
# vYYYY.MDD.P

> Released: YYYY-MM-DD

## What's new

- **Plain-language headline.** What changed for the people using it.

## For admins

- What an administrator must decide, enable or check. Or: No changes.

## Upgrade

- Migrations, steps and compatibility. Or: No changes.

## Security

- Fixes and changed boundaries. Or: No changes.

## Breaking Changes

## Improvements

## Fixes

## Contributors

Thank you to everyone who contributed to this release!

@username1, @username2, @username3
```

The four opening sections are required, each with at least one bullet (write
"No changes." as a bullet). Omit the technical sections after them when they
are empty.

The `Contributors` section should always be included. List every person who authored
commits in the release range, @-mentioning them by their **GitHub username** (not their
real name or email). To find GitHub usernames:

1. Extract usernames from merge commit messages: `git log v{last}..HEAD --oneline --merges` — the branch prefix (e.g. `from username/branch`) gives the GitHub username.
2. For noreply emails like `user@users.noreply.github.com`, the username is the part before `@`.
3. For contributors whose username is ambiguous, check `gh api users/{guess}` or the PR page.

**Never expose contributor email addresses.** Use `@username` only.

Exclude bot accounts (e.g. `lockfile-bot`, `dependabot`) from the list.
Exclude Paperclip founders from the list (e.g. `cryppadotta`, `forgottendev`, `devinfoley`, `sockmonster`, `scotttong`)

List contributors in alphabetical order by GitHub username (case-insensitive).

If there are no contributors left after exclusions, then just skip this section and don't mention it.

## Step 6 — Review Before Release

Before handing it off:

1. confirm the heading is the stable version only
2. confirm there is no `-canary` language in the title or filename
3. confirm any breaking changes have an upgrade path
4. confirm the four opening sections pass: `node scripts/ci/check-release-log.mjs`
5. add the row to `releases/README.md` and refresh `releases/published.json`
   with `node scripts/published-releases.mjs --update-snapshot` (it records
   the releases already published, so the public site's fallback stays current)
6. present the draft for human sign-off

Where the note goes after sign-off: the release workflow refuses to tag a
source commit that does not carry the same file byte for byte, publishes it as
the GitHub Release body, and, in its last job, checks the published body
against the file. Once the release is published, www.agentdash.cloud rebuilds
(Vercel deploy hook) and `/releases/vYYYY.MDD.P` shows the sanitized note; the
build reads the published list from the GitHub Releases API and, if that
cannot be read, from `releases/published.json`, which is why the snapshot
refresh above matters. The in-app Changelog of builds from that tag shows the
note too.

Merge the note to main before the cut, and cut the stable release from a main
commit that contains it: the workflow refuses a source commit without it, and
`check-release-log.mjs` fails a tag cut from a commit without its notes.
The note's `# ` heading must be the version in its file name.

Once a release is tagged, its notes file is frozen: the public pages build
from main, and `check-release-log.mjs` fails when main's copy differs from the
tagged commit's. Put any correction in the next release's notes. If the GitHub
Release body ever disagrees with the file, edit the body to match the file,
then rerun the release workflow's `refresh_release_site` job.

This skill never publishes anything. It only prepares the stable changelog artifact.
