---
title: Importing and Exporting Companies
summary: Export a company to a portable markdown package, and import one from a zip, a local folder or a public GitHub repo
---

You can export a company to a folder of markdown files and import it again — into a new company or an existing one. Use it to copy a setup, keep an agent team in version control, or start from a template.

Two ways in: the web UI (**Company Settings → Export** / **Import**, also linked from the Org Chart) and the CLI (`pnpm paperclipai company ...` from a clone of [the repo](https://github.com/thetangstr/agentdash)). They do not behave identically — see [UI or CLI](#ui-or-cli).

Source: `server/src/services/company-portability.ts`, `server/src/routes/companies.ts`, `cli/src/commands/client/company.ts`, `ui/src/pages/CompanyExport.tsx`, `ui/src/pages/CompanyImport.tsx`.

## What a package contains

```text
my-company/
├── COMPANY.md              # name, description
├── README.md               # generated
├── images/org-chart.png    # generated
├── agents/<slug>/AGENTS.md # each agent's instructions, plus the rest of its instruction bundle
├── projects/<slug>/PROJECT.md
├── tasks/<slug>/TASK.md    # issues, and routines (marked recurring: true)
├── skills/...              # company skills, namespaced, e.g. skills/company/<prefix>/<slug>/SKILL.md
└── .paperclip.yaml         # adapter type and config, budgets, env inputs, routines
```

What is left out or changed on export:

- Env values bound to a secret, and values under key names that look sensitive (containing `token`, `secret`, `password` and similar), are blanked. **A plain value under any other key name is exported.** Check `.paperclip.yaml` before you share a package.
- `cwd`, instruction paths, `PATH` and absolute `command` values are stripped. Other absolute paths in env defaults are kept and marked `system_dependent`.
- A project workspace without a portable repo URL is dropped, and setup or cleanup commands with absolute paths are dropped.
- Issue label IDs are exported and re-applied on import.

On import, every agent lands with **timer heartbeats off**. Wake-on-assignment and on-demand settings are kept. Turn schedules back on yourself.

## Export

**UI.** Open **Company Settings → Export**. The page previews the package as a file tree with checkboxes, a search box and a preview pane. Issues are unchecked by default; routines stay checked. **Export N files** downloads a zip.

**CLI.**

```sh
pnpm paperclipai company export <company-id> --out ./my-export
```

| Option | What it does | Default |
| --- | --- | --- |
| `--out <path>` | Output folder (required). Asks before overwriting a non-empty folder; fails if not on a terminal | — |
| `--include <values>` | Any of `company`, `agents`, `projects`, `issues` (`tasks` is an alias), `skills` | `company,agents` |
| `--skills <values>` | Only these skill slugs | all |
| `--projects <values>` | Only these project shortnames or IDs | all |
| `--issues <values>` | These issue identifiers or IDs | none |
| `--project-issues <values>` | Issues in these projects | none |
| `--expand-referenced-skills` | Copy skill file contents instead of keeping references | off |

Company skills are exported whenever agents are, so the default already includes them. `--include issues` with no selector exports every issue and routine.

## Import

**UI.** Open **Company Settings → Import**.

1. Source: **GitHub repo** (a URL) or **Local zip** (a zip this export produced; a re-zipped folder may fail).
2. Target: **Create new company** (name optional) or the current company.
3. Collision: **Rename**, **Skip** or **Replace**.
4. **Preview import**. You get the file tree, every conflict (rename, skip or confirm each one), and an adapter picker per agent.
5. **Import N files**.

**CLI.**

```sh
pnpm paperclipai company import ./my-export                       # local folder or .zip
pnpm paperclipai company import https://github.com/org/repo       # GitHub URL (/tree/ and /blob/ work)
pnpm paperclipai company import org/repo/path/to/company          # GitHub shorthand
```

| Option | What it does | Default |
| --- | --- | --- |
| `--target <mode>` | `new` or `existing` | `existing` when a company ID is given or in context, else `new` |
| `-C, --company-id <id>` | Company for `--target existing` | current context |
| `--new-company-name <name>` | Name for `--target new` | from the package |
| `--include <values>` | `company`, `agents`, `projects`, `issues`, `skills` | everything the package has |
| `--agents <list>` | Agent slugs, or `all` | `all` |
| `--collision <mode>` | `rename`, `skip` or `replace` | `rename` |
| `--ref <value>` | Branch, tag or commit for GitHub sources. Not allowed for local sources | `main` |
| `--dry-run` | Show the preview, apply nothing | off |
| `--yes` | Skip the confirmation | off |
| `--json` | JSON output. Applying with `--json` also needs `--yes` | off |

Run interactively without `--yes`, `--json` or `--include`, the CLI shows a picker for company metadata, agents, projects, skills and tasks.

`--ref` defaults to `main`, not the repo's default branch. Pass `--ref` for a repo whose default branch is named something else.

The preview lists package counts, the plan (create, update, skip — a rename shows as a create under the new name), how many env inputs need values, and any errors, warnings and info.

### Collisions

- **rename** — the new item gets a suffix: an agent "CEO" becomes "CEO 2", slug `ceo-2`. Projects work the same way.
- **skip** — items that already exist are left alone.
- **replace** — overwrites existing items.

Issues are always created new, whatever the mode.

## UI or CLI

The CLI sends imports into an existing company to the **safe** routes. Those allow only create and skip: `replace` is refused with `403`, and agents using the `process` or `http` adapter are refused (the CLI maps `process` agents to `claude_local` first). The UI always uses the full routes. So **replace into an existing company works only from the UI.**

A full import into an existing company with `company` included overwrites the company's name and description, and always overwrites matching skills.

## Who may do it

- Importing into a **new** company needs an instance admin.
- An import that sets an adapter's command, arguments, env or working directory also needs an instance admin.
- A CEO agent may use the safe routes for its own company.

GitHub sources must be public: the server fetches them without a token. Other HTTP URLs are rejected. Every import is recorded in the [activity log](/guides/board-operator/activity-log) as `company.imported`.

## API

| Action | Endpoint |
| --- | --- |
| Export (CLI) | `POST /api/companies/{companyId}/export` |
| Export preview (UI) | `POST /api/companies/{companyId}/exports/preview` |
| Export download (UI) | `POST /api/companies/{companyId}/exports` |
| Preview import, full | `POST /api/companies/import/preview` |
| Apply import, full | `POST /api/companies/import` |
| Preview import, safe | `POST /api/companies/{companyId}/imports/preview` |
| Apply import, safe | `POST /api/companies/{companyId}/imports/apply` |

These are internal routes, not part of the API contract. See the [route index](/api/route-index).
