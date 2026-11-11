# Release log

Release notes live in this directory as `vYYYY.MDD.P.md`, indexed newest first.
One file feeds three readers: the GitHub Release body, the in-app Changelog
and the public release notes at
[www.agentdash.cloud/releases](https://www.agentdash.cloud/releases).
Stable publication reads the GitHub Release body from the release-control
checkout. The in-app Changelog reads the notes bundled into its source build.
These can differ when notes are added after the payload commit: a Git tag and
a passing release-log check do not prove that the installed UI includes its
own notes. Verify the published body and the built Changelog separately.

Notes may be bundled before stable publication. A version/date entry alone is
not evidence that its release has been published. Publication is confirmed by
the matching stable tag and GitHub Release.

## AgentDash releases

| Version | Released | Headline | GitHub Release |
|---|---|---|---|
| [v2026.1111.0](v2026.1111.0.md) | 2026-11-11 | Fred, the guide for agreeing a first useful job for agents, is back and is set up and started only by owners and admins; the adoption brief is protected; one migration `0162` (from v2026.1109.1 or earlier, also `0158`–`0161` as in v2026.1110.0); replaces the Fred in the withdrawn v2026.1109.0 | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1111.0) |
| [v2026.1110.1](v2026.1110.1.md) | 2026-11-10 | Bulk changes are for company owners and admins only; members keep changing records one at a time exactly as before; no migrations (from v2026.1109.1, the same migrations `0158`–`0161` as v2026.1110.0) | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1110.1) |
| [v2026.1110.0](v2026.1110.0.md) | 2026-11-10 | Change many records at once with a preview and per-record results; admin audit with CSV export; ceiling templates; choose a steward when removing a member; routine delete; label rename and recolor; batch changes from an admin's own Claude, off by default and not yet tried with Claude.ai itself; migrations `0158`–`0161` | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1110.0) |
| [v2026.1109.1](v2026.1109.1.md) | 2026-11-09 | Company archive, delete, settings, budget, import, export, secret management and CEO-type agents are owner/admin only; members keep creating ordinary agents and their own secrets; destructive-action ceiling covers HubSpot write requests and Slack sends; replaces the withdrawn v2026.1109.0; no migrations | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1109.1) |
| [v2026.1109.0](v2026.1109.0.md) | 2026-11-09 | **Withdrawn, do not install.** Company archive, delete, settings, budget, import, export, secret management and CEO-type agents are owner/admin only; members keep creating ordinary agents and their own secrets; destructive-action ceiling covers HubSpot write requests and Slack sends; adds the Fred guide and one new database table (migration 0158) | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1109.0) |
| [v2026.1105.0](v2026.1105.0.md) | 2026-11-05 | Guarded updater provenance correction; unchanged merged evaluation payload | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1105.0) |
| [v2026.1104.0](v2026.1104.0.md) | 2026-11-04 | Approved responsibility criteria, task mapping and persisted-output checks; native phone targets; public hosted-request guidance; canonical feedback access and withheld automatic wakes; no new migrations or dependencies | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1104.0) |
| [v2026.1102.1](v2026.1102.1.md) | 2026-11-02 | Agent scorecards fill in by default, including past work; hires from a brief for every runtime; names instead of raw ids on profile and approval screens; a setup agent can set a hosted box's agent model; migration `0157` (indexes only) | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1102.1) |
| [v2026.1102.0](v2026.1102.0.md) | 2026-11-02 | An agent sets up AgentDash Cloud for a person over MCP (start, approve, connect, then the setup tools); a failed provisioning job pages a person; no migrations for installs or boxes | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1102.0) |
| [v2026.1031.0](v2026.1031.0.md) | 2026-10-31 | Agents become the evaluated subject: versioned operating profiles applied after approval, per-agent access enforced off/shadow/enforce, agent scorecards, performance manager, start from a brief; better-auth 1.7 and zod 4 security upgrades; migrations `0153`–`0156` | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1031.0) |
| [v2026.1014.1](v2026.1014.1.md) | 2026-10-14 | An agent's memory and lessons are private to the agent, its steward and administrators: withheld from run records, run logs and feedback bundles, old runs cleaned; Memory section on the agent page; migration `0152` | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1014.1) |
| [v2026.1014.0](v2026.1014.0.md) | 2026-10-14 | Agent self-wakes, agent mentions and agent review hand-offs pause at the daily token ceiling; correct ceiling lift time; plain feature-flag wording; no migrations | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1014.0) |
| [v2026.1013.1](v2026.1013.1.md) | 2026-10-13 | A person's send-back, change request or answer wakes the agent over its token ceiling; only administrators change feature flags; no migrations | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1013.1) |
| [v2026.1013.0](v2026.1013.0.md) | 2026-10-13 | The person's own Claude as co-worker on the request loop: intake, review and send-back as the person, close-out to the requester; direct agent hand-offs capped at three rounds; corrections reach the agent; agentdash-connect 0.5.0; inbox email pointers off by default; three migrations (0149 to 0151) | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1013.0) |
| [v2026.1010.0](v2026.1010.0.md) | 2026-10-10 | Assigning a person assigns their agent, which takes a first pass and asks; agent questions answered from the person's own Claude or Codex session; email pointers; gpt-6 Codex models; My agent in the sidebar; steward-only document connections; document text kept out of stored runs; two migrations (0147, 0148) | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1010.0) |
| [v2026.1008.0](v2026.1008.0.md) | 2026-10-08 | Release preparation: accurate private Hermes SSH invocation records; stricter agent and approval authority; financial privacy; responsive log privacy checks; inactive-owner input recovery; public docs and updates; no migrations | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1008.0) |
| [v2026.1007.1](v2026.1007.1.md) | 2026-10-07 | Run-log reads yield between lines; chats and live transcripts follow the newest message; assignment-only wake policy with a run-window audit route; instance identity on the health check; no migrations | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1007.1) |
| [v2026.1007.0](v2026.1007.0.md) | 2026-10-07 | Business view as the default run page, with milestone timelines; agents in the left bar grouped by team; pre-launch security pass (restricted projects, approvals, agent configuration, spend, plugin secrets, security headers); Hermes over SSH, off by default; no migrations | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1007.0) |
| [v2026.1005.0](v2026.1005.0.md) | 2026-10-05 | Opt-in high/low Hermes model tiers (Qwen 3.8 Max / DeepSeek V4.1 Flash on Alibaba Token Plan); hires and decisions read in owner words; comments on finished issues stay FYI — no reopen, no wake; setup checks, Activity and Health tell the truth; migration `0146` | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1005.0) |
| [v2026.1004.0](v2026.1004.0.md) | 2026-10-04 | A stop sticks and a stopped run is not a failure; CoS hires after onboarding (approval-aware) and counts its own chat; plain words across Activity, Workforce, Costs and Settings; phone chevron, member cards and one secret mask; migration `0145` | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1004.0) |
| [v2026.1003.0](v2026.1003.0.md) | 2026-10-03 | Accept approves only the revision you saw; secrets removed on the server; CoS chat survives a dropped connection and states only what it can see; token-based Costs on your own key; warnings are not failures; phone headers; no migrations | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1003.0) |
| [v2026.1002.2](v2026.1002.2.md) | 2026-10-02 | /setup continues to the CoS; revised deliverables can be accepted again; plan card "Team hired" and one task card; token figures, readable transcripts and hidden credentials; title-first agents; phone floors everywhere; hosted Hermes setup check; reserved company prefixes; migration `0144` accountability backfill | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1002.2) |
| [v2026.1002.1](v2026.1002.1.md) | 2026-10-02 | CoS chat never goes silent (Z.AI endpoint pinned, error card with Retry, live replies); CoS creates tasks from chat; Accept / Request changes and Shipped means accepted; founder stays owner (+ `doctor repair-founder-owner`); phone redesign; security and backup fixes; migration `0143` | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1002.1) |
| [v2026.1002.0](v2026.1002.0.md) | 2026-10-02 | First-session release: one onboarding path, CoS plan without a nudge, Ask inside the app, reviews reach you, parked wizard tasks, no premature stalled-issue recovery, bootstrap privilege fixes | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1002.0) |
| [v2026.1001.2](v2026.1001.2.md) | 2026-10-01 | Launch-day security release: live events stop when access ends, import SSRF guard, routine-write guard, restricted projects hidden in budgets, member emails private; backups keep the whole schema and round-trip every value | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1001.2) |
| [v2026.1001.1](v2026.1001.1.md) | 2026-10-01 | Patch: the Agent visibility setting reads back (company reads omitted the column) | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1001.1) |
| [v2026.1001.0](v2026.1001.0.md) | 2026-10-01 | One navigation for every company (Inbox → Decisions, Settings hub); agent visibility administrators can narrow to "the agents you answer for"; workforce role templates; named-human control plane; migrations `0140`–`0142` | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.1001.0) |
| [v2026.930.1](v2026.930.1.md) | 2026-09-30 | Patch: restricted projects stay restricted in live updates, related issues, blocker ids and feedback traces; review queue can't stall; released creators can't mint connect codes; single-use OTA approvals and a served-release check | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.930.1) |
| [v2026.930.0](v2026.930.0.md) | 2026-09-30 | Stewards connect their own agent; termination frees the steward; human-clearable recovery budget; review escalations fire once; project access on every issue route; safer OTA updater; opt-in declared origins | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.930.0) |
| [v2026.929.0](v2026.929.0.md) | 2026-09-29 | Assigned work starts on To do; unowned To do goes to the CoS; company default status; 1.0 navigation on the default profile | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.929.0) |
| [v2026.927.0](v2026.927.0.md) | 2026-09-27 | Assistant work tools; connect GitHub; Shipped and Home; hosted first run and claim links; first release image | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.927.0) |
| [v2026.925.0](v2026.925.0.md) | 2026-09-25 | Assistant MCP read tools and OAuth; Hermes in the image; token ceiling; 13 security fixes | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.925.0) |
| [v2026.924.0](v2026.924.0.md) | 2026-09-24 | Instance updates work from the board; approval-gated reviewer auto-hire | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.924.0) |
| [v2026.923.0](v2026.923.0.md) | 2026-09-23 | Steward guides as pages in the app | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.923.0) |
| [v2026.922.1](v2026.922.1.md) | 2026-09-22 | Teams Workflows webhooks deliver messages again | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.922.1) |
| [v2026.922.0](v2026.922.0.md) | 2026-09-22 | Inbox pushes to a webhook; migration `0128_steward_webhooks` | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.922.0) |
| [v2026.915.0](v2026.915.0.md) | 2026-09-15 | Field fixes from the first stewards on connect 0.2.0; pairs with `agentdash-connect@0.2.1` | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.915.0) |
| [v2026.914.0](v2026.914.0.md) | 2026-09-14 | Redeeming a connect code also connects the inbox; pairs with `agentdash-connect@0.2.0` | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.914.0) |
| [v2026.909.2](v2026.909.2.md) | 2026-09-09 | Harness preflight says when its evidence is out of date | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.909.2) |
| [v2026.909.1](v2026.909.1.md) | 2026-09-09 | A run the platform lost is no longer reported as the agent's failure | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.909.1) |
| [v2026.909.0](v2026.909.0.md) | 2026-09-09 | Connect command picks the right address per network; first instance rollout of v2026.908.0 | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.909.0) |
| [v2026.908.0](v2026.908.0.md) | 2026-09-08 | Company Evaluator milestones 0 to 5 in shadow mode; My Agent page | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.908.0) |
| [v2026.904.0](v2026.904.0.md) | 2026-09-05 | Steward Inbox; governance reaches the Hermes runtime; subsumes the withdrawn v2026.902.1 | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.904.0) |
| [v2026.902.0](v2026.902.0.md) | 2026-09-02 | New agents are created with heartbeat on | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.902.0) |
| [v2026.827.2](v2026.827.2.md) | 2026-08-27 | OTA correction: native readiness checks the installed deployment | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.827.2) |
| [v2026.827.1](v2026.827.1.md) | 2026-08-27 | OTA correction: native macOS readiness wrapper parses | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.827.1) |
| [v2026.827.0](v2026.827.0.md) | 2026-08-27 | First AgentDash stable: resumable invited-member onboarding, run-attributed agent output | [Release](https://github.com/thetangstr/agentdash/releases/tag/v2026.827.0) |

## Withdrawn, never released

Notes were merged for these cuts, but no tag and no GitHub Release exist. The
files are kept for the record and marked at the top; the in-app Changelog hides
them.

| Version | Notes dated | What happened |
|---|---|---|
| [v2026.902.1](v2026.902.1.md) | 2026-09-02 | Cut cancelled at the gate; everything it carried shipped in v2026.904.0 |
| [v2026.827.3](v2026.827.3.md) | 2026-08-27 | Stable workflow dry-run only; the native backup fix first shipped in v2026.902.0 |

## Paperclip upstream, inherited with the fork

AgentDash is built on [Paperclip](https://github.com/paperclipai/paperclip).
These notes came with the fork and describe Paperclip releases, not AgentDash
ones. Their tags live on the `upstream` remote, not on this repository. Each
file is marked `> Upstream:` and the in-app Changelog labels it.

| Version | Released | Headline |
|---|---|---|
| [v2026.428.0](v2026.428.0.md) | 2026-04-28 | Pause and resume agents from the sidebar |
| [v2026.427.0](v2026.427.0.md) | 2026-04-27 | Multi-user access and invite flows |
| [v2026.416.0](v2026.416.0.md) | 2026-04-16 | Chat-style issue thread; execution policies |
| [v2026.415.0](v2026.415.0.md) | 2026-04-15 | Faster issues page and issue detail |
| [v2026.414.0](v2026.414.0.md) | 2026-04-14 | Authorization hardening (GHSA-68qg-g8mg-6pr7) |
| [v2026.403.0](v2026.403.0.md) | 2026-04-03 | Inbox overhaul; feedback and evals |
| [v2026.325.0](v2026.325.0.md) | 2026-03-25 | Company import/export; company skills library |
| [v2026.318.0](v2026.318.0.md) | 2026-03-18 | Plugin framework and SDK |
| [v0.3.1](v0.3.1.md) | 2026-03-12 | Gemini CLI adapter |
| [v0.3.0](v0.3.0.md) | 2026-03-09 | Cursor, OpenCode, and Pi adapters |
| [v0.2.7](v0.2.7.md) | 2026-03-04 | Onboarding resilience |

A checkout that also fetches the `upstream` remote will show more Paperclip
tags (v2026.512.0 through v2026.916.1 at the time of writing). Those are
Paperclip releases, not on `origin`, and are not part of this log.

## How releases are logged

1. Before a stable cut, write `releases/vYYYY.MDD.P.md` in the format below.
   It starts with `# vYYYY.MDD.P`, the same version as the file name, and then
   `> Released: YYYY-MM-DD` (prose may follow the date on the same line; only
   the date is read).
   `scripts/release.sh` refuses a stable cut without it.
2. Add a row for it at the top of the table above. In the same release-prep
   PR, refresh `releases/published.json` (see "Public release notes" below):
   `node scripts/published-releases.mjs --update-snapshot`.
3. Merge the notes to main before the cut, and cut the stable release from a
   main commit that contains them (pass that commit as `source_ref`). Once
   tagged, the notes file is frozen; a correction goes into the next
   release's notes. `.github/workflows/release.yml` refuses a source commit whose
   `releases/vX.md` is missing or differs byte for byte from the
   release-control copy, in both the dry run and the live run, before anything
   is tagged. It publishes the release-control copy as the GitHub Release
   body. Its last job, `refresh_release_site`, runs after the image digest is
   recorded: it checks with `scripts/check-release-body.mjs` (three attempts)
   that the published body is that file, ignoring the generated "Container
   image" section, and that the release is neither a draft nor a prerelease.
   A mismatch fails that job only; the image jobs never wait on it. Because
   the notes are frozen, fix a mismatch by editing the GitHub Release body to
   match `releases/vX.md`, then rerun the job. The UI bundles the files in its
   payload checkout (`ui/src/lib/release-notes.ts`).
4. A change to the public API contract that removes, renames or narrows
   something goes under a `## Deprecated` or `## Breaking` heading when it is
   announced, and `## Removed` or `## Breaking` when it lands
   (`docs/api/versioning.md`). Then run
   `node scripts/docs/generate-api-changelog.mjs`: `docs/api/changelog.md` is
   generated from these files, and CI fails while it is stale.
5. If a cut is cancelled after its notes merged, replace the `> Released:`
   line with `> Withdrawn, never released.` and a sentence on what happened,
   and move its row to the withdrawn table.
6. If a release is withdrawn after it was published (as v2026.1109.0 was), keep
   its tag, images and notes file, and put a line that starts
   `> **Withdrawn on YYYY-MM-DD. Do not install this release.**` under its
   `> Released:` line, and on top of its GitHub Release body. That line is the
   one permitted edit of a tagged note: the check no longer requires the copy to
   equal the tag's, the API changelog skips it, the public site leaves it off
   `/releases`, the in-app Changelog leaves it out, and the replacement release's
   notes say what it replaces. Prefix the row's headline with
   `**Withdrawn, do not install.**`.

`scripts/ci/check-release-log.mjs` runs on every PR. It fails when a stable
`v*` tag on `origin` (from v2026.512.0 on) has no notes file, when a notes file
has no parseable `> Released: YYYY-MM-DD` line and is not marked withdrawn,
when a note's `# ` heading is not the version in its file name, when this
index does not link every notes file, when a note after v2026.1105.0
does not follow the format below or (once tagged) differs from the copy in its
tagged commit (a tag cut from a commit without its notes fails too), or when
`releases/published.json` lists a version that has no notes file, is
withdrawn or upstream, or has no stable tag on `origin`.

## Note format

From the first stable cut after v2026.1105.0, a note opens with exactly these
four sections, in this order, and may add any technical sections after them:

```markdown
# vYYYY.MDD.P

> Released: YYYY-MM-DD

## What's new

- What a person using AgentDash will notice, in plain words.

## For admins

- Settings, permissions and anything an administrator must decide or do.

## Upgrade

- Migrations, required steps and compatibility. "- No changes." when none.

## Security

- Fixes and changed boundaries, described without exploit detail. "- No changes." when none.

## Fixes

- Technical detail, PR links and anything else, as before.
```

Each of the four keeps at least one bullet after the public-notes sanitizer
(`scripts/docs/public-release-notes.mjs`, the same withholding policy as the
in-app Changelog). The sanitizer keeps bullets only. It drops prose, sections
named Tests, Testing, Validation or Contributors, and any bullet, with its
children, that a withholding rule in `scripts/docs/generate-api-changelog.mjs`
matches: the private product profile, customer, person or instance names,
email and IP addresses, private hostnames and the upstream project's name. A
section of prose alone therefore publishes empty and fails the check; write "- No changes." when a section has nothing to say. Notes up to
and including v2026.1105.0 are historical and exempt, as are withdrawn and
upstream notes. No historical note is rewritten.

## Public release notes

`/releases` on www.agentdash.cloud lists every published AgentDash release,
newest first, and `/releases/vYYYY.MDD.P` shows one release's sanitized notes
with a link to its GitHub Release. A version appears only after its stable
GitHub Release is published:

- Vercel's build runs `node scripts/published-releases.mjs` before the UI build
  (`vercel.json` `buildCommand`). It writes a gitignored generated list from
  the GitHub Releases API: published, non-draft, non-prerelease stable
  releases, with `GITHUB_TOKEN` from the Vercel environment when set (against
  the 60-an-hour unauthenticated limit). Each request is tried up to three
  times on a network error, a 5xx, a 403 or a 429. It also writes the list,
  as versions, `publishedAt` and the source (`api` or `snapshot`) and nothing
  else, to `ui/public/releases/published.json`, served at
  `https://www.agentdash.cloud/releases/published.json`.
- When the API cannot be read, it uses the committed snapshot
  `releases/published.json` and the build log warns that versions published
  since the last snapshot refresh may be missing. The site then lags by those
  releases until a build can read the API. The public `releases.atom` feed is
  not used: it can list plain tags that have no published Release. Builds
  that do not run the script (tests, Docker images, self-hosted installs)
  read the snapshot directly.
- The pages are built from main, not from the tag. For every note after
  v2026.1105.0 that has a stable tag, `scripts/ci/check-release-log.mjs`
  requires main's `releases/vX.md` to be byte-identical to the copy in the
  tagged commit (local git only). A published note is never edited: a
  correction goes into the next release's notes.
- The pages list a version only when it is in that list and its notes file is
  neither withdrawn nor upstream. Withdrawn and upstream notes never appear.
- After the GitHub Release is verified, `release.yml` (job
  `refresh_release_site`) POSTs to the Vercel deploy hook in the repository
  secret `VERCEL_DEPLOY_HOOK_URL` (`scripts/release-site-deploy.mjs`; the URL
  is never printed), then polls `/releases/published.json` for up to 15
  minutes until it lists the new version. If it never does, the job fails:
  the site build fell back to the snapshot or the deploy did not finish.
  Rerun the job, or set a read-only `GITHUB_TOKEN` in Vercel's Production
  environment. Without the hook secret it warns and passes, and the release
  appears on the site after the next merge to main.
- The in-app Changelog is not filtered, since a build made from a tag cannot
  know whether its own release is published yet; it links to the public page.
