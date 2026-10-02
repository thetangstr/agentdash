# Devin lane: urls (#954 + #938 + #937)

Phase: REVIEW FIXES for PR #964 (in progress on `devin/urls-20261002`; not merged)

- Lane A (#954): PR https://github.com/thetangstr/agentdash/pull/964 — review round from `.omc/briefs/devin-20261002/review-964.md` applied:
  - MEDIUM (declared-mode precedence): boot now registers `config.canonicalOrigin` when origins are declared and `config.authPublicBaseUrl` otherwise, via the new `registerBootOriginState` helper; the `fileAuthPublicBaseUrl` term was removed from the `canonicalOrigin` chain so `PAPERCLIP_ORIGINS` keeps priority over the config-file URL. New tests assert `configuredPublicBaseUrl() === canonicalOrigin` for `PAPERCLIP_ORIGINS` + `BETTER_AUTH_URL` and `PAPERCLIP_ORIGINS` + config-file URL.
  - LOW (shared helper): `registerBootOriginState` in `server/src/lib/public-base-url.ts` performs minting + configured-URL registration; called from `index.ts` (once for all modes, again with the resolved trusted set in authenticated mode) and from both `bootAs` copies in `declared-origins.test.ts`.
  - `issuerBaseUrlStrict` error text now names config-file `auth.publicBaseUrl`.
  - `docs/deploy/environment-variables.md` documents the config-file URL's precedence.
  - PR body updated: `Closes #954`, MKThink pre-rollout acknowledgement, expanded Risks.
- Lane B (#938 + #937): DONE — PR https://github.com/thetangstr/agentdash/pull/968 on `devin/sessions-20261002` (rebased onto latest origin/main). Unchanged by this round.

PRs: #964 (lane A), #968 (lane B). Neither merged.
Blockers: none.
Verification this round:
- `vitest run src/__tests__/declared-origins.test.ts src/lib/public-base-url.test.ts` — 49/49 pass
- `vitest run src/__tests__/assistant-oauth.test.ts` — 67/67 pass
- `pnpm -r typecheck` — in progress
- `node scripts/ci/check-pr-process.mjs --body-file` — pending
