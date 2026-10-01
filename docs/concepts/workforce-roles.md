---
title: Workforce roles
summary: Versioned role templates that pin an agent's work instructions, and the enrollment that ties an agent to one.
---

A **workforce role** is a versioned template that describes a kind of work: responsibilities, the company facts it needs, procedures, quality checks and a starter job. A **workforce enrollment** pins one agent to one template version. A role describes work; it never grants authority.

Source: `packages/db/src/schema/workforce_enrollments.ts`, `packages/shared/src/workforce-templates.ts`, `packages/shared/src/types/workforce.ts`, `server/src/routes/workforce.ts`

## The version-1 templates

From `WORKFORCE_TEMPLATES`:

| `id` | Name | Required facts (`requiredFactKeys`) |
| --- | --- | --- |
| `marketing-content` | Marketing content | `offer`, `audience`, `brandVoice`, `approvedClaims` |
| `sales-support` | Sales support | `offer`, `pricing`, `idealCustomer`, `qualificationRules` |

Each template also carries a skill that is installed on the enrolled agent. The skill text states that it grants no permission, and that drafts are not sent or published without separate authorization.

## Enrollment

One row per agent in `workforce_enrollments` (unique on `agentId`):

| Column | What it holds |
| --- | --- |
| `templateId`, `templateVersion` | The pinned template. |
| `objective`, `metrics` | What the agent is aiming at. |
| `goalId` | An optional linked goal. |
| `firstJobIssueId` | The issue created for the starter job. |
| `learnedBriefRevision` | The company brief revision the agent acknowledged. |
| `installedSkillKeys`, `skillInstallError` | Skill installation state. |

The company brief is a set of sourced facts a person confirms. Agents can propose facts; a person approves or rejects each proposal.

## Readiness

`GET .../workforce/agents/{agentId}/readiness` returns a `phase`: `learning` · `needs_input` · `working` · `awaiting_review` · `ready` · `refresh_needed`. `ready` means the first job's evidence has a current, neutral, passed verdict. Acceptance is derived from evidence, not set by hand.

## Who can do what

Routes live under `/api/companies/{companyId}/workforce`. Changes that set direction (publish the brief, review proposals, enroll an agent) need a person who may set company direction; agents get 403. An agent may read only its own enrollment. An enrolled agent must use an adapter in `WORKFORCE_PROMPT_ADAPTER_TYPES`; custom process and HTTP runners are refused. People acting through their own board key reach the same operations through [Human control](/api/human-control).

See also: [Managing agents](/guides/board-operator/managing-agents) · [Human control API](/api/human-control) · [Issues API](/api/issues) · [Agents, roles and autonomy](/concepts/agents-roles-and-autonomy)
