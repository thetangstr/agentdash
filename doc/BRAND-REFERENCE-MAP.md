# Brand Reference Map

Date: 2026-03-31
Status: Working classification after `@agentdash/*` namespace migration

## Purpose

This document classifies the remaining `Paperclip` references in the repo so the rebrand can continue without breaking upstream compatibility or runtime contracts.

## Snapshot

Current rough inventory from repo-local grep:

- total remaining `Paperclip` references: `745`
- docs/history: `567`
- runtime/product code: `123`
- tests: `44`
- other: `11`

The remaining references are not one bucket. Some should be renamed. Some should stay.

## Buckets

### 1. Keep As Explicit Upstream Reference

These references are correct because they describe upstream provenance, fork history, or upstream-specific concepts.

Examples:

- fork/origin language in [ARCHITECTURE.md](/Users/Kailor/conductor/workspaces/townhall/install-multi-agent/ARCHITECTURE.md)
- upstream sync strategy and `upstream` remote references
- historical docs comparing AgentDash to Paperclip
- tests or fixtures intentionally referencing upstream repos like `paperclipai/companies`

Rule:
- keep these as `Paperclip`
- make the upstream relationship explicit where helpful

### 2. Keep For Runtime / Protocol Compatibility

These references are part of stable compatibility surfaces and should not be renamed casually.

Examples:

- `PAPERCLIP_*` environment variables
- `X-Paperclip-Run-Id`
- `.paperclip/` repo-local config/state
- built-in `paperclip` skill slug and repo paths
- `paperclip.workspaceRuntime` payload fields in gateway integrations

Rule:
- keep these until there is a deliberate compatibility migration plan
- if renamed in future, provide dual-read / dual-write shims first

### 3. Rename In User-Facing Product Surfaces

These are the highest-priority remaining rebrand items because customers will see them.

Examples:

- [doc/PRODUCT.md](/Users/Kailor/conductor/workspaces/townhall/install-multi-agent/doc/PRODUCT.md)
- [doc/GOAL.md](/Users/Kailor/conductor/workspaces/townhall/install-multi-agent/doc/GOAL.md)
- [doc/PUBLISHING.md](/Users/Kailor/conductor/workspaces/townhall/install-multi-agent/doc/PUBLISHING.md)
- [doc/DEVELOPING.md](/Users/Kailor/conductor/workspaces/townhall/install-multi-agent/doc/DEVELOPING.md) in non-compatibility prose
- [server/src/services/company-export-readme.ts](/Users/Kailor/conductor/workspaces/townhall/install-multi-agent/server/src/services/company-export-readme.ts)
- [cli/src/client/http.ts](/Users/Kailor/conductor/workspaces/townhall/install-multi-agent/cli/src/client/http.ts)
- [cli/src/commands/client/agent.ts](/Users/Kailor/conductor/workspaces/townhall/install-multi-agent/cli/src/commands/client/agent.ts)

Rule:
- rename product copy from `Paperclip` to `AgentDash`
- preserve compatibility tokens inside the same file where needed

### 4. Rename In Internal Runtime Copy When Safe

These are internal messages, comments, and descriptions that are not protocol identifiers.

Examples:

- “Paperclip-managed” labels in local adapter status text
- “Required by Paperclip” / “Managed by Paperclip” labels
- plugin descriptions that still say “Paperclip plugin”
- company export/readme copy

Rule:
- rename these gradually
- avoid changing wire formats, file names, or env var keys in the same pass

### 5. Leave Tests / Fixtures Until They Stop Paying Rent

Many test strings still use `Paperclip` because they verify compatibility, old fixtures, or upstream import cases.

Examples:

- portability tests for `paperclipai/companies`
- worktree fixture names
- transcript fixtures and snapshot text

Rule:
- only rename tests when the product-facing behavior changed
- keep upstream-specific tests explicit

## Recommended Next Pass

### Pass A: Product Copy Cleanup

Rename remaining customer-visible product docs and export/readme strings to `AgentDash`.

Targets:

- `doc/PRODUCT.md`
- `doc/GOAL.md`
- `doc/PUBLISHING.md`
- `doc/DEVELOPING.md`
- `server/src/services/company-export-readme.ts`
- `cli/src/client/http.ts`
- `cli/src/commands/client/agent.ts`

### Pass B: Internal Messaging Cleanup

Rename safe internal labels and descriptions while preserving compatibility tokens.

Targets:

- adapter descriptions and warnings
- plugin descriptions / READMEs
- UI copy that still says “Required by Paperclip” or similar

### Pass C: Optional Compatibility Migration

Only if we want a complete protocol-level rename:

- `PAPERCLIP_*` env vars
- `.paperclip/`
- `X-Paperclip-Run-Id`
- built-in `paperclip` skill / path conventions

This is a breaking migration unless implemented with:

- dual-read / dual-write behavior
- fallback aliases
- migration docs
- test coverage for old and new names

## Commercialization Guidance

For commercial launch, a “good enough” rebrand does **not** require Pass C.

Commercial launch **does** require:

- package namespace and published metadata rebrand
- visible app/CLI/docs rebrand
- no misleading upstream branding in distributable marketing/product surfaces
- explicit note that AgentDash is forked from Paperclip where provenance matters
