# Multi-Agent Workflow

This repository now includes the Multi-Agent Workflow command set from `thetangstr/Multi-Agent-Workflow`, adapted to AgentDash conventions.

## Installed Paths

- Slash commands: `.claude/commands/`
- Workflow docs: `doc/multi-agent-workflow/`
- Test-plan template: `doc/multi-agent-workflow/templates/test-plan-template.md`

## Repo Defaults

- Base branch: `agentdash-main`
- Linear issue prefix: `PAP`
- Local test URL: `http://localhost:3100`
- Local dev command: `pnpm dev`

## Required Manual Setup

Some environment-specific values are intentionally left explicit rather than guessed. Replace these placeholders before relying on staging or production steps:

- `TODO_SET_PRODUCTION_URL`
- `TODO_SET_STAGING_URL`
- `TODO_SET_BACKEND_PROD_URL`
- `TODO_SET_BACKEND_STAGING_URL`
- `TODO_SET_TEST_USER_EMAIL`
- `TODO_SET_TEST_USER_PASSWORD`

If your Linear team name is not `PAP`, update the `team:` examples in the command docs.

## Primary Commands

- `/workon PAP-123`: run the full PM -> Builder -> Tester flow for one issue
- `/builder PAP-123`: jump directly to implementation
- `/tester PAP-123`: run the testing workflow for an issue/PR
- `/tpm sync`: ship `Human-Verified` work to `agentdash-main`
- `/admin health`: run environment health checks

## Labels To Create In Linear

- Workflow: `PR-Ready`, `Testing`, `Tests-Passed`, `Tests-Failed`, `Locally-Tested`, `Staging-Tested`, `Human-Verified`, `Prod-Smoke-Passed`, `In-Production`
- Size: `XS`, `S`, `M`, `L`, `XL`
- Optional: `staging-required`, `PM-Validated`, `Builder-Ready`

## References

- Operator guide: `doc/multi-agent-workflow/sop.md`
- Handoff contract: `doc/multi-agent-workflow/protocol.md`
- Epic/CUJ template: `doc/multi-agent-workflow/EPIC_REGISTRY.md`
- Manual verification template: `doc/multi-agent-workflow/MANUAL_TESTING_GUIDE.md`
