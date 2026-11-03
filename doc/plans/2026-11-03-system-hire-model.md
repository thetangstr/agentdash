# System hire model selection

Fix #1122: a confirmed plan or a system-requested reviewer must not silently
inherit a host CLI model when the company already has an explicit model for
the same runtime. Existing agents and their permissions remain unchanged.

## Implementation

- Resolve inside each existing hire transaction from active, idle or running
  agents in the same company and adapter. Prefer the Chief of Staff, then a
  stable agent-id ordering. Copy only model and optional provider.
- Preserve opted-in, BYOK-aware Hermes role tiers instead of replacing them
  with a peer's leadership model.
- With no eligible peer, Codex uses its configured interview model when
  Codex is the selected instance adapter. The built-in interview fallback is
  shared with chat dispatch. API interview models never become CLI defaults.
- With no compatible selection, preserve existing runtime fallback and put a
  warning on the hire approval. This is not a claim the fallback can run.
- Save provenance in agent metadata and project only public model fields onto
  approvals. Approval repair reads the persisted selection.
- Keep pending approvals, capacity locks, materialization pauses and retries.

## Verification

- Reproduce empty model configuration through both existing hire paths before
  fixing it, then run their regression tests.
- Cover company/adapter/status isolation, credential exclusion, deterministic
  selection, compatible fallback and Hermes tier preservation.
- Exercise persisted model/provenance and approval data using isolated test
  databases; check visible model and warning on the approval payload.
- Run typecheck, build, CI policy checks and the full test runner before a
  PR-ready handoff. Independently review the resulting change.

## Boundaries

No model probes, credential reads, database migration, customer-machine access,
deployment or existing-agent changes. A configured peer model is not proof of
account compatibility; a real target run remains a separate acceptance step.
Reviewer caps, cooldown and company review settings remain separate work under
#1123. Merge and release require the founder's explicit go.
