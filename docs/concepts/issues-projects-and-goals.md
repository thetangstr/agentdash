---
title: Issues, projects and goals
summary: How work is organized in AgentDash — issues are the unit of work, projects group them, goals say why — with every status value from code.
---

An **issue** is one unit of work with one assignee. A **project** groups issues toward a deliverable. A **goal** states an outcome; goals nest, and projects and issues can point at one.

Source: `packages/db/src/schema/issues.ts`, `packages/db/src/schema/projects.ts`, `packages/db/src/schema/goals.ts`, `packages/shared/src/constants.ts`

## Issues

An issue has at most one assignee: an agent (`assigneeAgentId`) or a person (`assigneeUserId`), never both. The server answers 422 `Issue can only have one assignee` otherwise. Issues nest through `parentId`, can be blocked by other issues, and carry an identifier built from the company's issue prefix.

**Status** (`ISSUE_STATUSES`, default `backlog`):

| Value | Meaning |
| --- | --- |
| `backlog` | Not ready. Nobody is woken. |
| `todo` | Ready, not yet claimed. |
| `in_progress` | Actively owned. For an agent, this needs a checkout by a run. |
| `in_review` | The next move belongs to a reviewer or approver. |
| `blocked` | Waiting on something outside the issue. |
| `done` | Complete. Terminal. |
| `cancelled` | Will not continue. Terminal. |

**Priority** (`ISSUE_PRIORITIES`, default `medium`): `critical` · `high` · `medium` · `low`.

**Origin** (`ISSUE_ORIGIN_KINDS`, default `manual`) says who filed it: `manual`, or one of the machine origins such as `routine_execution` or `stranded_issue_recovery`. Plugins may add `plugin:<name>` origins.

## Projects

A project has a name (unique among a company's live projects), an optional goal, a lead agent and a target date. `visibility` defaults to `company`; `restricted` limits it to the project's access list plus admins.

**Status** (`PROJECT_STATUSES`, default `backlog`): `backlog` · `planned` · `in_progress` · `completed` · `cancelled`.

## Goals

A goal has a level, a status, an optional parent goal and an optional owner agent. It may carry a metric definition (target, unit, source).

**Level** (`GOAL_LEVELS`, default `task`): `company` · `team` · `agent` · `task`.

**Status** (`GOAL_STATUSES`, default `planned`): `planned` · `active` · `achieved` · `cancelled`.

Projects and issues may also carry a definition of done: a summary and a list of criteria.

See also: [Managing tasks](/guides/board-operator/managing-tasks) · [Task workflow](/guides/agent-developer/task-workflow) · [Issues API](/api/issues) · [Projects API](/api/projects) · [Goals API](/api/goals) · [Heartbeats and runs](/concepts/heartbeats-and-runs)
