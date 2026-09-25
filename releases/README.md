# Release log

Every AgentDash release has a notes file in this directory, `vYYYY.MDD.P.md`.
This index lists all of them, newest first. The same files are the body of
each GitHub Release and the in-app Changelog, so this is the one release log.

## AgentDash releases

| Version | Released | Headline | GitHub Release |
|---|---|---|---|
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

1. Before a stable cut, write `releases/vYYYY.MDD.P.md`. It starts with
   `# vYYYY.MDD.P` and then `> Released: YYYY-MM-DD` (prose may follow the date
   on the same line; only the date is read). `scripts/release.sh` refuses a
   stable cut without it.
2. Add a row for it at the top of the table above.
3. `.github/workflows/release.yml` publishes the file as the GitHub Release
   body, and the UI bundles it into the in-app Changelog
   (`ui/src/lib/release-notes.ts`).
4. If a cut is cancelled after its notes merged, replace the `> Released:`
   line with `> Withdrawn, never released.` and a sentence on what happened,
   and move its row to the withdrawn table.

`scripts/ci/check-release-log.mjs` runs on every PR. It fails when a stable
`v*` tag on `origin` (from v2026.512.0 on) has no notes file, when a notes file
has no parseable `> Released: YYYY-MM-DD` line and is not marked withdrawn, or
when this index does not link every notes file.
