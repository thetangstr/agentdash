---
title: Control-plane commands
summary: Operator CLI client commands for issues, agents, approvals, companies, activity, the dashboard and heartbeats
---

Client commands call the HTTP API of a running instance. Run them from a checkout as `pnpm paperclipai <command>`. Each takes the client options from the [CLI overview](/cli/overview) (`--api-base`, `--api-key`, `--context`, `--profile`, `--json`). Source: `cli/src/commands/client/`, `cli/src/commands/heartbeat-run.ts`.

`-C, --company-id <id>` is required where shown. Where it is optional, the company comes from the context profile.

## Issues

```sh
# List (company from -C or the context profile)
pnpm paperclipai issue list [-C <company-id>] [--status todo,in_progress] [--assignee-agent-id <id>] [--project-id <id>] [--match <text>]

# Get by id or identifier
pnpm paperclipai issue get <issue-id-or-identifier>

# Create
pnpm paperclipai issue create -C <company-id> --title "..." [--description "..."] [--status todo] [--priority high] \
  [--assignee-agent-id <id>] [--project-id <id>] [--goal-id <id>] [--parent-id <id>]

# Update
pnpm paperclipai issue update <issue-id> [--title "..."] [--status in_progress] [--priority <p>] \
  [--assignee-agent-id <id>] [--comment "..."]

# Comment
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen] [--resume]

# Check out for an agent, and release
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm paperclipai issue release <issue-id>
```

`--match` filters locally on identifier, title and description. `release` puts the issue back to `todo` and clears the assignee.

## Agents

```sh
pnpm paperclipai agent list -C <company-id>
pnpm paperclipai agent get <agent-id>

# Run as an agent by hand: creates an agent API key, installs the repo's skills
# into ~/.codex/skills and ~/.claude/skills, and prints shell exports
pnpm paperclipai agent local-cli <agent-id-or-shortname> -C <company-id> [--key-name <label>] [--no-install-skills]
```

## Approvals

```sh
pnpm paperclipai approval list -C <company-id> [--status pending]
pnpm paperclipai approval get <approval-id>

pnpm paperclipai approval create -C <company-id> --type hire_agent --payload '{"name":"..."}' \
  [--requested-by-agent-id <id>] [--issue-ids <id1,id2>]

pnpm paperclipai approval approve <approval-id> [--decision-note "..."]
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]
pnpm paperclipai approval resubmit <approval-id> [--payload '{"...": "..."}']
pnpm paperclipai approval comment <approval-id> --body "..."
```

`--type` takes `hire_agent` or `approve_ceo_strategy`.

## Companies

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>

# Export to a folder package
pnpm paperclipai company export <company-id> --out ./exports/my-company --include company,agents

# Preview an import without writing
pnpm paperclipai company import <path-or-url> --target existing -C <company-id> --collision rename --dry-run

# Import into a new company
pnpm paperclipai company import ./exports/my-company --target new --new-company-name "Imported" --include company,agents

# Delete (destructive; both safety flags are required)
pnpm paperclipai company delete <company-id-or-prefix> --yes --confirm <company-id-or-prefix>
```

`--include` takes any of `company`, `agents`, `projects`, `issues`, `tasks`, `skills`. `--collision` is `rename` (default), `skip` or `replace`. A GitHub source takes `--ref <branch|tag|commit>`.

## Activity

```sh
pnpm paperclipai activity list -C <company-id> [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm paperclipai dashboard get -C <company-id>
```

## Heartbeat

Run one heartbeat for an agent and stream its log:

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] \
  [--source on_demand] [--trigger manual] [--timeout-ms <ms>] [--debug]
```

`--source` is `timer`, `assignment`, `on_demand` (default) or `automation`. See [Heartbeats and runs](/concepts/heartbeats-and-runs).

## Other command groups

| Group | What it does |
|---|---|
| `context` | Manage CLI context profiles. See the [CLI overview](/cli/overview#context-profiles). |
| `auth login`, `auth logout`, `auth whoami` | Board-user sign-in for the CLI |
| `plugin` | List, install, enable, disable, inspect and uninstall instance plugins |
| `routines disable-all` | Local routine maintenance |
| `feedback report`, `feedback export` | Inspect and export feedback traces |
| `worktree` | Helpers for an instance per git worktree |
| `env-lab` | Local test environment fixtures |
| `bridge run`, `bridge inbox`, `bridge inbox-init` | The local bridge worker (macOS only) and the steward inbox reader. Most people use [agentdash-connect](/cli/agentdash-connect) instead. |

Run `pnpm paperclipai <group> --help` for the flags.
