---
title: Approvals and decisions
summary: Approvals are requests that wait on a person; the Decisions page is where a person sees everything waiting on them.
---

An **approval** is a request that waits on a person: an agent asks to hire, to spend past a limit, or to go ahead with a plan. The **Decisions** page is the one place a person sees what is waiting on them, approvals included.

Source: `packages/db/src/schema/approvals.ts`, `packages/shared/src/constants.ts`, `server/src/routes/approvals.ts`, `ui/src/pages/Decisions.tsx`

## Approval types

From `APPROVAL_TYPES`:

| Value | Raised when |
| --- | --- |
| `hire_agent` | An agent is hired in a company that requires approval for new agents. |
| `approve_ceo_strategy` | An agent asks for sign-off on its strategy. |
| `budget_override_required` | Spending would go past a budget limit. |
| `request_board_approval` | An agent asks a person to approve something general. |
| `mandate_violation` | An agent tried an action outside a mandate it holds (expired, over its cap, or out of scope). The agent is paused with reason `mandate` and resumed when the approval is resolved. |
| `connector_send` | An agent asks to write through a connector. |
| `inbound_content_review` | Held inbound content needs a person to release it. |
| `deliverable_review` | A named approver signs off one cycle of a deliverable. |
| `workflow_recommendation` | A review agent asks a pipeline's owner to accept a suggestion. Advisory only. |

The last four come from features that a workspace has only when its operator switched them on.

## Approval status

From `APPROVAL_STATUSES`. Default `pending`.

`pending` · `revision_requested` · `approved` · `rejected` · `cancelled`

A `revision_requested` approval goes back to `pending` when the requesting agent resubmits it. A resubmit advances `revision`, so a decision that names an older revision fails instead of deciding a request that has since changed.

## Who decides

Deciding is a human act. Approve, reject, request-revision and override need a person (board key or session); an agent gets 403. Approving or rejecting an open `hire_agent` approval also needs `agents:create`. The approval records the decider (`decidedByUserId`), the note, the channel, the revision and, for an override, the `overrideReason`. Where stewardship is switched on, an ordinary approve or reject belongs to the requesting agent's steward; admins decide through the override, with a written reason (`server/src/services/approval-authority.ts`).

## The Decisions page

`/decisions` in the web app replaces the old Inbox and Approvals lists; their URLs redirect. Its main list comes from `GET /api/companies/{companyId}/assistant/pending-decisions`: pending approvals plus open issues assigned to you that a person filed (`originKind` = `manual`). Issues the machine filed — routines, evaluations, escalations — sit under a collapsed **Other activity** section. A row opens the approval at `/approvals/{id}`.

## Issue review decisions

Separate from approvals, an issue's execution policy can add `review` or `approval` stages (`ISSUE_EXECUTION_STAGE_TYPES`). Each decision on a stage is a row in `issue_execution_decisions` with an outcome from `ISSUE_EXECUTION_DECISION_OUTCOMES`: `approved` or `changes_requested`.

See also: [Approvals guide](/guides/board-operator/approvals) · [Handling approvals](/guides/agent-developer/handling-approvals) · [Approvals API](/api/approvals) · [Mandates, directives and the agent bundle](/concepts/mandates-directives-and-the-agent-bundle)
