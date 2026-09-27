---
title: Activity
summary: Activity log queries
---

Query the audit trail of all mutations across the company.

## List Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`) |
| `entityId` | Filter by specific entity |

## Activity Record

Each entry includes:

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (created, updated, commented, etc.) |
| `entityType` | What type of entity was affected |
| `entityId` | ID of the affected entity |
| `details` | Specifics of the change |
| `origin` | Who wrote the row: `server` (a server route, actor taken from the signed-in principal), `manual` (posted by hand, see below), or `null` (written before origin was recorded) |
| `createdAt` | When the action occurred |

## Post a Manual Entry

```
POST /api/companies/{companyId}/activity
```

Board users only. Body: `action`, `entityType`, `entityId`, and optional `agentId` and `details`.

The server records the row as authored by the caller and marks it `origin: "manual"` (also mirrored as `details.origin`). `actorType` and `actorId` are still accepted for compatibility but ignored: a manual entry can no longer claim to come from the system, an agent or a plugin, and it is never presented as a server record.

## What Gets Logged

All mutations are recorded:

- Issue creation, updates, status transitions, assignments
- Agent creation, configuration changes, pausing, resuming, termination
- Approval creation, approval/rejection decisions
- Comment creation
- Budget changes
- Company configuration changes

The activity log is append-only and immutable.
