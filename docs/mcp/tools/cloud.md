---
title: "Cloud toolset"
summary: "The tools an agent uses to get a person an AgentDash cloud workspace and then onto it: signup, status, and the person's approval on the box."
---

> Generated at commit `ee2b64710` by `scripts/docs/generate-mcp-reference.mjs`.
> Do not edit this page: run `pnpm docs:mcp-reference` instead. CI fails when it is stale.

**4 tools** — measured: the length of the `tools/list` response. Source: `buildToolSurface(client, config, "cloud")` in `packages/mcp-server/src/index.ts`; the tools are defined in `src/cloud.ts`. The same definitions serve stdio (`AGENTDASH_TOOLSET=cloud`, calling `POST /api/cloud/agent/<op>`) and the hosted endpoint `POST /api/cloud/mcp` (`cloud/src/routes/agent.ts`).

Each tool's description is its inline string, verbatim. The input table is rendered from the JSON schema the server advertises in `tools/list` (`toolInputSchema` in `packages/mcp-server/src/schema.ts`, converted from the tool's zod schema). Nested objects are flattened: `a.b` is property `b` of object `a`, and `a[].b` is property `b` of each item of array `a`.

Tools, in the order `tools/list` returns them: `agentdash_cloud_check_name`, `agentdash_cloud_start`, `agentdash_cloud_status`, `agentdash_cloud_connect`.

## `agentdash_cloud_check_name`

Check whether a workspace name (slug) is free for a new AgentDash cloud workspace at https://<slug>.agentdash.cloud. Read-only. Answers {available} or {available: false, reason, message}.

Annotations: `readOnlyHint: true`.

| Property | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The workspace name: becomes https://<slug>.agentdash.cloud. 3 to 16 lowercase letters, digits or dashes, starting with a letter. |

## `agentdash_cloud_start`

Start the normal self-serve signup for a new AgentDash cloud workspace on the PERSON's behalf. Collect their email in conversation (NEVER invent one) and a workspace name, and ask them to read and accept the terms (https://www.agentdash.cloud/terms) before you call this. The PERSON receives the verification email and must click it themselves; you never see that link. Returns an opaque handle (once — store it privately; it expires after 7 days) and plain next steps. Without a valid admission code the workspace waits for approval after verification (the waitlist); with one, it is approved once the email is verified. Then poll agentdash_cloud_status.

| Property | Type | Required | Description |
|---|---|---|---|
| `email` | string | yes | The person's own email address. They receive the verification link there. |
| `slug` | string | yes | The workspace name: becomes https://<slug>.agentdash.cloud. 3 to 16 lowercase letters, digits or dashes, starting with a letter. |
| `workspaceName` | string | no | Display name; defaults to the slug. |
| `admissionCode` | string | no | An AgentDash hosted admission code (AGD-HOST-…) the person was given. Ask for it; NEVER invent or guess one. |
| `acceptTerms` | `true` | yes | true only after the person has read and accepted the terms at https://www.agentdash.cloud/terms. |

## `agentdash_cloud_status`

Where the signup behind a handle stands. Read-only. state is one of: email_pending (the person has not clicked the verification email yet), waitlisted (verified, waiting for approval or capacity), provisioning (with step), awaiting_claim (ready: the person opens the claim link in THEIR email and sets a password — you never get that link), active (claimed: call agentdash_cloud_connect), or failed (with reason). Each answer carries nextSteps in plain words. Poll every 15 to 30 seconds while provisioning; less often while waiting on the person.

Annotations: `readOnlyHint: true`.

| Property | Type | Required | Description |
|---|---|---|---|
| `handle` | string | yes | The handle agentdash_cloud_start returned. Keep it private, like a password; it expires after 7 days. |

## `agentdash_cloud_connect`

Once the workspace is claimed (status active), ask the person to let you onto it. The first call returns an approvalUrl on their workspace and a confirmationCode: give both to the person, who signs in there, checks the page shows the same code, and clicks Approve. Call again after they approve: the workspace credential is delivered to you exactly once. Over stdio this session then switches to the workspace in place — continue with agentdash_setup_status (interview → plan → hire), no reconfiguring; over the hosted endpoint, store the credential as a secret. restart: true replaces a pending request whose link was lost or expired, or one the person declined.

| Property | Type | Required | Description |
|---|---|---|---|
| `handle` | string | yes | The handle agentdash_cloud_start returned. Keep it private, like a password; it expires after 7 days. |
| `restart` | boolean | no | Cancel a pending approval request and make a new one. |
