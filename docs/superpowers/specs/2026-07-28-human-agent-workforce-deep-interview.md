# Deep Interview Transcript: Human–Agent Workforce

## Metadata

- Profile: Standard
- Context: Brownfield
- Interview ID: `71fc47d4-4411-4258-86c0-5f2b98250e0a`
- Rounds: 10
- Final ambiguity: 5%
- Target threshold: 20%
- Context snapshot: `docs/superpowers/specs/2026-07-27-human-agent-workforce-context-snapshot.md`
- Prompt-safe initial-context summary: not needed

## Initial intent

Create an AI-native company model in which every human has a dedicated company agent. The human controls the agent's mandate and operating choices, agents collaborate through the company hierarchy, humans approve governed actions, and messaging channels make the relationship accessible away from the AgentDash web application.

## Condensed transcript

### Round 1 — institutional ownership

**Question:** When a Head of Marketing changes roles or leaves the company, what happens to their agent?

**Answer:** The agent stays with the company.

**Resolution:** The agent is a company institutional asset. The assigned human is its steward, not its owner.

### Round 2 — mandate authority

**Question:** Because the agent stays with the company, who can change its mandate?

**Answer:** The current human steward can edit it freely, with an audit trail.

**Resolution:** Mandate changes do not require pre-approval, but every version must remain attributable and recoverable.

### Round 3 — breadth of stewardship

**Question:** Does the steward's freedom include permissions and autonomy?

**Answer:** Yes. The steward controls the agent's mandate, connections, permissions, budgets, and autonomy.

**Resolution:** Stewardship is operationally comprehensive rather than limited to instruction prose.

### Round 4 — company ceilings

**Question:** Can company owners impose hard limits that the steward cannot override?

**Answer:** Yes. Owners set maximum permissions, spending, destructive-action, and data-access boundaries; the steward controls everything inside them.

**Resolution:** Steward authority is delegated inside non-overridable company policy ceilings.

### Round 5 — first release

**Question:** What is the smallest first release that proves the model?

**Answer:** Multi-human access, one-to-one stewardship, owner ceilings, web Inbox approvals, Telegram, and initially the local computer-agent bridge.

**Resolution:** The release must prove an end-to-end operating loop, not only add a relationship table.

### Round 6 — local computer agent

**Question:** Is the human's local Codex/Claude agent a tool, peer, or human-only copilot?

**Answer:** A scoped execution tool, but treat it as P2.

**Resolution:** The AgentDash agent owns the task. A future local bridge may execute a bounded request and return evidence, but it has no peer-agent identity in P0.

### Round 7 — initial non-goals

**Question:** Should P0 exclude the local bridge, Teams, and new SaaS integrations?

**Answer:** No. Only the bridge is P2; everything else is P0.

**Resolution:** Telegram and Microsoft Teams are both P0.

### Round 8 — direct integration boundary

**Question:** Does P0 include direct Salesforce, HubSpot, Jira, SharePoint, or Google Drive integrations?

**Answer:** No. P0 includes Telegram and Teams, but none of those new direct integrations.

**Resolution:** P0 proves the human–agent operating model without becoming a general SaaS connector program.

### Round 9 — IM approval depth

**Question:** How far must IM approvals go in P0?

**Answer:** Both Telegram and Teams support native approve/reject actions inside the conversation.

**Resolution:** Notification-only messaging bridges are insufficient.

### Round 10 — approval authority

**Question:** Who may approve or reject an action requested by a stewarded agent?

**Answer:** Its assigned human steward, with company owner/admin emergency override.

**Resolution:** Approval authority follows the stewardship relation. Overrides are exceptional, attributable, and audited.

## Pressure-pass findings

The initial phrase "every person gets an agent" could have implied personal ownership. The interview established the opposite: the agent stays with the company, but the human steward receives broad operational control. That control is not absolute; owner-defined company ceilings remain non-overridable. A second scope pressure pass removed the local Codex/Claude bridge from P0 and constrained P0 to the web application plus Telegram and Teams, without new business-system connectors.

## Brownfield facts

- Multi-human memberships, roles, invites, and grants already exist.
- No enforceable human-to-agent stewardship relation exists.
- Instruction bundles already support history and rollback, but permissions are company-wide.
- Web Inbox and approval records already exist, but approval authority is not steward-scoped.
- Parent/child issues are the strongest existing agent-to-agent delegation substrate.
- Company Chat is not ready to carry auditable multi-agent orchestration.
- MCP and managed local/SSH adapters exist, but there is no paired-device/local-copilot bridge.
