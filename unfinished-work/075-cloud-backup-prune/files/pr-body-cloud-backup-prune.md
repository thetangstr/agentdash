## Thinking Path

> - AgentDash is a fork of Paperclip that runs a fleet of customer boxes on Railway, and the cloud control plane upgrades each box to a release through the `upgrade` job in `cloud/src/jobs/upgrade.ts`
> - Every upgrade takes a Railway backup ("Manual" snapshot) of each of the box's two volumes before pointing the service at a new image
> - Railway caps a volume at 10 backups. Scheduled backups expire on their own, but the manual pre-upgrade snapshots accumulate forever, so after enough upgrades every box hits the plan limit
> - On 2026-10-05 a canary upgrade to v2026.1005.0 failed repeatedly with `Plan limit of 10 backups per volume exceeded`, and the job retried the create until it gave up — a launch blocker
> - This change prunes the oldest eligible manual backups before taking a snapshot, so upgrades keep working as the fleet ages
> - When nothing prunable remains the upgrade fails dead with the volume named, so ops is paged once instead of after five pointless retries

## What Changed

- `cloud/src/railway/upgrade-api.ts` — added `listVolumeBackups` and `deleteVolumeBackup` GraphQL operations, plus `makeRoomForVolumeBackup`: when a volume holds `limit - 1` or more backups it deletes the oldest backups named "Manual", oldest first, until a slot is free. It never touches scheduled backups, never retries a backup Railway refused (locked, gone), always keeps the newest 2 manual ones, and waits out Railway's one-deletion-per-volume rule by polling the list inside a bounded window (`BACKUP_PRUNE_WAIT_MS`, 5 min). Every pruned backup id is logged at info. `BackupPruneExhaustedError` names the volume when no slot can be freed.
- `cloud/src/jobs/upgrade.ts` — the snapshot step calls `makeRoomForVolumeBackup` before `createVolumeBackup`, and maps both an exhausted prune and a create that Railway still refuses with a backup-limit error to `FatalJobError` (job goes dead: upgrade marked failed, box held, rollout paused, `job_dead` alert). New `backupLimit` and `backupPruneWaitMs` deps.
- `cloud/src/config.ts`, `cloud/src/index.ts` — `CLOUD_VOLUME_BACKUP_LIMIT` env var (positive int, default 10) feeds the handler's `backupLimit`.
- `doc/runbooks/cloud-control-plane.md` — documents the prune behavior and the env var in the upgrade section.
- Test fakes — `FakeVolume` models real backup records plus an in-flight deletion; `FakeRailwayUpgrade` answers list/delete, enforces the plan limit and the one-deletion rule, and records created backups as "Manual".

## Verification

- Four new cases in `cloud/src/__tests__/fleet-upgrade.test.ts` ("the Railway backup quota"), all written failing-first against the pre-change code:
  - at the limit, the two oldest manual backups are pruned, scheduled ones kept, and the snapshot succeeds (upgrade `succeeded`, count back to 9)
  - scheduled-only at the limit fails: upgrade `failed` with the volume instance id in the error, job state `dead`, `job_dead` alert sent, `backupsTaken` empty
  - a foreign deletion already in progress is waited out across list polls, then prune and snapshot proceed
  - with 3 manual + 7 scheduled at the limit, only the single eligible manual backup is deleted; the newest two are kept and the upgrade fails clearly rather than pruning them
- `npx vitest run` in `cloud/`: 448 passed, 9 skipped
- `pnpm -r typecheck`: clean across all workspace projects
- `pnpm build`: clean

## Risks

- Low-to-moderate: the new code only runs inside the upgrade job's snapshot step. The conservative rules (scheduled never deleted, newest two manual kept, refusals never retried) bound the worst case to "fewer old snapshots than before", which is the intended trade.
- If Railway names manual backups something other than "Manual" on some tier, those backups count as unprunable and the volume eventually fails loud (dead job, paged) rather than silently — the failure is detectable and the runbook says what to do.
- A deletion stuck longer than 5 minutes fails the job dead; the alternative (unbounded waiting inside a 2-minute step timeout) would stall the job instead.

## AgentDash Review

- **Upstream impact:** None - cloud control-plane code (`cloud/`) is AgentDash-owned and does not exist upstream.
- **Agent-facing prompt surfaces:** None - box agents never see or act on volume backups; no prompt behavior changes.
- **AgentDash-owned subsystem:** Affects the fleet upgrade job (`cloud/src/jobs/upgrade.ts`) and Railway client ops; behavior change is confined to the pre-upgrade snapshot step.

## Model Used

- Provider: Cognition — Devin CLI
- Model: Cognition SWE-2 (high effort); agentic coding with file editing, shell, and test execution tools

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have filled out AgentDash Review with upstream impact, prompt-surface impact, and owned subsystem
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] If this is upstream-derived, I have followed `doc/UPSTREAM-POLICY.md` and recorded the upstream SHA/reason/verification
- [x] If this changes agent-facing behavior, I have updated both prompt surfaces (default AGENTS.md and agent-creator-from-proposal.ts) or explained why they do not apply
- [x] I will address all Greptile and reviewer comments before requesting merge
