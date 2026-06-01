# MAW v6 Slash Commands

> **MANDATORY:** All feature and bug development MUST use MAW. No development outside MAW except production hotfixes or pure infrastructure work.

## Command Reference

| Command | Agent | Description |
|---------|-------|-------------|
| `/workon <ISSUE>` | Orchestrator | Drive issue through full pipeline |
| `/pm` | PM | Interactive requirements elaboration |
| `/pm <description>` | PM | Create + elaborate new issue |
| `/builder` | Builder | Auto-pickup highest priority ready issue |
| `/builder <ISSUE>` | Builder | Implement specific issue |
| `/tester <ISSUE>` | Tester | Test specific issue |
| `/reviewer <ISSUE>` | Reviewer | Code review specific PR |
| `/tpm sync` | TPM | Merge all Review-Approved issues |
| `/tpm promote` | TPM | Promote staging to production |
| `/tpm ota-push` | TPM | Push OTA updates to edge instances |
| `/tpm ota-status` | TPM | Check edge instance status |
| `/tpm status [ISSUE]` | TPM | Show issue pipeline position |
| `/tpm wave <project>` | TPM | Break project into issues |
| `/admin` | Admin | Full health check |
| `/admin health` | Admin | Quick health check |
| `/admin deploy <env>` | Admin | Deploy to environment |
| `/admin instances` | Admin | List edge instances |
| `/admin rollback <env>` | Admin | Rollback environment |

## Agent Roles

| Agent | Workspace | Merges? | Runtime |
|-------|-----------|---------|---------|
| **Orchestrator** | Per issue | No | Any |
| **PM** | Subagent | No | Any |
| **Builder** | Per issue | No | Any |
| **Tester** | Subagent | No | Needs Chrome for CUJ |
| **Reviewer** | Subagent | No | Any |
| **TPM** | Dedicated | **YES** | Any |
| **Admin** | On demand | No | Any |

## Quick Reference

| Task | Command | Notes |
|------|---------|-------|
| **Start any issue** | `/workon AGE-123` | Per-workspace orchestration |
| **Ship approved work** | `/tpm sync` | Merges all Review-Approved issues |
| **Plan a project** | `/tpm wave <project>` | Creates issues + wave plan |
| **Promote to prod** | `/tpm promote` | Staging to production |
| **Push OTA update** | `/tpm ota-push` | Edge instance updates |
| Elaborate requirements | `/pm <description>` | Create or refine an issue |
| Start implementation | `/builder AGE-123` | Skip PM, go direct to build |
| Test a PR | `/tester AGE-123` | Manual test trigger |
| Review a PR | `/reviewer AGE-123` | Code review trigger |
| Service health | `/admin health` | Quick ops check |
| Deploy | `/admin deploy staging` | Deploy to target env |
| Rollback | `/admin rollback staging` | Roll back target env |

## Entry Points

- **Linear** -- create issue in Todo, agent picks up automatically
- **CLI** -- `/workon AGE-123` in Claude Code terminal
- **Desktop** -- same commands in Claude Code desktop app
- **Contractor** -- Anthropic cloud agent, triggered by Linear webhook
- **Any MCP tool** -- Cursor, Codex, etc. with Linear MCP connected

## Pipeline Flow

```
Todo --> In Progress --> In Review --> Review-Approved --> Merged
 |         |              |              |                  |
 PM    Builder         Tester +      TPM sync           Done
                       Reviewer
```

Issues move through labels managed by the protocol state machine. Each agent owns its transition:

1. **PM** elaborates requirements, moves to ready
2. **Builder** implements, opens PR, moves to In Review
3. **Tester** validates, **Reviewer** reviews code
4. Both approve --> Review-Approved
5. **TPM** merges all Review-Approved issues on `/tpm sync`

## Documentation

- `docs/sop.md` -- Standard Operating Procedure
- `docs/protocol.md` -- Label state machine, structured handoffs
- `docs/DEPLOYMENT.md` -- Staging, promotion, OTA updates
- `docs/CICD.md` -- CI/CD pipeline design
