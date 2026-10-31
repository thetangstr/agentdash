---
name: agentdash-internal-box
description: >
  Set up an internal AgentDash cloud box (purpose internal) and move a company
  into it with scripts/hosted/internal-box.mjs: preflight, create, claim,
  move-company, configure, status. Use when asked to "make an internal box",
  "spin up a box for us", "move <company> to a hosted box", "put our company on
  the cloud", or to check or resume one of those steps. Do NOT use for customer
  boxes (the tool refuses them), for upgrading a box (admin boxes upgrade), or
  for deleting one.
---

# Internal AgentDash box

The runbook is `doc/runbooks/internal-box.md`. Read its sections 2 (the command sequence), 4 (resuming) and 8 (what the tool never does) before the first command.

## When to use it

- Someone asks for an internal box, a box for the team, or to move a company from an AgentDash instance (a laptop, the mini, the old shared instance) onto a hosted box.
- A previous run of the tool stopped and you are asked to finish it.

## How

From a repository checkout with `pnpm install` done, on the founder's Mac:

```sh
I="node scripts/hosted/internal-box.mjs"
$I preflight --release <tag> --provider <zai|openrouter|anthropic|openai> --from https://<source>
$I create <slug> --email <founder email> --release <tag>
$I claim <slug> --name "<founder name>" --email <founder email>
$I move-company --from https://<source> --to <slug> --company "<name or id>"          # dry run: read the plan
$I move-company --from https://<source> --to <slug> --company "<name or id>" --apply
$I configure <slug> --provider <name>
$I status <slug>
```

Add `--json` when you parse the output (`ok`, `steps`, `warnings`, `result`, `error.fix`).

## Rules

- Run `preflight` first and stop on any `[FAIL]`: its `fix:` lines are founder setup (Keychain items, the allow-list, `railway login`), not things to work around. Hand them to the founder; never ask for a secret in chat and never put one on a command line. The tool refuses secret-looking flags.
- Every step is safe to re-run with the same arguments; on failure, follow the printed `fix:` and re-run the same command (runbook §4).
- Show the founder the `move-company` dry run (the Hermes plan and the goal gap) before `--apply`. Goals do not move; say so.
- `claim` can wait up to 15 minutes for the control plane's claim sweep; that is normal. Use `--no-wait` and re-run later if needed.
- Never run `provision-box.sh` against a box this tool created, never touch a box whose purpose is not `internal`, and never delete a box. Abandoning one is `pnpm --filter @agentdash/cloud-control admin boxes abandon <slug>`, a founder decision (runbook §6).
- Report the box address, the founder email, the Keychain item name, the verification lines and any gap. Never report the password, the claim code or any key.
