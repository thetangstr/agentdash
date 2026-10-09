---
title: "Agent toolset"
summary: "The control-plane toolset: the default for stdio and the only one `POST /api/mcp` serves."
---

> Generated at commit `a73c9eb07` by `scripts/docs/generate-mcp-reference.mjs`.
> Verbatim except for one substitution, in 4 places: the name of a product profile that is not public is shown as `[private profile]`.
> Do not edit this page: run `pnpm docs:mcp-reference` instead. CI fails when it is stale.

**76 tools** — measured: the length of the `tools/list` response. Source: `buildToolSurface(client, config, "agent")` in `packages/mcp-server/src/index.ts`; the tools are defined in `src/tools.ts`, `src/journey.ts` and `src/harness.ts`, in that order.

Each tool's description is its inline string, verbatim. The input table is rendered from the JSON schema the server advertises in `tools/list` (`toolInputSchema` in `packages/mcp-server/src/schema.ts`, converted from the tool's zod schema). Nested objects are flattened: `a.b` is property `b` of object `a`, and `a[].b` is property `b` of each item of array `a`.

Tools, in the order `tools/list` returns them: `whoami`, `agentdashGetMyMemory`, `agentdashUpdateMyMemory`, `agentdashGetMyMandate`, `inbox_lite`, `list_agents`, `get_agent`, `update_agent`, `list_issues`, `get_issue`, `get_heartbeat_context`, `list_comments`, `get_comment`, `list_issue_approvals`, `attach_file`, `list_documents`, `get_document`, `list_document_revisions`, `list_projects`, `get_project`, `get_issue_workspace_runtime`, `control_issue_workspace_services`, `wait_for_issue_workspace_service`, `list_goals`, `get_goal`, `list_approvals`, `create_approval`, `mandated_attest`, `get_approval`, `get_approval_issues`, `list_approval_comments`, `create_issue`, `update_issue`, `checkout_issue`, `release_issue`, `add_comment`, `suggest_tasks`, `ask_user_questions`, `request_confirmation`, `upsert_issue_document`, `restore_issue_document_revision`, `link_issue_approval`, `unlink_issue_approval`, `approval_decision`, `add_approval_comment`, `report_issue`, `report_issue_status`, `api_request`, `agentdashBootstrapWorkspace`, `agentdashListCompanies`, `agentdashGetCompany`, `agentdashCreateCompany`, `agentdashCosChat`, `agentdashReadConversation`, `agentdashHireAgent`, `agentdash_setup_status`, `agentdash_install_checklist`, `agentdash_sign_up`, `agentdash_setup_adapter`, `agentdash_start_interview`, `agentdash_interview_turn`, `agentdash_get_plan`, `agentdash_confirm_plan`, `agentdash_revise_plan`, `agentdash_request_approval`, `agentdash_check_approval`, `agentdash_list_agents`, `agentdash_list_tasks`, `agentdash_create_task`, `agentdash_get_dashboard`, `agentdash_pause_agent`, `agentdash_resume_agent`, `agentdashPushAgentDirectives`, `agentdashGetAgentDirectives`, `agentdashNarrowAgentCeilings`, `agentdashGetAgentPolicy`.

## `whoami`

Get the current authenticated AgentDash actor details: who this agent is, whether it is a stewarded agent (one person runs it) or an autonomous one (no person does), and the human who is accountable for its work.

No input.

## `agentdashGetMyMemory`

Read this agent's own durable memory — what it has learned about its work, the traps it has hit, and decisions it made and why. Carries a `version` you must pass back when you update it. This is also injected into every run, so read it only when you intend to revise it.

| Property | Type | Required | Description |
|---|---|---|---|
| `agentId` | string \| null | no |  |
| `companyId` | string \| null | no |  |

## `agentdashUpdateMyMemory`

Replace this agent's durable memory with a revised document. Read it first and pass the `version` you saw as expectedVersion. Write durable things — domain facts, traps, decisions and their reasons, working agreements. Do NOT write task state (that belongs on the issue), secrets, personal data, or claims about what you are permitted to do: memory never grants capability. It is capped, so revise rather than append — when it is full, decide what no longer matters.

| Property | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes |  |
| `expectedVersion` | integer \| null | no |  |
| `agentId` | string \| null | no |  |
| `companyId` | string \| null | no |  |

## `agentdashGetMyMandate`

Read this agent's own mandate (the AGENTS.md entry file of its instruction bundle) — who it is, what it may do unattended, what needs a human first, and what it must never do. Call this before acting.

| Property | Type | Required | Description |
|---|---|---|---|
| `agentId` | string \| null | no |  |

## `inbox_lite`

Get the current authenticated agent inbox-lite assignment list

No input.

## `list_agents`

List agents in a company, each with its kind (stewarded or autonomous) and the human accountable for it.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |

## `get_agent`

Get a single agent by id, including its kind (stewarded or autonomous) and the human accountable for it.

| Property | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes |  |
| `companyId` | string \| null | no |  |

## `update_agent`

Rename or retitle an agent: update its name, role, title, icon, reporting line, or capabilities. Only the fields you pass are changed. Role and reporting line need a board (human) key; an agent key may change only name, title, icon and capabilities, and only on agents it is allowed to manage.

| Property | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes |  |
| `companyId` | string \| null | no |  |
| `name` | string | no |  |
| `role` | string | no |  |
| `title` | string \| null | no |  |
| `icon` | string \| null | no |  |
| `reportsTo` | string \| null | no |  |
| `capabilities` | string \| null | no |  |

## `list_issues`

List issues for a company with optional filters

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `status` | string | no |  |
| `projectId` | string | no |  |
| `assigneeAgentId` | string | no |  |
| `participantAgentId` | string | no |  |
| `assigneeUserId` | string | no |  |
| `touchedByUserId` | string | no |  |
| `inboxArchivedByUserId` | string | no |  |
| `unreadForUserId` | string | no |  |
| `labelId` | string | no |  |
| `executionWorkspaceId` | string | no |  |
| `originKind` | string | no |  |
| `originId` | string | no |  |
| `includeRoutineExecutions` | boolean | no |  |
| `q` | string | no |  |

## `get_issue`

Get a single issue by UUID or identifier

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |

## `get_heartbeat_context`

Get compact heartbeat context for an issue

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `wakeCommentId` | string | no |  |

## `list_comments`

List issue comments with incremental options

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `after` | string | no |  |
| `order` | `"asc"` \| `"desc"` | no |  |
| `limit` | integer | no | Maximum: 500. Exclusive minimum: 0. |

## `get_comment`

Get a specific issue comment by id

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `commentId` | string | yes |  |

## `list_issue_approvals`

List approvals linked to an issue

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |

## `attach_file`

Attach a file you created in your workspace to an issue, and get back a URL a person can open. Use this whenever you refer to a file you wrote — a report, a spreadsheet, a diagram, an export. Put the returned url in your reply INSTEAD of the local path: the human reading you is on another machine, where your path does not exist. The path you pass is relative to your own workspace (e.g. "reports/q3.md"), never an absolute path.

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `path` | string | yes | Path to the file, relative to your workspace directory. Not absolute. |
| `filename` | string | no | Name to show the human. Defaults to the file's own name. |

## `list_documents`

List issue documents

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |

## `get_document`

Get one issue document by key

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `key` | string | yes |  |

## `list_document_revisions`

List revisions for an issue document

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `key` | string | yes |  |

## `list_projects`

List projects in a company

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |

## `get_project`

Get a project by id or company-scoped short reference

| Property | Type | Required | Description |
|---|---|---|---|
| `projectId` | string | yes |  |
| `companyId` | string \| null | no |  |

## `get_issue_workspace_runtime`

Get the current execution workspace and runtime services for an issue, including service URLs

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |

## `control_issue_workspace_services`

Start, stop, or restart the current issue execution workspace runtime services

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `action` | `"start"` \| `"stop"` \| `"restart"` | yes |  |
| `workspaceCommandId` | string \| null | no |  |
| `runtimeServiceId` | string \| null | no |  |
| `serviceIndex` | integer \| null | no |  |

## `wait_for_issue_workspace_service`

Wait until an issue execution workspace runtime service is running and has a URL when one is exposed

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `runtimeServiceId` | string \| null | no |  |
| `serviceName` | string \| null | no |  |
| `timeoutSeconds` | integer | no | Maximum: 300. Exclusive minimum: 0. |

## `list_goals`

List goals in a company

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |

## `get_goal`

Get a goal by id

| Property | Type | Required | Description |
|---|---|---|---|
| `goalId` | string | yes |  |

## `list_approvals`

List approvals in a company

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `status` | string | no |  |

## `create_approval`

Create a board approval request, optionally linked to one or more issues. A connector_send must name a provider with an executor (today only "hubspot", with objectType, operation and properties); one with no provider or naming Teams is refused with 422. There is no Teams send: to reach a person, comment on the issue and set it blocked, or open a request_board_approval.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `type` | `"hire_agent"` \| `"approve_ceo_strategy"` \| `"budget_override_required"` \| `"request_board_approval"` \| `"mandate_violation"` \| `"connector_send"` \| `"inbound_content_review"` \| `"deliverable_review"` \| `"workflow_recommendation"` | yes |  |
| `requestedByAgentId` | string \| null | no |  |
| `payload` | map of any | yes |  |
| `issueIds` | array of string | no |  |

## `mandated_attest`

Perform a mandated action: verify the agent's mandate (in-scope, under-cap, unexpired), KYA the counterparty (valid-at-T), then attest the action. Returns { authorized, reason?, receipt? }. Denied when out-of-scope/over-cap/expired or the counterparty can't be verified.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `granteeAgentId` | string | no |  |
| `mandateId` | string | yes |  |
| `counterpartyDid` | string | yes |  |
| `action` | string | yes |  |
| `payload` | map of any | no |  |

## `get_approval`

Get an approval by id

| Property | Type | Required | Description |
|---|---|---|---|
| `approvalId` | string | yes |  |

## `get_approval_issues`

List issues linked to an approval

| Property | Type | Required | Description |
|---|---|---|---|
| `approvalId` | string | yes |  |

## `list_approval_comments`

List comments for an approval

| Property | Type | Required | Description |
|---|---|---|---|
| `approvalId` | string | yes |  |

## `create_issue`

Create a new issue. Assigning a person (assigneeUserId) who stewards an agent gives the issue to that agent, whoever assigns it (list_agents → steward.userId); assignToPerson: true keeps it with the person.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `projectId` | string \| null | no |  |
| `projectWorkspaceId` | string \| null | no |  |
| `goalId` | string \| null | no |  |
| `parentId` | string \| null | no |  |
| `blockedByIssueIds` | array of string | no |  |
| `inheritExecutionWorkspaceFromIssueId` | string \| null | no |  |
| `title` | string | yes |  |
| `description` | string \| null | no |  |
| `status` | `"backlog"` \| `"todo"` \| `"in_progress"` \| `"in_review"` \| `"done"` \| `"blocked"` \| `"cancelled"` | no |  |
| `priority` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | no | Default: `"medium"`. |
| `assigneeAgentId` | string \| null | no |  |
| `assigneeUserId` | string \| null | no |  |
| `assignToPerson` | boolean | no |  |
| `originKind` | string (1 value omitted: engagement-specific) | no |  |
| `originId` | string \| null | no |  |
| `requestDepth` | integer | no | Default: `0`. Minimum: 0. |
| `requestId` | string | no |  |
| `billingCode` | string \| null | no |  |
| `definitionOfDone` | object \| null | no |  |
| `definitionOfDone.summary` | string | yes |  |
| `definitionOfDone.criteria` | array of object | yes |  |
| `definitionOfDone.criteria[].id` | string | yes |  |
| `definitionOfDone.criteria[].text` | string | yes |  |
| `definitionOfDone.criteria[].done` | boolean | yes |  |
| `definitionOfDone.goalMetricLink` | string | no |  |
| `assigneeAdapterOverrides` | object \| null | no |  |
| `assigneeAdapterOverrides.modelProfile` | `"cheap"` | no |  |
| `assigneeAdapterOverrides.adapterConfig` | map of any | no |  |
| `assigneeAdapterOverrides.useProjectWorkspace` | boolean | no |  |
| `executionPolicy` | object \| null | no |  |
| `executionPolicy.mode` | `"normal"` \| `"auto"` | no | Default: `"normal"`. |
| `executionPolicy.commentRequired` | boolean | no | Default: `true`. |
| `executionPolicy.stages` | array of object | no | Default: `[]`. |
| `executionPolicy.stages[].id` | string | no |  |
| `executionPolicy.stages[].type` | `"review"` \| `"approval"` | yes |  |
| `executionPolicy.stages[].approvalsNeeded` | `1` | no | Default: `1`. |
| `executionPolicy.stages[].participants` | array of object | no | Default: `[]`. |
| `executionPolicy.stages[].participants[].type` | `"agent"` \| `"user"` | yes |  |
| `executionPolicy.stages[].participants[].agentId` | string \| null | no |  |
| `executionPolicy.stages[].participants[].userId` | string \| null | no |  |
| `executionPolicy.stages[].participants[].id` | string | no |  |
| `executionWorkspaceId` | string \| null | no |  |
| `executionWorkspacePreference` | `"inherit"` \| `"shared_workspace"` \| `"isolated_workspace"` \| `"operator_branch"` \| `"reuse_existing"` \| `"agent_default"` \| null | no |  |
| `executionWorkspaceSettings` | object \| null | no |  |
| `executionWorkspaceSettings.mode` | `"inherit"` \| `"shared_workspace"` \| `"isolated_workspace"` \| `"operator_branch"` \| `"reuse_existing"` \| `"agent_default"` | no |  |
| `executionWorkspaceSettings.environmentId` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy` | object \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy.type` | `"project_primary"` \| `"git_worktree"` \| `"adapter_managed"` \| `"cloud_sandbox"` | no |  |
| `executionWorkspaceSettings.workspaceStrategy.baseRef` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy.branchTemplate` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy.worktreeParentDir` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy.provisionCommand` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy.teardownCommand` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceRuntime` | map of any \| null | no |  |
| `labelIds` | array of string | no |  |

## `update_issue`

Patch an issue, optionally including a comment; include resume=true when intentionally requesting follow-up on resumable closed work. Assigning a person who stewards an agent gives the issue to that agent unless assignToPerson is true. Work assigned to your steward comes to you: take the first pass, ask before completing unless your mandate lets you finish it (comment your recommendation, set blocked), and assign it to your steward (assigneeAgentId null, assigneeUserId = steward) only when they must do the work themselves. That hand-back stays with them, as does returning your issue to the person who created it.

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `projectId` | string \| null | no |  |
| `projectWorkspaceId` | string \| null | no |  |
| `goalId` | string \| null | no |  |
| `parentId` | string \| null | no |  |
| `blockedByIssueIds` | array of string | no |  |
| `inheritExecutionWorkspaceFromIssueId` | string \| null | no |  |
| `title` | string | no |  |
| `description` | string \| null | no |  |
| `status` | `"backlog"` \| `"todo"` \| `"in_progress"` \| `"in_review"` \| `"done"` \| `"blocked"` \| `"cancelled"` | no |  |
| `priority` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | no | Default: `"medium"`. |
| `assigneeAgentId` | string \| null | no |  |
| `assigneeUserId` | string \| null | no |  |
| `assignToPerson` | boolean | no |  |
| `requestDepth` | integer | no | Minimum: 0. |
| `requestId` | any | no |  |
| `billingCode` | string \| null | no |  |
| `assigneeAdapterOverrides` | object \| null | no |  |
| `assigneeAdapterOverrides.modelProfile` | `"cheap"` | no |  |
| `assigneeAdapterOverrides.adapterConfig` | map of any | no |  |
| `assigneeAdapterOverrides.useProjectWorkspace` | boolean | no |  |
| `executionPolicy` | object \| null | no |  |
| `executionPolicy.mode` | `"normal"` \| `"auto"` | no | Default: `"normal"`. |
| `executionPolicy.commentRequired` | boolean | no | Default: `true`. |
| `executionPolicy.stages` | array of object | no | Default: `[]`. |
| `executionPolicy.stages[].id` | string | no |  |
| `executionPolicy.stages[].type` | `"review"` \| `"approval"` | yes |  |
| `executionPolicy.stages[].approvalsNeeded` | `1` | no | Default: `1`. |
| `executionPolicy.stages[].participants` | array of object | no | Default: `[]`. |
| `executionPolicy.stages[].participants[].type` | `"agent"` \| `"user"` | yes |  |
| `executionPolicy.stages[].participants[].agentId` | string \| null | no |  |
| `executionPolicy.stages[].participants[].userId` | string \| null | no |  |
| `executionPolicy.stages[].participants[].id` | string | no |  |
| `executionWorkspaceId` | string \| null | no |  |
| `executionWorkspacePreference` | `"inherit"` \| `"shared_workspace"` \| `"isolated_workspace"` \| `"operator_branch"` \| `"reuse_existing"` \| `"agent_default"` \| null | no |  |
| `executionWorkspaceSettings` | object \| null | no |  |
| `executionWorkspaceSettings.mode` | `"inherit"` \| `"shared_workspace"` \| `"isolated_workspace"` \| `"operator_branch"` \| `"reuse_existing"` \| `"agent_default"` | no |  |
| `executionWorkspaceSettings.environmentId` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy` | object \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy.type` | `"project_primary"` \| `"git_worktree"` \| `"adapter_managed"` \| `"cloud_sandbox"` | no |  |
| `executionWorkspaceSettings.workspaceStrategy.baseRef` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy.branchTemplate` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy.worktreeParentDir` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy.provisionCommand` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceStrategy.teardownCommand` | string \| null | no |  |
| `executionWorkspaceSettings.workspaceRuntime` | map of any \| null | no |  |
| `labelIds` | array of string | no |  |
| `definitionOfDone` | any | no |  |
| `comment` | any | no |  |
| `reviewRequest` | object \| null | no |  |
| `reviewRequest.instructions` | string | yes |  |
| `reopen` | boolean | no |  |
| `resume` | boolean | no |  |
| `interrupt` | boolean | no |  |
| `hiddenAt` | string \| null | no |  |

## `checkout_issue`

Checkout an issue for an agent

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `agentId` | string \| null | no |  |
| `expectedStatuses` | array of `"backlog"` \| `"todo"` \| `"in_progress"` \| `"in_review"` \| `"done"` \| `"blocked"` \| `"cancelled"` | no |  |

## `release_issue`

Release an issue checkout

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |

## `add_comment`

Add a comment to an issue; include resume=true when intentionally requesting follow-up on resumable closed work

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `body` | any | yes |  |
| `reopen` | boolean | no |  |
| `resume` | boolean | no |  |
| `interrupt` | boolean | no |  |

## `suggest_tasks`

Create a suggest_tasks interaction on an issue. A task assigned to a person who stewards an agent is drafted to that agent (list_agents → steward.userId) unless the task sets assignToPerson: true.

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `idempotencyKey` | string \| null | no |  |
| `sourceCommentId` | string \| null | no |  |
| `sourceRunId` | string \| null | no |  |
| `title` | string \| null | no |  |
| `summary` | string \| null | no |  |
| `continuationPolicy` | `"none"` \| `"wake_assignee"` \| `"wake_assignee_on_accept"` | no | Default: `"wake_assignee"`. |
| `payload` | object | yes |  |
| `payload.version` | `1` | yes |  |
| `payload.defaultParentId` | string \| null | no |  |
| `payload.tasks` | array of object | yes |  |
| `payload.tasks[].clientKey` | string | yes |  |
| `payload.tasks[].parentClientKey` | string \| null | no |  |
| `payload.tasks[].parentId` | string \| null | no |  |
| `payload.tasks[].title` | string | yes |  |
| `payload.tasks[].description` | any \| null | no |  |
| `payload.tasks[].priority` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` \| null | no |  |
| `payload.tasks[].assigneeAgentId` | string \| null | no |  |
| `payload.tasks[].assigneeUserId` | string \| null | no |  |
| `payload.tasks[].assignToPerson` | boolean | no |  |
| `payload.tasks[].routedFromStewardUserId` | string | no |  |
| `payload.tasks[].projectId` | string \| null | no |  |
| `payload.tasks[].goalId` | string \| null | no |  |
| `payload.tasks[].billingCode` | string \| null | no |  |
| `payload.tasks[].labels` | array of string | no |  |
| `payload.tasks[].hiddenInPreview` | boolean | no |  |

## `ask_user_questions`

Ask focused human questions on an issue. Use selectionMode text with empty options for free text; companyFactKey only for known workforce facts. A workforce question is delivered to the named accountable human. Stop dependent work immediately after asking; arbitrary comments and wake metadata do not answer it.

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `idempotencyKey` | string \| null | no |  |
| `sourceCommentId` | string \| null | no |  |
| `sourceRunId` | string \| null | no |  |
| `title` | string \| null | no |  |
| `summary` | string \| null | no |  |
| `continuationPolicy` | `"none"` \| `"wake_assignee"` \| `"wake_assignee_on_accept"` | no | Default: `"wake_assignee"`. |
| `payload` | object | yes |  |
| `payload.version` | `1` | yes |  |
| `payload.answerOwnerUserId` | string | no |  |
| `payload.workforceAgentId` | string | no |  |
| `payload.workforceEnrollmentId` | string | no |  |
| `payload.workforceTemplateId` | string | no |  |
| `payload.workforceTemplateVersion` | `1` | no |  |
| `payload.replacesInteractionId` | string | no |  |
| `payload.title` | string \| null | no |  |
| `payload.submitLabel` | string \| null | no |  |
| `payload.questions` | array of object | yes |  |
| `payload.questions[].id` | string | yes |  |
| `payload.questions[].prompt` | string | yes |  |
| `payload.questions[].helpText` | string \| null | no |  |
| `payload.questions[].selectionMode` | `"single"` \| `"multi"` \| `"text"` | yes |  |
| `payload.questions[].companyFactKey` | string | no |  |
| `payload.questions[].required` | boolean | no |  |
| `payload.questions[].options` | array of object | yes |  |
| `payload.questions[].options[].id` | string | yes |  |
| `payload.questions[].options[].label` | string | yes |  |
| `payload.questions[].options[].description` | string \| null | no |  |

## `request_confirmation`

Create a request_confirmation interaction on an issue

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `idempotencyKey` | string \| null | no |  |
| `sourceCommentId` | string \| null | no |  |
| `sourceRunId` | string \| null | no |  |
| `title` | string \| null | no |  |
| `summary` | string \| null | no |  |
| `continuationPolicy` | `"none"` \| `"wake_assignee"` \| `"wake_assignee_on_accept"` | no | Default: `"none"`. |
| `payload` | object | yes |  |
| `payload.version` | `1` | yes |  |
| `payload.prompt` | string | yes |  |
| `payload.acceptLabel` | string \| null | no |  |
| `payload.rejectLabel` | string \| null | no |  |
| `payload.rejectRequiresReason` | boolean | no |  |
| `payload.rejectReasonLabel` | string \| null | no |  |
| `payload.allowDeclineReason` | boolean | no | Default: `true`. |
| `payload.declineReasonPlaceholder` | string \| null | no |  |
| `payload.detailsMarkdown` | string \| null | no |  |
| `payload.supersedeOnUserComment` | boolean | no |  |
| `payload.target` | { label?: string \| null, href?: string \| null, type: `"issue_document"`, issueId?: string \| null, documentId?: string \| null, key: string, revisionId: string, revisionNumber?: integer \| null } \| { label?: string \| null, href?: string \| null, type: `"custom"`, key: string, revisionId?: string \| null, revisionNumber?: integer \| null } \| null | no |  |

## `upsert_issue_document`

Create or update an issue document

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `key` | string | yes |  |
| `title` | string \| null | no |  |
| `format` | `"markdown"` | no | Default: `"markdown"`. |
| `body` | string | yes |  |
| `changeSummary` | string \| null | no |  |
| `baseRevisionId` | string \| null | no |  |

## `restore_issue_document_revision`

Restore a prior revision of an issue document

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `key` | string | yes |  |
| `revisionId` | string | yes |  |

## `link_issue_approval`

Link an approval to an issue

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `approvalId` | string | yes |  |

## `unlink_issue_approval`

Unlink an approval from an issue

| Property | Type | Required | Description |
|---|---|---|---|
| `issueId` | string | yes |  |
| `approvalId` | string | yes |  |

## `approval_decision`

Approve, reject, request revision, or resubmit an approval

| Property | Type | Required | Description |
|---|---|---|---|
| `approvalId` | string | yes |  |
| `action` | `"approve"` \| `"reject"` \| `"requestRevision"` \| `"resubmit"` | yes |  |
| `decisionNote` | string | no |  |
| `payloadJson` | string | no |  |

## `add_approval_comment`

Add a comment to an approval

| Property | Type | Required | Description |
|---|---|---|---|
| `approvalId` | string | yes |  |
| `body` | string | yes |  |

## `report_issue`

File a bug report or feature request as a GitHub issue on the AgentDash team's queue. Use this when the user says something like 'file a bug' or 'report this', or when you hit a defect worth recording. Include what you were doing, what you expected, what happened, and the exact error — you have that context and the user should not have to retype it.

| Property | Type | Required | Description |
|---|---|---|---|
| `kind` | `"bug"` \| `"feature"` | yes | bug for something broken, feature for something missing |
| `title` | string | yes | One line naming the specific failure, not the area it is in |
| `description` | string | yes | What you were doing, what you expected, what happened instead, and the verbatim error or response. Markdown is fine. |
| `companyId` | string \| null | no |  |

## `report_issue_status`

Check whether issue reporting is configured on this instance, and which GitHub repo reports land in. Call this before telling a user their bug was filed somewhere.

No input.

## `api_request`

Make a JSON request to an existing AgentDash /api endpoint for unsupported operations

| Property | Type | Required | Description |
|---|---|---|---|
| `method` | `"GET"` \| `"POST"` \| `"PUT"` \| `"PATCH"` \| `"DELETE"` | yes |  |
| `path` | string | yes |  |
| `jsonBody` | string | no |  |

## `agentdashBootstrapWorkspace`

AgentDash: provision a workspace for the authenticated user — creates the company, a Chief of Staff agent, and the opening conversation. The lowest-friction way to start onboarding. Pass companyId when the user belongs to more than one company — the server refuses to guess (409) and lists the candidates.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no | Company to bootstrap in. Required when the user holds active memberships in more than one company; omit when they belong to exactly one or none. |

## `agentdashListCompanies`

AgentDash: list the companies (workspaces) the authenticated actor can access

No input.

## `agentdashGetCompany`

AgentDash: get a company (workspace) by id

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |

## `agentdashCreateCompany`

AgentDash: explicitly create a new company (workspace). For full onboarding prefer agentdashBootstrapWorkspace, which also provisions a Chief of Staff.

| Property | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes |  |
| `description` | string \| null | no |  |
| `productProfile` | `"default"` (1 value omitted) | no |  |
| `inviteCode` | string | no |  |
| `budgetMonthlyCents` | integer | no | Default: `0`. Minimum: 0. |
| `attachmentMaxBytes` | integer | no | Minimum: 1. Maximum: 1073741824. |

## `agentdashCosChat`

AgentDash: send a message to a company's Chief of Staff (drives the onboarding interview). The CoS reply is generated asynchronously — call agentdashReadConversation shortly after to read it. Returns the posted message, including its conversationId.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `message` | string | yes |  |

## `agentdashReadConversation`

AgentDash: read recent messages in a conversation (e.g. to fetch the Chief of Staff's reply after agentdashCosChat)

| Property | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | yes |  |
| `limit` | integer | no | Maximum: 200. Exclusive minimum: 0. |

## `agentdashHireAgent`

AgentDash: hire an agent into a company (e.g. agents the Chief of Staff proposes during onboarding). adapterType selects the runtime (e.g. claude_code, hermes_local).

| Property | Type | Required | Description |
|---|---|---|---|
| `workforceTemplateId` | `"marketing-content"` \| `"sales-support"` | no |  |
| `companyId` | string \| null | no |  |
| `name` | string | yes |  |
| `adapterType` | string | yes |  |
| `role` | string | no |  |
| `title` | string \| null | no |  |
| `capabilities` | string \| null | no |  |
| `desiredSkills` | array of string | no |  |
| `budgetMonthlyCents` | integer | no | Minimum: 0. |

## `agentdash_setup_status`

THE SELF-DRIVING ANCHOR. Aggregates server health, agents, dashboard, and pending approvals into a machine-readable status with a deterministic nextAction. Call this first, do the nextAction, verify, and call it again — repeat until the workspace is provisioned and operating.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |

## `agentdash_install_checklist`

Returns machine-readable install steps for AgentDash on a fresh Mac mini. This tool NEVER executes anything. The steps run in the calling agent's shell with the human's consent — run them one at a time and verify each before the next.

No input.

## `agentdash_sign_up`

Founding-user signup for a FRESH authenticated-mode install — works ONLY while the instance has zero users (bootstrapStatus "bootstrap_pending"). No password needed: collect the human's email and name in conversation (NEVER invent an email), and the server creates the founding user, returns a board API key, and this session continues authenticated immediately. Persist the key so future sessions stay signed in. The response also returns a one-time passwordSetupUrl — hand that link to the human so they can set a browser password and open the web UI (no email needed).

| Property | Type | Required | Description |
|---|---|---|---|
| `email` | string | yes |  |
| `name` | string | yes |  |
| `inviteCode` | string | no | AgentDash invite code. Most installs require one — ask the human for it (NEVER invent or guess a code). If signup answers invite_code_required, collect the code and retry. |

## `agentdash_setup_adapter`

Configure the model adapter your agents will run on — a required onboarding step before the interview can produce a real team plan. Offer the human the choices from the preset menu (Claude / OpenAI / Gemini — each needs an API key — or 'stub' for a no-key placeholder that produces canned plans). Ask the human which provider and collect the key in conversation (NEVER invent a key). After applying, re-check agentdash_setup_status to confirm adapterReady before continuing the interview.

| Property | Type | Required | Description |
|---|---|---|---|
| `preset` | `"claude"` \| `"openai"` \| `"gemini"` \| `"stub"` | yes | claude=ANTHROPIC_API_KEY; openai=OPENAI_COMPAT_API_KEY (api.openai.com); gemini=OPENAI_COMPAT_API_KEY (Gemini OpenAI-compat); stub=no key, canned plans. |
| `apiKey` | string | no | The provider API key. Required for claude/openai/gemini. Omit for stub. Collected from the human — NEVER invented. |

## `agentdash_start_interview`

Bootstrap the AgentDash workspace: creates the company, the Chief of Staff agent, and the onboarding conversation, then enforces the boundary default that new agent hires require board approval. Returns {companyId, conversationId, cosAgentId, boundaries}. Follow with agentdash_interview_turn to run the intent-capture interview. Pass companyId when the user belongs to more than one company — the server refuses to guess (409) and lists the candidates.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no | Company to bootstrap in. Required when the user holds active memberships in more than one company; omit when they belong to exactly one or none. |

## `agentdash_interview_turn`

Submit one round of the onboarding interview: passes the user's answer to the Chief of Staff and returns the next question (or the completed state). Repeat until a team plan is proposed, then use agentdash_get_plan.

| Property | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | yes |  |
| `userMessage` | string | yes |  |
| `cosAgentId` | string \| null | no |  |
| `companyId` | string \| null | no |  |

## `agentdash_get_plan`

Fetch the latest proposed agent-team plan (the newest agent_plan_proposal_v1 card in the onboarding conversation). Present the plan to the human before confirming.

| Property | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | yes |  |

## `agentdash_confirm_plan`

Confirm and materialize the proposed agent team from the latest plan card. Creates one agent per plan entry. Only call this after the human has approved the plan. Hires beyond this confirmed plan are gated — use agentdash_request_approval for those.

| Property | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | yes |  |

## `agentdash_revise_plan`

Request revisions to the proposed agent-team plan. Pass the human's feedback; the Chief of Staff rewrites the plan as a delta and posts a new plan card.

| Property | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | yes |  |
| `revisionText` | string | yes |  |

## `agentdash_request_approval`

Request human approval for a gated action (hiring beyond the plan, deletions, budget changes, pausing/resuming the fleet, anything outside the confirmed goals). Creates a request_board_approval that the human decides at the approveUrl in the AgentDash UI. Returns {approvalId, status, approveUrl}. Poll agentdash_check_approval and do NOT proceed until it returns approved.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `summary` | string | yes |  |
| `proposedAction` | string | yes |  |
| `details` | string | no |  |
| `issueIds` | array of string | no |  |

## `agentdash_check_approval`

Check the status of an approval request. Poll this after agentdash_request_approval and DO NOT proceed with the gated action until status === "approved". If status is "rejected" or "revision_requested", read the comments (list_approval_comments) and either revise the request or drop the action. Never fabricate approval status.

| Property | Type | Required | Description |
|---|---|---|---|
| `approvalId` | string | yes |  |

## `agentdash_list_agents`

List all agents in the workspace with their current status (read-only, always allowed).

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |

## `agentdash_list_tasks`

List tasks/issues in the workspace, optionally filtered by status (read-only, always allowed).

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `status` | `"backlog"` \| `"todo"` \| `"in_progress"` \| `"in_review"` \| `"done"` \| `"blocked"` \| `"cancelled"` | no |  |

## `agentdash_create_task`

Create a new task/issue in the workspace and optionally assign it to an agent. Creating tasks within the confirmed goals is always allowed — it is also the fallback when an approval stays pending: create a task for the human instead of proceeding.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `title` | string | yes |  |
| `description` | string | no |  |
| `priority` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | no | Default: `"medium"`. |
| `assigneeAgentId` | string \| null | no |  |

## `agentdash_get_dashboard`

Get the company dashboard summary: agent counts, task counts, spend, pending approvals (read-only, always allowed).

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |

## `agentdash_pause_agent`

Pause one agent so it stops picking up new work. GATED when applied to ALL agents: pausing the whole fleet requires agentdash_request_approval first — wait for approved.

| Property | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes |  |

## `agentdash_resume_agent`

Resume a paused agent. GATED: resuming an agent a human paused, or resuming the whole fleet, requires agentdash_request_approval first — wait until agentdash_check_approval returns approved before calling this.

| Property | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes |  |

## `agentdashPushAgentDirectives`

[private profile]: push free-text operating directives to the AgentDash agent you steward — its standing instructions, voice, and explicit don'ts. Append-only and versioned: this supersedes the previous version and keeps it readable. Directives shape HOW the agent works and CANNOT grant it capability; use agentdashNarrowAgentCeilings for what it may touch.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `agentId` | string \| null | no |  |
| `directives` | string | yes |  |

## `agentdashGetAgentDirectives`

[private profile]: read the directives currently in force for your paired agent plus every superseded version, each with the principal who pushed it and when.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `agentId` | string \| null | no |  |

## `agentdashNarrowAgentCeilings`

[private profile]: set the structured ceilings (providers, dataScopes, permissions, budget, destructive actions, minimum approval) for the agent you steward. NARROWING ONLY — anything broader than the owner's ceiling is clamped down to it and reported in `clamped`, not accepted and not rejected. Send the full policy; omitted dimensions are not merged.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `agentId` | string \| null | no |  |
| `permissions` | array of string | yes |  |
| `monthlyBudgetCents` | integer | yes | Minimum: 0. |
| `destructiveActions` | `"blocked"` \| `"approval_required"` \| `"allowed"` | yes |  |
| `dataScopes` | array of string | yes |  |
| `providers` | array of string | yes |  |
| `minimumApproval` | `"none"` \| `"steward"` | yes |  |
| `revision` | integer | no | Exclusive minimum: 0. |

## `agentdashGetAgentPolicy`

[private profile]: read what actually applies to your paired agent — the owner ceiling, your steward request, and the effective policy that is their intersection. Start here when the agent says it cannot do something: the effective policy, not your request, is what the runtime enforces.

| Property | Type | Required | Description |
|---|---|---|---|
| `companyId` | string \| null | no |  |
| `agentId` | string \| null | no |  |
