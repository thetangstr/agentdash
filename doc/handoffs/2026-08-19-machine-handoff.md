# AgentDash — handoff to a new working machine

Written 2026-08-19. Paste this into a fresh session on the new machine; it is
meant to be read top to bottom once, then used as a reference.

## What you are working on

AgentDash is a fork of [Paperclip](https://github.com/paperclipai/paperclip)
that orchestrates AI agents for autonomous companies. One customer is live:
**MKThink**, running on-prem on a Mac Mini. Their Chief of Staff agent is
**Casper**, and its steward — the human it answers to — is **Titus** (email in
the access notes on the Mini; deliberately not written here).

**GitHub is the source of truth.** `git clone https://github.com/thetangstr/agentdash.git`
and you are current. A fresh clone can install from the committed lockfile as of
`b1ebddf22`; before that it could not, so if `pnpm install --frozen-lockfile`
ever fails again with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, the lockfile has
drifted and needs a refresh (see "The lockfile" below).

## The live deployment, in one screen

| | |
|---|---|
| Machine | Mac Mini, hostname `mkmini.local`, reachable over Tailscale |
| Checkout | `/Users/yang/agentdash`, running the repo directly through `tsx` |
| Supervision | launchd **system** daemons only (`/Library/LaunchDaemons/com.agentdash.*`) |
| App port | `127.0.0.1:3102` |
| Public URL | `https://mkthinks-mac-mini.tail112187.ts.net:3112` — Caddy terminates TLS on 3112 and proxies to 3102 |
| LAN alternative | `https://mkmini.local:3112` (self-signed cert) |
| Instance | `mkboard`; env at `~/.config/agentdash/mkboard.env` (43 keys) |
| Database | embedded Postgres, `127.0.0.1:54329`, database `mkboard` |
| Runtimes | node v24.18.1, pnpm 9.15.4, codex-cli 0.147.0, Hermes Agent v0.20.0 |

Health: `curl -fsS http://127.0.0.1:3102/api/health` and the same path on the
public URL. Both should be `200` with `status: ok`.

## Which address to use, and why it matters

Three addresses reach the same instance and they are not interchangeable:

- **`https://mkthinks-mac-mini.tail112187.ts.net:3112`** — anything sent to a
  person: invite links, the board, harness connection. The only host with a
  publicly-trusted certificate, which is what MDM-managed Macs require.
- **`https://mkmini.local:3112`** — LAN convenience, self-signed.
- **`http://127.0.0.1:3102`** — commands run on the Mini itself.

Sign-in checks the browser's origin against the configured public URL. A page
served from any other address is refused with `403 INVALID_ORIGIN`. This cost a
day in August 2026 because startup rewrote the public URL's port to the app's;
fixed in #483, and the rule now is that `:3112` is Caddy and `:3102` is the
application.

## Deploying: over the air, not `git pull`

```sh
# Is the box behind GitHub? Changes nothing.
node ~/.agentdash/bin/agentdash-source-update.mjs --check

# Apply whatever origin/main points at.
node ~/.agentdash/bin/agentdash-source-update.mjs \
  --backup-command "AGENTDASH_INSTANCE=mkboard /bin/sh ~/agentdash/deploy/agentdash-backup.sh"

# Return to the commit that was running before.
node ~/.agentdash/bin/agentdash-source-update.mjs --rollback --backup-command "…"
```

It backs up, detaches to the target commit, installs, builds, restarts,
proves `/api/health`, and rolls back to the exact previous commit if health does
not return. Receipts land in `~/.agentdash/deployments/receipts/`. Six real
cycles including one genuine backwards rollback are recorded there.

Three things about it are deliberate and worth not undoing:

- **Run it from `~/.agentdash/bin/`, never from the checkout.** The updater lives
  inside what it updates; the first rollback attempt died with
  `MODULE_NOT_FOUND` because the update before it had checked out a commit where
  the script did not exist yet. A successful update refreshes that standalone
  copy.
- **It detaches to a commit** rather than fast-forwarding a branch, because a
  rollback goes backwards and a fast-forward cannot.
- **It refuses a dirty tree and refuses to update without a backup.** Both
  refusals have already saved a run. `pnpm-lock.yaml` is the usual thing making
  the tree dirty; restore it with `git checkout -- pnpm-lock.yaml`.

A scheduled job (`com.agentdash.update`, 09:15 daily) reports whether the box is
behind and **changes nothing**. Yang's decision, 2026-08-19: leave it in
check-only mode. To let it deploy unattended, set `AGENTDASH_UPDATE_APPLY=1` in
the instance env file.

## Restarting

`launchctl kickstart` on a system daemon needs a password an SSH session does not
have. The daemons carry `KeepAlive => true`, so this is a complete restart and
launchd respawns in ~10s:

```sh
pid=$(lsof -nP -iTCP:3102 -sTCP:LISTEN -t | head -1)
kill -9 "$pid" "$(ps -o ppid= -p "$pid" | tr -d ' ')"
```

Kill the parent too. Killing only the listener leaves the pnpm wrapper alive and
launchd believes the job is still running while the port sits silent.

**One supervisor per service.** Everything is a system daemon; the user
LaunchAgents are renamed `*.plist.disabled`. Two supervisors once produced two
mkboard servers where the loser of the port race answered `/api/health` with
`status: ok` and served nobody, because Caddy proxies only 3102. If a restart
looks wrong, count listeners first: `lsof -nP -iTCP -sTCP:LISTEN | grep -E '310[0-9]'`
— expect exactly one.

## Agents and adapters

Casper runs on **`codex_local`** with model **`gpt-5.6-terra`** and
`CODEX_HOME=/Users/yang/.codex` in its per-agent `adapterConfig.env`. The
instance default is `AGENTDASH_DEFAULT_ADAPTER=codex_local`.

Traps that cost real time:

- **That env var drives two different things**: which adapter new agents get,
  *and* which adapter answers Chief-of-Staff chat through `dispatchLLM`. Flipping
  it to `codex_local` before the chat path supported Codex broke the customer's
  chat with `501 not supported for CoS chat dispatch`. Both work now (#503), but
  remember it is two knobs behind one variable.
- **A ChatGPT-account Codex login rejects the `-codex` models** outright ("not
  supported when using Codex with a ChatGPT account"). Terra and Sol work.
  `gpt-5.6-codex` does not.
- **`CODEX_HOME` must be set explicitly.** The agent sandbox gives children a
  synthetic `HOME`, so Codex otherwise finds no credentials and returns 401 with
  no bearer — while the preflight, which reads the *server's* home, reports the
  agent as authenticated.
- **Chat replies run `codex exec --sandbox read-only`.** Agent runs bypass the
  sandbox on purpose; a chat reply must not, because its prompt carries other
  agents' output that the system wraps in `<untrusted-agent-answer>`.
- **A new agent with no `runtimeConfig.heartbeat.enabled` never runs** and shows
  as `idle`. The agents page now marks these "Not scheduled" (#495). This is why
  mkboard recorded zero runs for days.
- **Hermes' `--usage-file` is a dead end.** It is documented one-shot-only and
  this adapter runs `chat`; Hermes exits with `unrecognized arguments`. Token
  metering reads Hermes' own ledger instead: `session_model_usage` in
  `~/.hermes/state.db` (#486).

## Metering

Token counts are recorded per agent, model, provider and biller, visible at
`/api/companies/:id/costs/by-agent` and `by-agent-model`. **Cost is deliberately
empty**: Yang's decision, 2026-08-19 — tokens against usage, no dollars, because
Hermes reports `cost_status: unknown` for MiniMax and a sourced-from-nowhere
number is worse than a blank. #493 closed with that reasoning.

## Working in the repo

```sh
pnpm install                     # --frozen-lockfile works as of b1ebddf22
pnpm typecheck
pnpm test:run                    # 881 test files; honours SHARD_INDEX/SHARD_COUNT
npx vitest run <path>            # from the owning package dir
node --test scripts/**/*.test.mjs  # the scripts/ suites use node:test, not vitest
```

**Every PR body must pass** `node scripts/ci/check-pr-process.mjs --body-file <file>`
before you open the PR. It requires exactly these `##` sections: Thinking Path
(three or more `> -` blockquoted bullets), What Changed, Verification, Risks,
AgentDash Review (three named lines, each with a real reason), Model Used
(`Provider:` and `Model:` lines), Checklist. No `[bracketed]` placeholders, no
"TBD"/"TODO". Writing the body first and validating it locally saves a CI round
trip.

CI is a four-way matrix (`verify-shard`) plus a parallel `verify-build`, with
`verify` as an aggregate job. **Branch protection requires the context named
`verify`** — if the matrix is ever renamed, merges silently stop being gated.
`enforce_admins: true`, so nothing can be forced through by anyone. Wall clock
is about 8 minutes.

Two known-flaky things: `rate-limit.test.ts` and
`heartbeat-comment-wake-batching.test.ts` fail under full-suite contention and
pass in isolation. And the `e2e` lane sometimes dies at "Install Playwright
system dependencies" with an apt error on the runner — that is infrastructure,
not your change; check whether any tests actually ran before believing it.

## The lockfile

Feature branches do **not** commit `pnpm-lock.yaml`; `.github/workflows/refresh-lockfile.yml`
owns it. That workflow's PRs used to fail the body policy and could never merge,
so the lockfile drifted until `main` could not install from it (#507 fixed the
body; #481 landed the refresh).

**Open issue for you:** the refresh bot's workflow runs land at
`action_required`, so its checks never execute. Until that GitHub Actions
approval setting is changed, each refresh needs a human to regenerate and push:

```sh
git worktree add /tmp/lockrefresh -B chore/refresh-lockfile origin/main
cd /tmp/lockrefresh && pnpm install --lockfile-only --no-frozen-lockfile
git commit -am "chore(lockfile): refresh pnpm-lock.yaml"
git push --force-with-lease origin chore/refresh-lockfile
```

## Access

- **Board admin**: `thetangstr@gmail.com` (admin on MKThink). The password was
  generated by `deploy/set-password.mjs` and is in the 2026-08-19 session
  transcript; it is deliberately not written here, since this file goes to
  GitHub. Reset with `node deploy/set-password.mjs mkboard <email>` on the Mini.
- **Titus** is also admin. Their board login is their MKThink work email — the
  address is in the access notes on the Mini, kept out of this file for the
  same reason as the password.
- **MCP from a harness**: the board's "Connect your harness" panel builds the
  snippet from whatever URL you opened it at, so it is always correct. On the
  Mini itself, Claude Code and Codex are both paired to
  `http://127.0.0.1:3102/api/mcp`; the Codex key is named `Codex CLI — mkmini`.
- **Sudo on the Mini requires a password** — no non-interactive sudo. Anything
  needing root has to be handed to Yang as a `!`-prefixed command.

## Open, and genuinely undecided

- **#505** — any agent can read every member's email via `/user-directory`,
  which guards on company access alone. Measured with Casper's own key, not
  theoretical. Yang's answer on 2026-08-19: not yet. Three options are in the
  issue; the decision matters more at the second customer than at MKThink, where
  the two members already have each other's email.
- **#449-adjacent hygiene**: #450 (cross-company reads in `local_trusted` mode,
  which MKThink does not run), #347, #346, #297, #215, #171, and a five-issue
  lead-capture epic on the back burner.
- **Nine stale PRs** from May and June — connectors, billing ledger, attestation.
  #395 (run ledger + monthly receipt) overlaps the metering that now works and
  should be either rebased on it or closed. Three months of drift sit under all
  of them.

## What is deliberately absent from GitHub

Secrets and machine state: `~/.config/agentdash/*.env` (licence key, JWT secret,
MiniMax and GitHub tokens), `~/.agentdash/agentdash.key`, `~/.codex/auth.json`,
and the installed launchd plists. The *shapes* of the settings — sandbox
allow-list, `AGENTDASH_CODEX_COMMAND`, `CODEX_HOME`,
`AGENTDASH_HERMES_STATE_DB` — are documented in
`doc/customers/mkthink/agentdash.env.template`, so a new machine can reconstruct
the configuration without guessing.

One local branch is deliberately not pushed:
`backup/pre-sanitize-2026-08-15`, a safety copy of history from before secrets
were scrubbed. Its content is in `main` in sanitised form. Do not push it.
