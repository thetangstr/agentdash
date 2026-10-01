---
title: Execution Workspaces and Runtime Services
summary: Where an issue's code lives, how isolated workspaces work, and how workspace services and jobs are started and stopped
---

A **project workspace** is a project's checkout. An **execution workspace** is where an issue's run actually works: the project checkout itself, or an isolated copy with its own branch. Either can define **services** (long-running commands, such as a dev server) and **jobs** (one-shot commands). Nothing starts them automatically.

Source: `packages/shared/src/types/workspace-runtime.ts`, `server/src/services/workspace-runtime.ts`, `server/src/routes/execution-workspaces.ts`, `server/src/routes/projects.ts`, `server/src/services/heartbeat.ts`, `ui/src/components/WorkspaceRuntimeControls.tsx`.

## Isolated workspaces are an experimental setting

Isolated workspaces are off by default. An instance admin turns them on under **Instance settings → Experimental → Enable Isolated Workspaces** (`enableIsolatedWorkspaces`).

While it is off, the workspace pickers are hidden, the **Workspaces** page redirects away, and issue workspace settings are ignored: every run works in the project's own checkout. Service and job controls still work.

## Services and jobs

Define them on the project workspace. That definition is the default every execution workspace in the project inherits. An execution workspace can override it with its own; turn inheritance back on to drop the override.

- **Services** stay running and are supervised. Actions: start, stop, restart. Each service also has a desired state: `running`, `stopped` or `manual`.
- **Jobs** run once and exit. Action: run.
- The raw JSON is still editable under **Advanced**.

Defining a service starts nothing.

## Who starts them

- **People**, from the project workspace page or the execution workspace page.
- **Agents**, with the MCP tools `control_issue_workspace_services` (start, stop, restart), `wait_for_issue_workspace_service` (polls until a service is up; 60-second default timeout) and `get_issue_workspace_runtime`. See the [agent toolset](/mcp/tools/agent).

AgentDash does **not** start configured services as part of a run. Before a run, configured services are stripped from the run's config; the run only records services the adapter itself reports.

On server start, AgentDash re-adopts service processes that are still alive and healthy, and marks the rest stopped. It does not restart stopped services.

The endpoints:

```
POST /api/projects/{projectId}/workspaces/{workspaceId}/runtime-services/{action}
POST /api/projects/{projectId}/workspaces/{workspaceId}/runtime-commands/{action}
POST /api/execution-workspaces/{workspaceId}/runtime-services/{action}
POST /api/execution-workspaces/{workspaceId}/runtime-commands/{action}
```

These are internal routes; see the [route index](/api/route-index).

## Issues and workspaces

With isolated workspaces on, each issue has a workspace preference:

| Value | Meaning |
| --- | --- |
| `inherit` | Use the project's default |
| `shared_workspace` | Work in the project's own checkout |
| `isolated_workspace` | Create an isolated workspace for this issue |
| `reuse_existing` | Reuse an existing execution workspace |
| `operator_branch` | Work on an operator's branch |
| `agent_default` | Let the agent's adapter decide |

A project's default mode is one of `shared_workspace`, `isolated_workspace`, `operator_branch` or `adapter_default`.

Several issues can share one execution workspace on purpose, so they work against the same branch and the same running services. Assigning or running an issue never starts or stops services.

Source: `packages/shared/src/validators/issue.ts`.

## What a run does with the workspace

1. AgentDash resolves the workspace for the run.
2. It creates or reuses the execution workspace — for example a git worktree.
3. It stores the workspace's paths, refs and provisioning settings.
4. It passes the workspace to the agent's run.

This is about where the code is and session continuity. It never starts services.

## Close a workspace

Execution workspaces last until someone closes them. **Close workspace** on the workspace page checks it is safe to close, stops its services, then cleans up. A failed cleanup leaves the workspace `cleanup_failed`, with **Retry close**.

Cleanup is conservative with shared checkouts. Closing a `shared_workspace` only unlinks its issues. Worktrees and branches are removed only if AgentDash created them, and a directory that contains the project checkout is never deleted.

Workspace statuses: `active`, `idle`, `in_review`, `archived`, `cleanup_failed`.
