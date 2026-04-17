# Phase 1 Adapter Disposition Decisions

Date: 2026-04-16
Author: Executor (CUJ-D)

## Summary

Audited all `comingSoon: true` flags and "Coming soon" copy across four files:
- `ui/src/adapters/adapter-display-registry.ts`
- `ui/src/pages/InviteLanding.tsx`
- `ui/src/components/AgentConfigForm.tsx`
- `ui/src/pages/AgentDetail.tsx`

## Enumeration of Gated Items

| Location | File | Lines | Gated Adapters |
|----------|------|-------|----------------|
| adapter-display-registry | adapter-display-registry.ts | 96-98, 103, 109 | `openclaw_gateway`, `process`, `http` |
| InviteLanding | InviteLanding.tsx | 17, 270-271 | All adapters NOT in `ENABLED_INVITE_ADAPTERS`: `process`, `http`, `claude_api`, `openclaw_gateway` (+ `hermes_local` is in adapterDisplayMap but not in AGENT_ADAPTER_TYPES; not present in InviteLanding set) |
| AgentConfigForm | AgentConfigForm.tsx | 1057-1077 | Any adapter with `comingSoon: true` from registry: `openclaw_gateway`, `process`, `http` |
| AgentDetail breadcrumb | AgentDetail.tsx | 870-871 | `skills` tab breadcrumb (commented-out, not adapter-gating) |

## Disposition Table

| Adapter | Current State | Disposition | Rationale |
|---------|--------------|-------------|-----------|
| `openclaw_gateway` | `comingSoon: true` in registry; disabled in InviteLanding; disabled in AgentConfigForm dropdown | **ship as available** | OpenClaw adapter has a full implementation under `ui/src/adapters/openclaw-gateway/`. The gateway protocol is stable. Shipping enables real agent testing. |
| `process` | `comingSoon: true` in registry; disabled in InviteLanding; disabled in AgentConfigForm dropdown | **ship as available** | Process adapter has a full implementation under `ui/src/adapters/process/`. Used internally and by tests. |
| `http` | `comingSoon: true` in registry; disabled in InviteLanding; disabled in AgentConfigForm dropdown | **ship as available** | HTTP adapter has implementation under `ui/src/adapters/http/`. Simple stable adapter. |
| `claude_api` | Not in registry display map; disabled in InviteLanding `ENABLED_INVITE_ADAPTERS` set | **ship as available** | Already selectable in AgentConfigForm (no `comingSoon` flag). Adding to InviteLanding ENABLED set. Adapter exists in AGENT_ADAPTER_TYPES. |
| Skills tab breadcrumb | Comment at AgentDetail.tsx:870 | **restore** | The skills tab and content are fully wired (tab at line 1012, view at line 1123). Only the breadcrumb was commented out with `// TODO: bring back later`. Uncomment it. |

## Changes Required Per Task

- **D2**: Remove `comingSoon: true` from `openclaw_gateway`, `process`, `http` in `adapter-display-registry.ts`. Remove `disabledLabel` from `openclaw_gateway` (it was only relevant when coming-soon gated).
- **D3**: In `InviteLanding.tsx`, expand `ENABLED_INVITE_ADAPTERS` to include all adapters in `AGENT_ADAPTER_TYPES` (or remove the set and the gating logic entirely). Remove `disabled` attribute and "(Coming soon)" suffix from option rendering.
- **D4**: In `AgentConfigForm.tsx`, the `comingSoon` check on the adapter picker will automatically resolve once D2 removes the flags. No separate change needed beyond D2.
- **D5**: In `AgentDetail.tsx`, uncomment lines 870-871 (skills breadcrumb).

## Notes

- No adapters are classified as Enterprise-only for Phase 1. All four gated adapters have full implementations.
- The `hermes_local` adapter is in the display registry but not in `AGENT_ADAPTER_TYPES`; it is not gated and does not need action.
- The `disabledLabel` field on `openclaw_gateway` ("Configure OpenClaw within the App") is removed since it was gating UX copy.
