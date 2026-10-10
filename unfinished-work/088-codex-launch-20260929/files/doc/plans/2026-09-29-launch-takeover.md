# AgentDash launch takeover

**Goal:** reach the approved October 28 hosted launch: waitlist approval with a daily cap of ten, including the newly required workforce templates and company-specific agent onboarding. Fully open signup and ExecOS retirement have separate gates.

**Source:** September 29 Claude handoff and later Gate A update; approved MVL/self-serve designs; fresh GitHub audit at 18:09 UTC. Full audit and preparation evidence are in `/Users/Kailor/Documents/Codex/2026-09-12/f6-monica-evaluation/`.

## Working boundaries

Use isolated worktrees under `.claude/worktrees/`. Main, live :3199, customer machines, ExecOS/Monica runtime, voice routes, Funnel and secrets remain protected. Code is prepared for PR review. Merge, publish, deployment, production gate changes, target selection and retirement retain the explicit handoff approval gates.

No new dependencies. Preserve company scope, approval, budget, activity and provenance contracts. Independent owners do not edit one another's files.

## Current lanes

| Lane | Owner/worktree | Deliverable and acceptance |
| --- | --- | --- |
| Launch backlog | Codex audit | 80 issues reconciled against merged PRs; 11 open PRs ranked. At least 11 stale-open MVL items are marked for acceptance reconciliation, not counted as unfinished code. |
| Release security/UX review | Codex; existing branches remain Devin-owned | Review exact heads #842, #843, #821, #819. #821 currently needs a repeat-hire and stale-session fix. #819 code requests resolved; description and screenshot evidence need repair. Candidate publication waits for integration and fresh checks. |
| Repeat-hire fix | Codex `codex-hire-reopen-20260929` | Rendered component regressions for reopen, cancellation and company switch; generation guard; targeted tests/UI typecheck/build; corrective patch for #821. |
| Security #708 | Codex `codex-launch-20260929` | Revoked same key/membership/session loses its socket and receives no new event within a heartbeat; fail closed during refresh; ordered delivery and cleanup; targeted real-socket tests then full checks. |
| Cloud SC-8 #769 | Codex `codex-cloud-billing-20260929` | Signed Stripe fan-out, per-box metadata, plan tiers, shared key rotation and Resend lifecycle. Fake external clients; forwarded raw bytes accepted by real Stripe verification; no keys in logs/job rows; full checks. No live account operations. |
| Gate A/PR-B | Codex `codex-assistant-digest-20260929` | Final orchestrator handoff: Claude stopped before writing code. Codex owns widened company/project visible-work digest, text-flagged decisions and description-backed blocker explanations. Dated plan prepared; implementation not started. |
| Host-only assistant grant CLI | Codex design prepared | Founder selected host-only consent; :3199 is tailnet reachable, so HTTP local-board consent remains forbidden. Direct-local-DB approval/revocation with real identity, company/scopes pin, host origin and private callback artifact; plan ready, implementation not started. |
| Workforce templates + company onboarding | Codex research / founder discussion | **Launch must-have**, added by the founder September 29. Research and requirements first; live conversation before feature implementation. Role instructions, sourced company learning, targeted missing-information questions, durable answers and evidence of task completion. |
| History/telemetry/connection/migration kits | Codex, handoff folder | History backup and scratch restore verified; telemetry sampler smoke-tested and plist delivered unloaded; public-box connection kit and document-only rewiring plan prepared. Observation windows and projector parity remain pending. |

## Launch sequence

**New release gate:** workforce templates and company-specific agent onboarding must be designed with the founder, implemented, and pass real outcome evaluations before launch. Treat as launch-blocking; no coding of this feature before the requested live discussion. See `2026-09-29-workforce-templates-requirements.md`.

1. Resolve release findings, integrate through the authorized merge authority, run targeted checks plus `pnpm -r typecheck`, `pnpm test:run`, `pnpm build` on that candidate. Prepare v2026.929.1 for publication approval. .0 is published; .1 does not yet exist.
2. Close verified prelaunch security findings: #708, #709, #710, #734, #809, then hosted-reach disposition for #810/#811/#740. Each gets a bounded reproduction and PR; do not waive by label or count.
3. Complete SC-8 #769 and SC-10 #771. Use the approved idle policy: warning 14 days, suspend 21, deletion warning 45, deletion 60; Pro/trial exempt. Account actions in #759 use the existing secret channel.
4. On an approved internal staging/public box, prove claim completion/close_signup, key/profile persistence, real Hermes work, read-only OAuth/scope/revocation, paid lifecycle, restart/backup restore/rollback and induced alerts. Three complete staging passes and ten concurrent healthy signup boxes satisfy #772; cleanup is part of the test.
5. Only after those proofs, prepare the capability PR for claimTrackingReady/claim fragment floor. Stored provisioning and edge gates remain off until the designated production authority approves rollout. Waitlist+cap ten is the launch scope; fleet rollout automation #773 may follow launch.

## Decisions that need a concrete target

The user selected **local :3199** as the launch verification target on September 29. Fresh health/discovery checks returned 200 and `local_trusted/private`, with loopback OAuth metadata and PKCE S256. Use that selected target for permitted verification; do not contact customer/production Railway systems as a substitute. Normal OAuth consent remains blocked in this mode, and ChatGPT cannot directly reach a loopback URL. Authentication and connector reachability changes require the concrete transition review below.

For consolidation, the final handoff records the founder’s choice: a host-only grant CLI using existing OAuth tables and real owner identity. Do not change mode or add HTTP local-board consent. ChatGPT/Muse connection reachability and the authorized instance update remain separate operational steps. This does not block October 28 hosted launch. Retire ExecOS only after parity, isolated projector recovery, Mac/Pixel evidence, 14 zero-fallback days, seven request-accounted days, Funnel disposition and founder sign-off.

## Stop criteria

Launch is complete only when the published candidate and approved target satisfy these gates with dated evidence. Prepared code, a healthy endpoint, green CI on separate branches, a database copy, or the old local ChatGPT demonstration does not substitute for the missing integrated/live proofs.

## Verified takeover progress

- WebSocket #708: 38/38 focused tests, zero skips; independent security review cleared the corrected 19s/fresh-read/forced-close implementation. Typecheck/build passed. Full suite originally stopped on an inherited OpenCode timeout; focused rerun passed10/10.
- #821 correction: 14/14 related component tests, typecheck/build passed, real-browser component fixture reproduced disabled repeat hire before and successful repeat hire after. Responses were simulated, not hosted-box UAT.
- #843 correction: durable notification reservation before email, real PostgreSQL cross-instance/rollback/partial-mail coverage89/89; typecheck/build passed. UI429 false delivery claim corrected11/11. Full runner stopped on inherited doctor warning (#750/#753) and intermittent embedded-PG reseed initialization.
- SC8 independent re-review cleared the corrected source: current-state reconciliation at the actual box, atomic entitlement/ledger retry, trial reminder forwarding and bounded provider/lock waits. Independent correction tests31/31 plus signature/fanout13/13 passed; real DB lock refusal observed at2085ms. Full typecheck/build passed. Full test:run still stops on the unchanged CLI doctor warning assertion; isolated embedded-PG startup retries are being recorded by the author. Live provider and rollout gates remain open, so this is not a completed release gate. See the external `AGENTDASH-CODEX-SC8-SECURITY-REVIEW-2026-09-29.md`.
- Workforce live discussion clarified department-specific OKRs/KPIs, high-quality completed work, actual company assets and realistic model costs. Customer segment and pilot access remain unconfirmed. A narrow SMB workflow wedge is being researched before final scope and implementation; see the requirements draft's live discussion notes.
- No merge, release, gate activation, live grant, runtime restart or customer deployment has occurred. New final handoff acknowledges merging also deploys www to production; integrated proof and applicable founder gates remain necessary.
