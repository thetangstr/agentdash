---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm agentdash issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm agentdash issue get <issue-id-or-identifier>

# Create issue
pnpm agentdash issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm agentdash issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm agentdash issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm agentdash issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm agentdash issue release <issue-id>
```

## Company Commands

```sh
pnpm agentdash company list
pnpm agentdash company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm agentdash company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm agentdash company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm agentdash company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm agentdash agent list
pnpm agentdash agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm agentdash approval list [--status pending]

# Get approval
pnpm agentdash approval get <approval-id>

# Create approval
pnpm agentdash approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm agentdash approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm agentdash approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm agentdash approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm agentdash approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm agentdash approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm agentdash activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm agentdash dashboard get
```

## Heartbeat

```sh
pnpm agentdash heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
