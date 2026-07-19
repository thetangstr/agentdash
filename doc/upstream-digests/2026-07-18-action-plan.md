# Upstream Digest Action Plan — 2026-07-18

## Summary

Generated from `doc/upstream-digests/2026-07-18.md`
- **Total upstream commits ahead:** 777
- **Worth a look (score ≥ 2):** 187
- **Skip — agentdash-owned:** 29
- **Skip — conflict-only wiring:** 1
- **Skip — other:** 560

---

## Tier 1 — Security, Drop-in (CHERRY-PICK CANDIDATES)

These commits pass gates 1-4 and are marked `drop-in` (small diff, no new files).

| SHA | Date | Subject | Files | Verdict |
|-----|------|---------|-------|---------|
| `70357b961f` | 06-12 | Per-company JWT signing keys for multi-tenant isolation (#5864) | `server/src/__tests__/agent-auth-jwt.test.ts`, `server/src/agent-auth-jwt.ts` | **CHERRY-PICK** |
| `242a2c2f2b` | 05-17 | Stop cli worktree init --force from wiping repo worktrees/ (#6240) | `cli/src/__tests__/worktree.test.ts`, `cli/src/commands/worktree.ts` | **CHERRY-PICK** |
| `57a7da81ee` | 07-07 | Isolate run JWTs by control-plane instance (#9162) | `server/src/__tests__/agent-auth-jwt.test.ts`, `server/src/__tests__/agent-auth-middleware.test.ts`, `server/src/agent-auth-jwt.ts` | **CHERRY-PICK** |
| `5d315ab778` | 06-09 | Defer same-issue forceFreshSession wakes into follow-up runs (#4080) | `server/src/__tests__/heartbeat-workspace-session.test.ts`, `server/src/services/heartbeat.ts` | **CHERRY-PICK** |

---

## Tier 2 — Heartbeat/Recovery Fixes (CHERRY-PICK CANDIDATES)

These fix bugs in code we actively ship (heartbeat, recovery).

| SHA | Date | Subject | Files | Verdict |
|-----|------|---------|-------|---------|
| `4f9894df44` | 07-16 | Bound accepted-interaction continuation recovery (#9656) | `server/src/services/heartbeat.ts`, tests | **CHERRY-PICK** |
| `53f09cb818` | 07-16 | Prevent duplicate task creation + recovery loops (#9648) | `server/src/services/heartbeat.ts`, tests, migration | **CHERRY-PICK** |
| `85404b46c5` | 07-16 | Throttle serial recovery repeats (#9651) | `server/src/services/heartbeat.ts`, tests | **CHERRY-PICK** |
| `f019f54bb3` | 06-30 | Fix active heartbeat run reaping (#8776) | `server/src/services/heartbeat.ts`, tests | **CHERRY-PICK** |
| `b853ce5183` | 06-11 | Fix heartbeat task-session reuse when agent model changes (#4195) | `server/src/services/heartbeat.ts`, tests | **CHERRY-PICK** |
| `a0f7d3daba` | 06-10 | Reset task session on timer-driven wakes (#4838) | `server/src/services/heartbeat.ts`, tests | **CHERRY-PICK** |
| `130219c0be` | 06-12 | Don't stranded-escalate when assignee shows visible progress (#5213) | `server/src/services/recovery/service.ts`, tests | **CHERRY-PICK** |
| `67c98323b0` | 06-19 | Exempt routine-parent issues from missing-disposition handoff (#8157) | `server/src/services/heartbeat.ts`, `server/src/services/recovery/*.ts` | **CHERRY-PICK** |
| `f672a9e2e5` | 06-20 | Keep agent pause durable at execution-start (#8317) | `server/src/services/heartbeat.ts`, `server/src/services/agent-invokability.ts` | **CHERRY-PICK** |

---

## Tier 3 — Issues/Secrets/Adapters (CHERRY-PICK CANDIDATES)

Small blast radius, fixes specific bugs.

| SHA | Date | Subject | Files | Verdict |
|-----|------|---------|-------|---------|
| `9e81067678` | 06-12 | Clear stale executionRunId on release/reassignment/checkout (#2482) | `server/src/services/issues.ts`, tests | **CHERRY-PICK** |
| `eb452fba30` | 05-13 | Fix comment date binding regression (#5919) | `server/src/services/issues.ts`, tests | **CHERRY-PICK** |
| `2c4c110e90` | 07-02 | Fix issue create response relation summaries (#8901) | `server/src/services/issues.ts`, tests | **CHERRY-PICK** |
| `333a16b035` | 05-14 | Fix company export with missing run logs (#5960) | `server/src/services/issues.ts`, tests | **CHERRY-PICK** |
| `f90ea4dae4` | 06-25 | Fix top-level secret ref binding sync (#8630) | `server/src/services/secrets.ts`, tests | **CHERRY-PICK** |
| `4856558fd9` | 07-09 | Fix skills routes to skip user secret resolution | `server/src/routes/agents.ts`, `server/src/services/secrets.ts`, tests | **CHERRY-PICK** |
| `e93d78b46c` | 06-20 | Harden live-events WS upgrade sockets (#8383) | `server/src/realtime/live-events-ws.ts`, tests | **CHERRY-PICK** |
| `8b85fdfa3c` | 06-07 | Send X-Paperclip-Run-Id so agents can mutate own issues via CLI (#7642) | `cli/src/commands/client/common.ts`, tests | **CHERRY-PICK** |
| `70c86d2c73` | 07-07 | Strip ANSI escapes from Hermes terminal output (#8731) | `packages/adapters/hermes/src/gateway/ui/parse-stdout.ts`, tests | **SKIP** — external Hermes, may already have it |
| `0713dfa41f` | 06-09 | Validate session ID as UUID before --resume (claude-local) (#1742) | `packages/adapters/claude-local/src/server/execute.ts`, tests | **CHERRY-PICK** |

---

## Next Steps

1. **Create Linear issues** for each tier (or use this doc as the tracking artifact)
2. **Start with Tier 1** — security commits are highest priority
3. **Cherry-pick each commit** per `doc/UPSTREAM-POLICY.md`:
   ```sh
   git cherry-pick <sha>
   pnpm -r typecheck && pnpm test:run && pnpm build
   ```
4. **Log cherry-picks** in `doc/UPSTREAM-POLICY.md` Cherry-pick log section

---

## Notes

- The digest script `scripts/upstream-digest.sh` is working correctly
- Linear MCP integration is not currently connected (requires OAuth setup)
- This document serves as the tracking artifact until Linear issues are created
