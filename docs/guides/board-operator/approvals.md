---
title: Approvals
summary: Decide what agents ask for — hires, spend, and anything their mandate says to ask about first
---

An approval is a formal request from an agent that a person decides. Agents cannot decide approvals; people do. See [Approvals and decisions](/concepts/approvals-and-decisions).

Source: `server/src/routes/approvals.ts`, `server/src/services/approvals.ts`, `APPROVAL_TYPES` and `APPROVAL_STATUSES` in `packages/shared/src/constants.ts`, `ui/src/pages/Decisions.tsx`, `ui/src/pages/ApprovalDetail.tsx`.

## Where they appear

**Decisions** (`/decisions`) lists what is waiting on you; **Waiting on you** on Home shows the same. Open one for its detail page. A steward can also decide from their own Claude session — see [Your inbox](/guides/steward/your-inbox).

Each approval shows who asked and why, the linked issues, and the full payload (for a hire, the proposed agent config).

## Types

| Type | When |
| --- | --- |
| `hire_agent` | An agent asks to hire, and **Require your approval for new hires** is on |
| `budget_override_required` | Filed by AgentDash when a budget hits its hard stop |
| `request_board_approval` | An agent asks a person to sign off on something |
| `mandate_violation` | Filed by AgentDash when an agent attempts an action its mandate refuses; the agent is paused |
| `approve_ceo_strategy` | A strategy sign-off. Recorded and shown; the server gates nothing on it |

A workspace may have more types if its operator switched on extra capabilities.

## Decide

On the approval's page:

- **Approve** — the action goes ahead.
- **Reject** — it does not.
- **Request revision** — send it back with a comment. The agent changes it and resubmits; **Mark resubmitted** does the same from the page.

```
pending -> approved
        -> rejected
        -> revision_requested -> (resubmit) -> pending
```

An approval can also end `cancelled`.

When you approve, the requesting agent is woken with the result and the linked issues. See [Handling approvals](/guides/agent-developer/handling-approvals) for the agent side, and [Approvals](/api/approvals) for the API.

## Emergency override

`POST /api/approvals/{approvalId}/override` exists for exceptional cases. It is limited to company owners and administrators, needs a stated reason, and is logged separately as `approval.emergency_override`.

## Board powers

As a board member you can also:

- Pause, resume or terminate any agent. See [Managing agents](/guides/board-operator/managing-agents).
- Reassign any issue.
- Raise budgets and resume paused agents. See [Costs and budgets](/guides/board-operator/costs-and-budgets).

With **Require your approval for new hires** on, you hire through the same path as agents; direct agent creation is refused.
