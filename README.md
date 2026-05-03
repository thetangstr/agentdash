# AgentDash

**A CoS-led, multi-human AI workspace.** Type a request to your Chief of Staff, the CoS routes work to the right agent, multiple humans on the same workspace see the same thread.

Built on [paperclipai/paperclip](https://github.com/paperclipai/paperclip).

---

## Get started

One command, three prompts.

```sh
curl -fsSL https://raw.githubusercontent.com/thetangstr/agentdash/main/scripts/bootstrap.sh | bash
```

That clones AgentDash to `~/agentdash`, installs deps, links the `agentdash` CLI onto your PATH, and runs the setup wizard. The wizard asks:

1. **Pick an adapter** — Claude Code / Codex / Hermes / Cursor / … Runs `<adapter> --version` to verify it's installed; prints the install command if not.
2. **Your email** — founding user / workspace owner.
3. **Start setting up the agents now?** — press Enter to boot the dev server. You land in your Chief of Staff at <http://localhost:3100/cos>.

Requires Node 20+, pnpm, and git. Set `ANTHROPIC_API_KEY` in the shell beforehand for real Claude replies (otherwise you get a stub). Everything else (embedded Postgres, local storage, local-encrypted secrets, loopback bind, `local_trusted` mode) uses safe defaults.

To re-run later: `agentdash setup` (or `agentdash setup adapter` / `setup server` / `setup bootstrap` for one section).

---

### Already cloned the repo?

```sh
pnpm install && pnpm install-cli && agentdash setup
```

`pnpm install-cli` symlinks `agentdash` into `/usr/local/bin`, `/opt/homebrew/bin`, or `~/.local/bin` (whichever is writable). The wizard's last step offers to start the server; if you skip it, run `pnpm dev` from the repo root.

### Going to production

The flow above runs in `local_trusted` mode — no auth, no billing, single user. To deploy AgentDash with real auth, real Stripe, and real Claude, see **[doc/LAUNCH.md](doc/LAUNCH.md)**: the dependency-ordered checklist from clean clone to first paying customer.

---

## About this fork

AgentDash is a fork of Paperclip. We use Paperclip's main agent harness (heartbeats, adapters, plugin SDK) and layer five named features on top: a UI redesign with Claude design system, the `/assess` agent-readiness flow, a CoS-led onboarding flow, Free + Pro per-seat billing with a Stripe trial, and a multi-human + CoS chat substrate (typed cards, `@`-mention summons, WebSocket bus).

We **don't** carry forward upstream's CRM, HubSpot stub, AutoResearch stub, Action Proposals + Policy Engine, Pipeline Orchestrator, Budget+Capacity, Skills Registry workflow, or Smart Model Routing. See [doc/UPSTREAM-POLICY.md](doc/UPSTREAM-POLICY.md) for the cherry-pick rubric — we don't bulk-merge upstream.

For Paperclip's product story, see the [upstream README](https://github.com/paperclipai/paperclip) and [doc/PRODUCT.md](doc/PRODUCT.md).

---

## Reference

### Project layout

Monorepo (pnpm workspaces). AgentDash-specific code is tagged with `// AgentDash:` comments.

| Layer | Tech | Entry |
|---|---|---|
| API server | Express 5, WebSocket | [server/src/index.ts](server/src/index.ts) |
| Dashboard UI | React 19, Vite, Tailwind 4 | [ui/src/main.tsx](ui/src/main.tsx) |
| Marketing UI | React, cream/light theme | [ui/src/marketing/](ui/src/marketing/) |
| CLI | Commander, esbuild | [cli/src/index.ts](cli/src/index.ts) |
| Database | PostgreSQL, Drizzle ORM | [packages/db/src/schema/](packages/db/src/schema/) |
| Shared types | Zod validators, constants | [packages/shared/src/](packages/shared/src/) |
| Agent adapters | Claude, Codex, Cursor, Gemini, Pi, OpenCode, OpenClaw, Hermes | [packages/adapters/](packages/adapters/) |
| Plugins | JSON-RPC workers, event bus | [packages/plugins/](packages/plugins/) |

### Common commands

```sh
pnpm dev                  # server + UI with watching (localhost:3100)
pnpm dev:once             # without watching
pnpm -r typecheck         # type-check all packages
pnpm test:run             # run all tests once
pnpm build                # build server + UI + CLI
pnpm db:generate          # generate migration after schema change
pnpm db:migrate           # apply pending migrations

# E2E
pnpm exec playwright test --config tests/e2e/playwright-multiuser.config.ts
pnpm exec playwright test --config tests/e2e/playwright-multiuser-authenticated.config.ts
```

Run the regression suite before any handoff: `pnpm -r typecheck && pnpm test:run && pnpm build`.

### Docs

| Doc | What it covers |
|---|---|
| [doc/LAUNCH.md](doc/LAUNCH.md) | Step-by-step from clean clone to first paying customer |
| [doc/UPSTREAM-POLICY.md](doc/UPSTREAM-POLICY.md) | Cherry-pick rubric for upstream paperclip commits |
| [doc/DEVELOPING.md](doc/DEVELOPING.md) | Detailed dev guide |
| [docs/superpowers/specs/](docs/superpowers/specs/) | Per-sub-project design specs |
| [.claude/commands/](.claude/commands/) | MAW slash commands (PM, Builder, Tester, TPM, Admin) |
| [CLAUDE.md](CLAUDE.md) | Codebase entry point for AI coding assistants |

---

## License

MIT, same as upstream. See [LICENSE](LICENSE).

Built on [Paperclip](https://github.com/paperclipai/paperclip) — credit and thanks to the Paperclip team for the agent harness AgentDash is built on.
