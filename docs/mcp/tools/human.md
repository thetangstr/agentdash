---
title: "Human toolset"
summary: "The trusted-local-human toolset: the signed-in person's own board key, over stdio."
---

> Generated at commit `052acc60e` by `scripts/docs/generate-mcp-reference.mjs`.
> Do not edit this page: run `pnpm docs:mcp-reference` instead. CI fails when it is stale.

**6 tools** — measured: the length of the `tools/list` response. Source: `buildToolSurface(client, config, "human")` in `packages/mcp-server/src/index.ts`; the tools are defined in `src/human.ts`, their input schemas in `packages/shared/src/validators/human-control.ts`.

Each tool's description is its inline string, verbatim. The input table is rendered from the JSON schema the server advertises in `tools/list` (`humanJsonSchema` from `packages/shared/src/validators/human-control.ts`, as `src/index.ts` uses for this toolset). Nested objects are flattened: `a.b` is property `b` of object `a`, and `a[].b` is property `b` of each item of array `a`.

Tools, in the order `tools/list` returns them: `human_identity`, `human_select_target`, `human_discover`, `human_read`, `human_prepare`, `human_confirm`.

## `human_identity`

Verify the named human and list authorized explicit target choices.

Annotations: `destructiveHint: false`, `openWorldHint: false`, `readOnlyHint: true`.

No input.

## `human_select_target`

Explicitly select an authorized company, self, instance or public target. Existing action handles remain pinned.

Annotations: `destructiveHint: false`, `openWorldHint: false`, `readOnlyHint: true`.

| Property | Type | Required | Description |
|---|---|---|---|
| `target` | { kind: `"company"`, companyId: string (uuid) } \| { kind: `"self"` } \| { kind: `"instance"` } \| { kind: `"public"` } | yes |  |

## `human_discover`

Discover finite versioned operations and exact input/output contracts for the selected target.

Annotations: `destructiveHint: false`, `openWorldHint: false`, `readOnlyHint: true`.

| Property | Type | Required | Description |
|---|---|---|---|
| `target` | { kind: `"company"`, companyId: string (uuid) } \| { kind: `"self"` } \| { kind: `"instance"` } \| { kind: `"public"` } | yes |  |
| `pageId` | `"workforce"` \| `"inbox"` | no |  |
| `cursor` | string | no | Maximum length: 100. |
| `limit` | integer | no | Default: `100`. Minimum: 1. Maximum: 100. |

## `human_read`

Read a discovered operation with its original complete authorized content.

Annotations: `destructiveHint: false`, `openWorldHint: false`, `readOnlyHint: true`.

| Property | Type | Required | Description |
|---|---|---|---|
| `target` | { kind: `"company"`, companyId: string (uuid) } \| { kind: `"self"` } \| { kind: `"instance"` } \| { kind: `"public"` } | yes |  |
| `operationId` | `"workforce.templates.list"` \| `"workforce.brief.read"` \| `"workforce.brief.publish"` \| `"workforce.proposals.list"` \| `"workforce.proposals.review"` \| `"workforce.enrollment.read"` \| `"workforce.enrollment.create"` \| `"workforce.enrollment.update"` \| `"workforce.readiness.read"` \| `"workforce.learning.acknowledge"` \| `"workforce.skills.retry"` \| `"workforce.first_job.start"` \| `"human_questions.pending.list"` \| `"human_questions.read"` \| `"human_questions.respond"` \| `"human_questions.cancel"` \| `"human_questions.replace"` \| `"human_questions.recovery.list"` \| `"human_questions.recovery.cancel"` \| `"human_questions.owner.assign"` \| `"human_questions.stewardship.assign"` \| `"human_questions.stewardship.transfer"` \| `"task_recovery.exhausted.read"` \| `"task_recovery.remediate"` | yes |  |
| `version` | `1` | yes |  |
| `input` | map of any | yes |  |

## `human_prepare`

Prepare an exact mutation readback. No domain action occurs until the human consents and confirms.

Annotations: `destructiveHint: false`, `openWorldHint: false`, `readOnlyHint: false`.

| Property | Type | Required | Description |
|---|---|---|---|
| `target` | { kind: `"company"`, companyId: string (uuid) } \| { kind: `"self"` } \| { kind: `"instance"` } \| { kind: `"public"` } | yes |  |
| `operationId` | `"workforce.templates.list"` \| `"workforce.brief.read"` \| `"workforce.brief.publish"` \| `"workforce.proposals.list"` \| `"workforce.proposals.review"` \| `"workforce.enrollment.read"` \| `"workforce.enrollment.create"` \| `"workforce.enrollment.update"` \| `"workforce.readiness.read"` \| `"workforce.learning.acknowledge"` \| `"workforce.skills.retry"` \| `"workforce.first_job.start"` \| `"human_questions.pending.list"` \| `"human_questions.read"` \| `"human_questions.respond"` \| `"human_questions.cancel"` \| `"human_questions.replace"` \| `"human_questions.recovery.list"` \| `"human_questions.recovery.cancel"` \| `"human_questions.owner.assign"` \| `"human_questions.stewardship.assign"` \| `"human_questions.stewardship.transfer"` \| `"task_recovery.exhausted.read"` \| `"task_recovery.remediate"` | yes |  |
| `version` | `1` | yes |  |
| `input` | map of any | yes |  |

## `human_confirm`

Execute only after obtaining human consent to the prepared readback. personSaid is context, not proof. Never blindly retry recovery_required.

Annotations: `destructiveHint: true`, `openWorldHint: false`, `readOnlyHint: false`.

| Property | Type | Required | Description |
|---|---|---|---|
| `target` | { kind: `"company"`, companyId: string (uuid) } \| { kind: `"self"` } \| { kind: `"instance"` } \| { kind: `"public"` } | yes |  |
| `handle` | string | yes | Minimum length: 32. Maximum length: 128. |
| `personSaid` | string | no | Maximum length: 4000. |
