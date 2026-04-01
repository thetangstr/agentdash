# MAW Slash Commands

> **MANDATORY:** All feature and bug development MUST use MAW. No development outside MAW except production hotfixes.

## Command Reference

| Command | Agent | Description |
|---------|-------|-------------|
| `/workon PAP-XXX` | Orchestrator | Drive issue from intake -> locally-tested |
| `/pm` | PM | Interactive requirements elaboration |
| `/pm <description>` | PM | Elaborate specific feature |
| `/builder` | Builder | Auto-pickup highest priority issue |
| `/builder PAP-XXX` | Builder | Work on specific issue |
| `/tester PAP-XXX` | Tester | Test specific issue |
| `/tpm sync` | TPM | Ship all Human-Verified issues |
| `/tpm <project>` | TPM | Break project into issues + wave plan |
| `/tpm status` | TPM | Single-issue status |
| `/tpm wave` | TPM | Show wave details |
| `/admin` | Admin | Full health check + stats |
| `/admin health` | Admin | Check service health |
| `/admin status` | Admin | Show deployment status |

## Agent Roles

| Agent | Workspace | Merges to agentdash-main? |
|-------|-----------|----------------|
| **TPM** | 1 dedicated | **YES (sole agent)** |
| **Builder** | 1 per issue | No |
| **Tester** | Subagent | No |
| **PM** | Subagent | No |
| **Admin** | On demand | No |

## Quick Reference

| Task | Command | Notes |
|------|---------|-------|
| **Start any issue** | `/workon PAP-XXX` | Per-workspace orchestration |
| **Check status & ship** | `/tpm sync` | Main shipping command |
| **Plan a project** | `/tpm <description>` | Creates issues, waves, workspaces |
| Elaborate requirements | `/pm <description>` | Manual PM control |
| Start implementation | `/builder PAP-XXX` | Skip PM, go direct |
| Test a PR | `/tester PAP-XXX` | Manual test trigger |
| Service health | `/admin health` | Ops monitoring |

## Documentation

- **MAW SOP:** `doc/multi-agent-workflow/sop.md`
- **Agent Protocol:** `doc/multi-agent-workflow/protocol.md`
- **Epic Registry:** `doc/multi-agent-workflow/EPIC_REGISTRY.md`
