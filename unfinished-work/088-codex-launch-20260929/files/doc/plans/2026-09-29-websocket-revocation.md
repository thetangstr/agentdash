# Live-event WebSocket authorization refresh — 2026-09-29

Issue: https://github.com/thetangstr/agentdash/issues/708

## Problem and success criteria

The live-event WebSocket authorizes once during upgrade. A revoked key or session, removed company membership, demoted instance administrator, or terminated agent can therefore continue receiving company events. Every event delivery and every idle heartbeat must freshly confirm the original principal still has company access; denied, failed or timed-out checks must stop delivery and close the subscription.

## Implementation plan

1. Preserve credential identity in the upgrade context: the original key ID/hash and agent, or the original session ID/user. Local trusted board access retains its existing policy.
2. Check current session expiry/existence and user, plus current active company membership or instance-admin role. Check the original unrevoked agent key/company/agent and the agent's current admissible status. Another active key cannot authorize a revoked socket. Touch `lastUsedAt` only at initial upgrade.
3. Refresh authorization before each event and on heartbeat. Serialize authorization rounds per socket. Both event delivery and idle heartbeats wait for an earlier round, then start a fresh read; neither may reuse a snapshot begun before its event/tick. Each read has a five-second fail-closed deadline. Poll every 19 seconds, reserving five seconds for a prior round, five for the fresh round and one for forced termination: at most 30 seconds for quiet/stalled revocation. Preserve FIFO delivery and cap retained events.
4. Unsubscribe and clear socket state immediately when closing, including timeout/error/server shutdown. Give a responsive peer the policy close frame, then terminate within one second if it withholds a close reply. Queued deliveries and late successful checks cannot revive a closed subscription. Keep credentials and URL query strings out of logs.
5. Add real WebSocket/isolated embedded-Postgres regression coverage and controllable failure/slow-check tests. Run tests before the implementation to prove the existing vulnerability, then after the change. Run server typecheck and related edge-upgrade coverage.

## Verification and limits

Assert revoked membership/key/session events are withheld, quiet revoked sockets close on their next heartbeat, valid sessions deliver in order, another active agent key does not preserve a revoked socket, and an instance admin without membership loses the subscription on demotion. Cover principal termination, authorization errors/timeouts, close cleanup and no overlapping authorization rounds. Tests must not use live/customer databases or services.

This change does not introduce cross-service invalidation plumbing: current database authorization before delivery prevents subsequent events from relying on upgrade-time grants, and the existing heartbeat bounds closure for idle sockets. Database reads incur per-event work, deliberately preserving immediate revalidation; the queue closes overloaded clients instead of retaining unbounded event payloads. Database and session checks have the usual interval between the last successful read and the synchronous send.

Agent-facing impact: revoked company-event streams close with policy code `1008`; consumers should obtain current authorization before reconnecting and must not treat an old connection as continued access. Root owns updates to all four agent prompt surfaces if this contract requires a prompt addition. No endpoint or schema is added and no adapter-specific behavior is introduced.

## Local execution evidence

- The original implementation failed 12 of 16 checks for the expected stale-authorization/query-log behavior. The remaining four covered existing socket rejection, valid delivery and key-touch behavior.
- The final targeted command `pnpm exec vitest run server/src/__tests__/live-events-ws.test.ts server/src/__tests__/edge-gate.test.ts` passed **38 tests in two files**, with zero skips: 21 WebSocket tests and 17 edge-gate tests. These include disposable embedded-Postgres rows and actual loopback WebSockets; the DB failure and delayed-session checks replace only the database boundary after a successful real upgrade.
- `pnpm --filter @paperclipai/server typecheck` exited 0. `git diff --check` passed.
- The implementation, tests and this plan were changed only in `.claude/worktrees/codex-launch-20260929`. No live/customer database or service was used. No commit, push, issue comment, merge, deployment or release was performed.
- Root still owns the combined branch review, four agent prompt surfaces and any broader PR-ready validation. Per-event reads and the standard authorization-read/send race remain explicit limits; this is not a transactional invalidation bus.

### Independent review corrections

Independent review reproduced a pre-event heartbeat snapshot granting a post-revocation event and a 35-second idle timeout. Three new tests failed on those conditions before correction; the final tests also hold a successful event snapshot across the heartbeat tick. The fresh-after-pending policy now applies to both paths, and the 19+5+5+1 bound covers an already pending round and unresponsive close peers. Independent re-review found no remaining actionable issue within the documented database-read/send boundary. Full typecheck/build passed; the original full test runner stopped on an OpenCode SSH timeout that passed on a focused 10-test rerun. Broader release verification still includes known baseline doctor-test failure #750, addressed by unmerged PR #753. No live service was changed.
