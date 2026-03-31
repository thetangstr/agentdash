# MAW Slash Commands

> **MANDATORY:** All feature and bug development MUST use MAW. No development outside MAW except production hotfixes.

## Command Reference

| Command | Agent | Description |
|---------|-------|-------------|
| `/workon AD-XXX` | Orchestrator | Drive issue from intake -> locally-tested |
| `/pm` | PM | Interactive requirements elaboration |
| `/pm <description>` | PM | Elaborate specific feature |
| `/builder` | Builder | Auto-pickup highest priority issue |
| `/builder AD-XXX` | Builder | Work on specific issue |
| `/tester AD-XXX` | Tester | Test specific issue |
| `/tpm sync` | TPM | Ship all Human-Verified issues |
| `/tpm <project>` | TPM | Break project into issues + wave plan |
| `/tpm status` | TPM | Single-issue status |
| `/tpm wave` | TPM | Show wave details |
| `/admin` | Admin | Full health check + stats |
| `/admin health` | Admin | Check service health |
| `/admin status` | Admin | Show deployment status |

## Agent Roles

| Agent | Workspace | Merges to main? |
|-------|-----------|----------------|
| **TPM** | 1 dedicated | **YES (sole agent)** |
| **Builder** | 1 per issue | No |
| **Tester** | Subagent | No |
| **PM** | Subagent | No |
| **Admin** | On demand | No |

## Quick Reference

| Task | Command | Notes |
|------|---------|-------|
| **Start any issue** | `/workon AD-XXX` | Per-workspace orchestration |
| **Check status & ship** | `/tpm sync` | The main command |
| **Plan a project** | `/tpm <description>` | Creates issues, waves, workspaces |
| Elaborate requirements | `/pm <description>` | Manual PM control |
| Start implementation | `/builder AD-XXX` | Skip PM, go direct |
| Test a PR | `/tester AD-XXX` | Manual test trigger |
| Service health | `/admin health` | Ops monitoring |

## Documentation

- **MAW SOP:** `doc/maw/sop.md`
- **Agent Protocol:** `doc/maw/protocol.md`
- **Epic Registry:** `doc/maw/EPIC_REGISTRY.md`
