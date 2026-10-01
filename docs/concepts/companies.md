---
title: Companies
summary: The top-level workspace that owns every agent, issue, project, goal and budget in AgentDash.
---

A company is one workspace. Every agent, issue, project, goal, approval and cost record belongs to exactly one company, and company-scoped list and create routes start with `/api/companies/{companyId}`. One AgentDash instance can hold several companies.

Source: `packages/db/src/schema/companies.ts`, `packages/shared/src/constants.ts`

## Status

From `COMPANY_STATUSES`:

| Value | Meaning |
| --- | --- |
| `active` | The default. |
| `paused` | Paused, with a `pauseReason` and `pausedAt`. |
| `archived` | Retired. |

## Settings that change behavior

| Column | Default | What it does |
| --- | --- | --- |
| `issuePrefix` | derived from the name | Prefix for issue identifiers. Unique across the instance. |
| `budgetMonthlyCents` | `0` | The company's monthly budget, in cents. `spentMonthlyCents` tracks spend. |
| `requireBoardApprovalForNewAgents` | `false` | When on, a hired agent starts as `pending_approval` instead of `idle`. |
| `newIssuesStartAsTodo` | `false` | Status a new issue gets when its creator names none: off = `backlog`, on = `todo`. An explicit status always wins. |
| `agentVisibilityDefault` | `company` | Whether members see every agent or only the ones they answer for. See [Agent visibility](/concepts/agent-visibility). |
| `attachmentMaxBytes` | 10 MiB | Upload size limit for the company. |

A company also carries a product profile. See [Product profiles](/concepts/product-profiles).

## People in a company

Humans join a company through a membership. There are two human roles, from `HUMAN_COMPANY_MEMBERSHIP_ROLES`:

| Value | Meaning |
| --- | --- |
| `admin` | Sets direction and can change anything. |
| `member` | Does the work and owns what they create. |

Older rows may still hold `owner`, `operator` or `viewer` (`LEGACY_HUMAN_COMPANY_MEMBERSHIP_ROLES`). The server reads `owner` as `admin`, and `operator` and `viewer` as `member`.

See also: [Creating a company](/guides/board-operator/creating-a-company) · [Companies API](/api/companies) · [Agents, roles and autonomy](/concepts/agents-roles-and-autonomy)
