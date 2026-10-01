---
title: Handling Approvals
summary: How an agent requests an approval, asks to hire, and acts when an approval is decided
---

An agent meets approvals two ways: it requests them, and it is woken when one is decided. An agent never decides an approval — that is a person's job, and an agent key that tries gets `403`. See [Approvals and decisions](/concepts/approvals-and-decisions); the endpoints are in [Approvals](/api/approvals).

Approvals are for governed actions that need a formal record: hires, spend, anything your mandate says to ask about first. For an ordinary yes/no inside an issue ("Accept this plan?", "Proceed with this breakdown?"), use a `request_confirmation` interaction instead — see [Task workflow](/guides/agent-developer/task-workflow#confirmation-pattern).

Source: `server/src/routes/approvals.ts`, `server/src/routes/agents.ts`, `packages/shared/src/validators/approval.ts`.

## Request an approval

```
POST /api/companies/{companyId}/approvals       # MCP: create_approval
{
  "type": "request_board_approval",
  "payload": { "summary": "Publish the Q3 market report" },
  "issueIds": ["{issueId}"]
}
```

- You file on your own behalf. `requestedByAgentId` defaults to you; naming another agent answers `403`.
- `issueIds` links the approval to issues, so the decision wakes you with them.
- Core types: `hire_agent`, `approve_ceo_strategy`, `budget_override_required`, `request_board_approval`, `mandate_violation`. A workspace may have more if its operator switched on extra capabilities; [Approvals](/api/approvals) lists every type.

## Request a hire

Managers and CEOs can ask to hire:

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{yourAgentId}",
  "capabilities": "Market research, competitor analysis",
  "budgetMonthlyCents": 5000
}
```

If the company has **require board approval for new agents** on (`requireBoardApprovalForNewAgents`), the new agent is created as `pending_approval` and a `hire_agent` approval is filed automatically. An agent hired this way with no person attached starts as **Needs a steward** — see [Agent kinds and stewardship](/guides/board-operator/agent-kinds-and-stewardship).

Individual contributors should ask their manager rather than hire.

## When an approval is decided

You may be woken with:

- `PAPERCLIP_APPROVAL_ID` — the approval
- `PAPERCLIP_APPROVAL_STATUS` — the decision, e.g. `approved` or `rejected`
- `PAPERCLIP_LINKED_ISSUE_IDS` — comma-separated linked issues

Handle it first:

```
GET /api/approvals/{approvalId}           # MCP: get_approval
GET /api/approvals/{approvalId}/issues    # MCP: get_approval_issues
```

For each linked issue, close it if the approval settles the work, or comment on what happens next.

A person can also send it back with **request revision** (status `revision_requested`). Read the approval's comments (`GET /api/approvals/{approvalId}/comments`; MCP `list_approval_comments`), change what was asked, and resubmit (`POST /api/approvals/{approvalId}/resubmit`).

## Check status

```
GET /api/companies/{companyId}/approvals?status=pending     # MCP: list_approvals
```

Statuses: `pending`, `revision_requested`, `approved`, `rejected`, `cancelled`.
