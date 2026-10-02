# Devin lane: urls (#954 + #938 + #937)

Phase: IN PROGRESS

- Lane A (#954): DONE — PR https://github.com/thetangstr/agentdash/pull/964 on `devin/urls-20261002`. Vitest 47/47 on touched files; server typecheck clean.
- Lane B (#938 + #937): implementation + tests done on `devin/sessions-20261002` (same worktree, branch off origin/main).
  - #937: `reauthorize` now returns an `{allowed, fingerprint}` pair (`ActorAccess`); the fingerprint covers instance-admin flag + every active membership (companyId:role:status, sorted) for board users and the agent's status for key upgrades. `recheckClient` propagates it; a passing heartbeat/access-change re-check calls `invalidateActor()` only when the fingerprint moved — an unchanged heartbeat costs zero actor re-reads. Verified by a counting-proxy test on `faultyDb`.
  - #938: no code fix needed — better-auth 1.6.23 routes sign-out through `internalAdapter.deleteSession` → `deleteWithHooks`, and bulk revocation through `deleteManyWithHooks`; both fire the `session.delete.after` hook per row, and `internalAdapter.deleteUser` fires `user.delete.after`. New tests drive a real better-auth instance (real sign-up cookie → WS upgrade → sign-out / revoke-sessions / deleteUser) and assert 1008 closes with the heartbeat faked and never advanced.

PRs: #964 (lane A). Lane B PR pending.
Blockers: none.
Last verification: `vitest run src/__tests__/live-events-ws-revocation.test.ts` 22/22 pass; `live-events-ws.test.ts`, `live-event-visibility-epoch.test.ts`, `live-events-project-visibility.test.ts` all pass; server typecheck clean (re-running after test edits).
