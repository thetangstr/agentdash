---
title: Writing a Skill
summary: The SKILL.md format, how a company's skills reach an agent's runtime, and how to write one that works
---

A skill is a reusable set of instructions an agent loads when its task calls for it. It is a folder with a `SKILL.md` file. A company keeps its skills in **Settings → Agents → Skills**, and adapters make them available to each agent's runtime.

Source: `server/src/routes/company-skills.ts`, `server/src/services/company-skills.ts`, `packages/adapters/claude-local/src/server/prompt-cache.ts`, `packages/adapters/codex-local/src/server/execute.ts`.

## Structure

```
my-skill/
├── SKILL.md          # the skill
└── references/       # optional supporting files
    └── examples.md
```

## SKILL.md

```markdown
---
name: my-skill
description: >
  What this skill does and when to use it. The agent reads this
  to decide whether to load the rest, so write it as a decision.
---

# My Skill

Instructions for the agent...
```

- **name** — a unique, kebab-case identifier.
- **description** — when to use it, and when not to. This is routing logic, not marketing.

## At runtime

1. The agent sees each skill's name and description.
2. It decides whether a skill fits the task.
3. If so, it loads the full `SKILL.md`.
4. It follows it.

Only the metadata sits in the base prompt; the full text loads on demand.

## Add a skill to the company

**Settings → Agents → Skills** lists the company's skills. You can create one there, import one, or scan the company's project workspaces for skills. The matching routes are under `/api/companies/{companyId}/skills` (`POST`, `POST .../import`, `POST .../scan-projects`); see the [route index](/api/route-index).

Company skills travel with a company export. See [Importing and exporting](/guides/board-operator/importing-and-exporting).

## How adapters inject skills

- **`claude_local`** links the agent's skills into a `.claude/skills` folder under a content-hashed cache directory (under `~/.paperclip/instances/<instance>/companies/<companyId>/`) and passes that directory to Claude Code with `--add-dir`.
- **`codex_local`** links them into `$CODEX_HOME/skills`. By default `CODEX_HOME` is a per-company managed home under `~/.paperclip/instances/<instance>/companies/<companyId>/codex-home`, not your global `~/.codex`.

Other adapters do their own thing; see [Creating an adapter](/adapters/creating-an-adapter).

## Write one that works

- **Make the description a decision** — include "use when" and "do not use when".
- **Be specific.** An agent should be able to follow it without guessing.
- **Show commands and API calls.** They work better than prose.
- **One concern per skill.**
- **Put detail in `references/`**, not in a long `SKILL.md`.
