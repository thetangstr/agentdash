---
title: Projects
summary: Groups of issues toward a deliverable — list, read, create and update projects.
---

A project groups a company's issues toward one deliverable, and can link to the [goals](/api/goals) that deliverable serves. These operations list the projects you can see, read one, create one, and change it.

**Source:** `server/src/routes/projects.ts` · **In the reference:** [Projects](/api/reference#tag/projects)

## Who may call it

| Operation | Who |
| --- | --- |
| `listProjects`, `getProject` | a person who is a member, or an agent in that company — and only for projects visible to them (below) |
| `createProject` | a person who is an active member: admins, and members, who hold `projects:create` with their role. An agent gets 403 `Agents cannot create projects.` |
| `updateProject` | the person who created the project, or a company admin. An agent gets 403. |

Every call checks membership first (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, an agent from another company answers 403 `Agent key cannot access another company`, and a member whose membership is not active answers 403 `User does not have active company access` on any write.

A company admin means the `owner` or `admin` role. An instance admin, and the local operator, pass every role and visibility check on this page.

### Visibility

A project is open to the whole company by default (`visibility: "company"`). A **restricted** project (`visibility: "restricted"`) is visible only to company admins, the person who created it, and the people and agents on its access list (`server/src/routes/visibility.ts`). For anyone else it does not exist: the list leaves it out, and reading it answers 404 `Project not found`, never 403. See [Conventions](/api/conventions).

When an update restricts a project that has a lead agent, that agent is added to the access list in the same request, so it keeps seeing the project it works on.

### Project ids in paths

Wherever `{id}` appears below, you can send the project's UUID or its shortname (the `urlKey` field). For an agent, a shortname is looked up in its own company; a person must add `?companyId=$COMPANY_ID`. A shortname that matches more than one project answers 409 `Project shortname is ambiguous in this company. Use the project ID.` One that matches nothing reaches the database as is and answers 400 `Invalid identifier`.

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

## List projects

`GET /api/companies/{companyId}/projects` · [`listProjects`](/api/reference#tag/projects/listProjects)

The company's projects that are visible to you, archived ones included, each with its goals and workspaces. There is no paging and no guaranteed order.

```bash
curl https://your-instance.example/api/companies/$COMPANY_ID/projects \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — an array of `Project` (below).

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |

## Get a project

`GET /api/projects/{id}` · [`getProject`](/api/reference#tag/projects/getProject)

```bash
curl https://your-instance.example/api/projects/$PROJECT_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — one `Project`.

| Status | When |
| --- | --- |
| 400 | `Invalid identifier` — the id is neither a UUID nor a shortname that resolves. |
| 403 | Not a member, or an agent key for another company (messages above). |
| 404 | `Project not found` — no such project, or a restricted project you may not see. |
| 409 | `Project shortname is ambiguous in this company. Use the project ID.` |

## Create a project

`POST /api/companies/{companyId}/projects` · [`createProject`](/api/reference#tag/projects/createProject)

You become the project's creator, which is what lets you edit it later. The creator is always the caller; the body cannot name one.

```bash
curl -X POST https://your-instance.example/api/companies/$COMPANY_ID/projects \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Acme Research site", "goalIds": ["'"$GOAL_ID"'"], "status": "planned", "workspace": { "repoUrl": "https://git.example/acme/site", "repoRef": "main", "isPrimary": true } }'
```

**Body** (`createProjectSchema`) — the fields that matter:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Required, non-empty. See *Names* below. |
| `description` | string or null | |
| `status` | `backlog` · `planned` · `in_progress` · `completed` · `cancelled` | Default `backlog`. |
| `goalIds` | array of UUIDs | The [goals](/api/goals) this project serves, from the same company. `goalId` (one UUID) still works but is deprecated. |
| `leadAgentId` | UUID or null | The agent that leads the project. |
| `targetDate` | string or null | |
| `color` | string or null | If omitted, the server picks one from its palette. |
| `visibility` | `company` · `restricted` | Default `company`. |
| `env` | object | Environment variables for every run in the project. See *Project env* below. |
| `executionWorkspacePolicy` | object or null | How runs in this project get a workspace. `environmentId` here must be an environment of this company, not archived, with driver `local`, `ssh` or `sandbox`. |
| `workspace` | object | Optional. Seeds the project with one workspace: `name`, `cwd`, `repoUrl`, `repoRef`, `isPrimary`, and more. It needs `cwd` or `repoUrl`; with `sourceType: "remote_managed"` it needs `remoteWorkspaceRef` or `repoUrl` instead. |
| `confirmSimilarName` | boolean | Send `true` to create despite a similar-name warning. Not stored. |

**Names.** Before creating, the server compares `name` with the unarchived projects you can see. If one has the same letters and digits, ignoring case, spaces and punctuation, or one name starts with the other, the request answers 409 and names that project. Resend with `confirmSimilarName: true` to create it anyway. If the name's shortname is still taken, the server appends a number (`Acme Research site 2`), so read the stored name from the response.

**Project env.** Keys are upper-case letters, digits and underscores, start with a letter, and are at most 64 characters (`server/src/services/adapter-host-execution-policy.ts`). Variables that change what runs or which credentials are used are refused. A value is a string, `{ "type": "plain", "value": "…" }`, or `{ "type": "secret_ref", "secretId": "…", "version": "latest" }` for a company [secret](/api/secrets). Plain values are returned as stored, so put anything sensitive in a secret. On an instance with `PAPERCLIP_SECRETS_STRICT_MODE=true`, a sensitive key must be a secret reference. Send `{}` for no variables: `null` answers 422 `env must be an object`.

**Host-executed commands.** A command that would run on the server host — `provisionCommand` and `teardownCommand` under `executionWorkspacePolicy.workspaceStrategy`, anything under `executionWorkspacePolicy.workspaceRuntime`, and the workspace's `cleanupCommand` and runtime services — may be set only by an instance admin (`server/src/routes/workspace-command-authz.ts`). Leaving one empty is always allowed.

**Response** `201` — the new `Project`, including the seeded workspace.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema, including a `workspace` with neither `cwd` nor `repoUrl`. |
| 403 | `Agents cannot create projects.` — the caller is an agent. |
| 403 | `Creating a project needs the projects:create permission, or an owner, admin or operator role…` — a member without the permission. |
| 403 | `Instance admin access required to set a host-executed workspace command (…)…` — the body sets a host-executed command and you are not an instance admin. The message lists the fields. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Secret not found` — an `env` secret reference names no secret. |
| 409 | `A project named "…" already exists in this company. Pick a different name, or resend with confirmSimilarName: true to create it anyway.` |
| 422 | `Environment not found.`, `Environment is archived.`, or `Environment driver "…" is not allowed here…` — the `executionWorkspacePolicy.environmentId` cannot be used. A sandbox environment on the built-in `fake` provider is refused too. |
| 422 | `Project env key names must be upper-case letters…` or `Project env cannot set execution-affecting variables (…)…` — an `env` key is refused. |
| 422 | `env must be an object`, `Invalid environment variable name: …`, `Invalid environment binding for key: …`, `Secret must belong to same company`, `Refusing to persist redacted placeholder for key: …`, `Strict secret mode requires secret references for sensitive key: …`, or `… refers to a secret managed by a connection…` — an `env` value is refused. |
| 422 | `Invalid project workspace payload` — the workspace has no usable `cwd` or `repoUrl`. The project is not kept. |

## Update a project

`PATCH /api/projects/{id}` · [`updateProject`](/api/reference#tag/projects/updateProject)

Send only the fields you are changing. Only the project's creator or a company admin may change it; a project with no recorded creator is admin-only.

```bash
curl -X PATCH https://your-instance.example/api/projects/$PROJECT_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "in_progress", "visibility": "restricted" }'
```

**Body** (`updateProjectSchema`) — every field from create is optional. `workspace` and `confirmSimilarName` are not part of it and are dropped if sent. Also:

| Field | Type | Notes |
| --- | --- | --- |
| `archivedAt` | ISO 8601 timestamp or null | A timestamp archives the project and frees its name; `null` unarchives it. |
| `goalIds` | array of UUIDs | Replaces the project's goal links. `[]` removes them all. |
| `name` | string | No similar-name check here. If the new shortname is taken, a number is appended. |
| `visibility` | `company` · `restricted` | Restricting adds the lead agent, if any, to the access list. |

The rules for `env`, `executionWorkspacePolicy` and host-executed commands are the same as on create. Resending a command's stored value, or clearing it, is not refused.

**Response** `200` — the updated `Project`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 400 | `Invalid identifier` — the id is neither a UUID nor a shortname that resolves. |
| 403 | `Agents cannot modify project. Ask the project's owner or an admin.` — the caller is an agent. |
| 403 | `Only the project's creator or an admin can change it.` |
| 403 | `Instance admin access required to set a host-executed workspace command (…)…` |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Project not found`. |
| 404 | `Secret not found` — an `env` secret reference names no secret. |
| 409 | `Project shortname is ambiguous in this company. Use the project ID.` |
| 422 | The same environment, `env` and secret refusals as on create. |

## The `Project` object

From `packages/shared/src/types/project.ts`. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `companyId` | UUID | |
| `urlKey` | string | The shortname, usable in place of `id` in paths. |
| `name`, `description` | string, string or null | |
| `status` | `backlog` · `planned` · `in_progress` · `completed` · `cancelled` | |
| `visibility` | `company` · `restricted` | |
| `goalIds`, `goals` | array of UUIDs, array of `{ id, title }` | The linked [goals](/api/goals). `goalId` is the first of them, kept for older clients. |
| `leadAgentId` | UUID or null | |
| `targetDate`, `color` | string or null | |
| `env` | object or null | The env bindings as stored. |
| `executionWorkspacePolicy` | object or null | |
| `workspaces`, `primaryWorkspace` | array of workspaces, one workspace or null | Each with `id`, `name`, `sourceType`, `cwd`, `repoUrl`, `repoRef`, `isPrimary`. |
| `codebase` | object | Where the project's code lives: `repoUrl`, `repoRef`, `localFolder`, `effectiveLocalFolder`, `origin`. |
| `pauseReason`, `pausedAt` | string or null, timestamp or null | Set while the project is paused. |
| `archivedAt` | timestamp or null | |
| `createdAt`, `updatedAt` | ISO 8601 timestamp | |

The complete schema is in [the reference](/api/reference#tag/projects/getProject).

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Other routes on this resource (workspaces, workspace runtime services and commands, the access list, delete, definition of done) are internal — see [the route index](/api/route-index), under `projects`.
