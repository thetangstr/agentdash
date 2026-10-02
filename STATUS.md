# Devin lane: urls (#954 + #938 + #937)

Phase: DONE (both PRs open; not merged, per instructions)

- Lane A (#954): DONE — PR https://github.com/thetangstr/agentdash/pull/964 on `devin/urls-20261002`. Vitest 47/47 on touched files; server typecheck clean.
- Lane B (#938 + #937): DONE — PR https://github.com/thetangstr/agentdash/pull/968 on `devin/sessions-20261002` (rebased onto latest origin/main).
  - #937: `reauthorize` returns `{allowed, fingerprint}`; the fingerprint covers instance-admin flag + every active membership (companyId:role:status, sorted) for board users and agent status for key upgrades. `applyActorFingerprint` invalidates the cached actor only when a passing re-check observes a change — unchanged heartbeats cost zero actor re-reads.
  - #938: no code fix needed — better-auth 1.6.23 routes sign-out through `deleteWithHooks` and bulk revocation through `deleteManyWithHooks`, both firing `session.delete.after` per row; `internalAdapter.deleteUser` fires `user.delete.after`. Tests drive a real better-auth instance end to end.

PRs: #964 (lane A), #968 (lane B). Neither merged.
Blockers: none.
Last verification (on rebased `devin/sessions-20261002`):
- `npx vitest run src/__tests__/live-events-ws-revocation.test.ts` — 22/22 pass
- `live-events-ws.test.ts`, `live-event-visibility-epoch.test.ts`, `live-events-project-visibility.test.ts` — all pass
- `pnpm --filter @paperclipai/server typecheck` — clean
- `pnpm --filter @paperclipai/server build` — clean
- `node scripts/ci/check-pr-process.mjs --body-file` — pass for both PR bodies
