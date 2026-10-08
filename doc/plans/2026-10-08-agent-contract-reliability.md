# Agent contract reliability — 2026-10-08

The founder approved this platform batch after v2026.1008.0 shipped. The goal is
to let agents discover correct tool arguments and instructions, bound HTTP waits,
and shorten release verification without dropping coverage.

| Lane | Change | Evidence required before merge |
| --- | --- | --- |
| MCP contracts (#912, #926) | Preserve optional parameter descriptions and exact numeric bounds; name the mandate reader separately from directives; regenerate canonical MCP docs/search. | Failing regression first, then passing SDK `tools/list` consumer assertions, complete MCP tests/typecheck/build and docs drift/privacy checks. |
| HTTP adapter (#927), separate PR | Enforce the documented timeout through the existing invocation path. | Failing timeout regression first, then focused adapter tests/typecheck/build proving documented seconds, legacy compatibility, abort and connection cleanup. |
| Release verification (#896), refreshed PR | Reconcile the existing CI-sharding proposal with current source and preserve required checks. | Coverage/command parity, focused workflow checks and fresh hosted CI before merge. Record actual stable verification timing when the first new gate runs; no speedup claim before measurement. |

The current stable verification baseline is **33m25s**. No new CI speedup has
been measured. Each lane stays small, adds no dependencies or migrations, and
gets root review of the exact head plus green hosted CI before merge. Root owns
the combined full typecheck/test/build gate. This batch does not authorize a
runtime deployment.

Prepare the customer journey acceptance checklist separately: onboarding →
Chief of Staff → hire → completed task → human approval. Preparation and synthetic
tests are not proof of a live cloud/provider journey; that exercise needs its own
explicit scope and evidence.

## Customer journey acceptance preparation

Current issue evidence: #723 dependencies #721 and #725 are closed, while #675
and #722 remain open. All dependencies listed by #772 (#763–#769) are closed;
that proves neither a staged installation nor its keys. The existing
`tests/e2e/hosted-canary1.spec.ts` uses local-trusted/process agents, and
`tests/release-smoke/docker-auth-onboarding.spec.ts` exercises the older CEO
wizard. Neither establishes the current authenticated CoS journey.

Before a hosted exercise, identify an operator-owned staging origin, its
provider configuration, and an explicitly approved spend budget. Use a fresh,
disposable authenticated workspace. Do not reopen HQ signup, use production
customers, or provision a fleet of cloud boxes for this preparation.

Acceptance must connect CoS interview and confirmation → approved first hire →
one assigned task with a real artifact → acceptance by the correct accountable
human. Also exercise an invited teammate's boundary and approval refusal, then
pause/recovery/resume with exactly one continuation of the same task. Capture
source revision, instance identity, time to first accepted result, metering,
errors and the artifact/acceptance record so another operator can reproduce the
result. Keep missing evidence explicitly unknown. Offline UI/control-plane
fixtures and a real Hermes/provider exercise are separate evidence classes.

These are bounded bug and documentation fixes, not a roadmap feature expansion.
The active worker prompt is the unified default AGENTS.md, inherited by the
proposal creator. The deleted CEO and Chief of Staff prompt copies stay deleted.
The MCP changes advertise existing validation and correct the existing mandate
reader; they add no endpoint or capability.
