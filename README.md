# AgentDash

**A CoS-led, multi-human AI workspace.** AgentDash is what happens when you take an autonomous-agent harness and front it with a Chief of Staff a real operator can talk to: type a request, the CoS routes work to the right agent, multiple humans on the same workspace see the same thread.

---

## About this fork

AgentDash is a fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip), built on Paperclip's main agent harness — heartbeats, adapters, the agent execution loop, and the plugin SDK come from upstream and stay close to it.

We layer five things on top:

1. **UI redesign** with the Claude design system — editorial marketing landing at `/`, cream/light surface for marketing pages, dark dashboard for the operator workspace, full AgentDash branding.
2. **Assess + agent research** — `/assess` flow that runs a four-step company-wide readiness scan or a project-scoped assessment that produces a downloadable Word doc.
3. **Onboarding (rescoped)** — sign-up → CoS chat (`/cos`) → first agent hire → invite teammates. Replaces v1's WelcomePage wizard.
4. **Subscription + billing** — Free + Pro per-seat tiers with a 14-day no-card Stripe trial. Free workspaces are capped at 1 human + 1 agent (the CoS); Pro is unlimited.
5. **Multi-human + CoS chat substrate** — typed conversation cards, `@`-mention summons, a WebSocket bus so multiple humans on the same workspace see the same thread in real time.

We **do not** carry forward upstream's CRM, HubSpot stub, AutoResearch stub, Action Proposals + Policy Engine, Pipeline Orchestrator, Budget+Capacity, Skills Registry workflow, or Smart Model Routing. See [doc/UPSTREAM-POLICY.md](doc/UPSTREAM-POLICY.md) for the full rubric — we don't bulk-merge upstream; we cherry-pick when there's a specific reason.

For Paperclip's own product story, agent-runtime docs, and adapter authoring guides, see the [upstream README](https://github.com/paperclipai/paperclip) and [doc/PRODUCT.md](doc/PRODUCT.md).

---

## Quickstart (local dev)

```sh
git clone https://github.com/thetangstr/agentdash.git
cd agentdash
pnpm install
pnpm dev
```

Open <http://localhost:3100/cos> — the CoS chat is ready, no sign-up needed. AgentDash bootstraps a workspace + Chief of Staff agent on first run via `local_trusted` mode.

```sh
# Optional: name your workspace properly (defaults to "AgentDash Workspace")
export AGENTDASH_BOOTSTRAP_EMAIL=you@yourdomain.com

# Optional: real Claude replies on /cos (otherwise you get a stub)
export ANTHROPIC_API_KEY=sk-ant-…

pnpm dev
```

To exercise billing-gated flows (invites, agent hires) without wiring Stripe:

```sh
# Caps bypass when STRIPE_SECRET_KEY is unset, OR explicitly:
export AGENTDASH_BILLING_DISABLED=true
pnpm dev
```

When `STRIPE_SECRET_KEY` is set in production, the Free / Pro caps enforce as designed (Free: 1 human + 1 agent; Pro: unlimited). The bypass is dev-only.

---

## Going to production

[doc/LAUNCH.md](doc/LAUNCH.md) is the dependency-ordered checklist from a clean clone to first paying customer:

1. Pick a cloud host (Railway / Fly.io / Render) and provision Postgres
2. Set deployment-mode env vars — `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `PAPERCLIP_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `PAPERCLIP_MIGRATION_AUTO_APPLY=true`
3. Set up Stripe — Product, Price, Webhook endpoint at `/api/billing/webhook`, copy the 5 `STRIPE_*` keys + `BILLING_PUBLIC_BASE_URL`
4. Set `ANTHROPIC_API_KEY` for real CoS replies
5. Deploy + 6-step smoke test (landing → signup → CoS chat → checkout → webhook fires → `planTier` flips to `pro_trial`)

Nine env vars and a Postgres connection string are everything required to launch.

---

## Project layout

Monorepo (pnpm workspaces). The interesting AgentDash-specific code is marked with `// AgentDash:` comments throughout.

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

---

## Common commands

```sh
pnpm dev                           # server + UI with file watching (localhost:3100)
pnpm dev:once                      # without watching
pnpm -r typecheck                  # type-check all packages
pnpm test:run                      # run all tests once
pnpm build                         # build server + UI + CLI
pnpm db:generate                   # generate migration after schema change
pnpm db:migrate                    # apply pending migrations

# E2E
pnpm exec playwright test --config tests/e2e/playwright-multiuser.config.ts
pnpm exec playwright test --config tests/e2e/playwright-multiuser-authenticated.config.ts
```

Run the regression suite before any handoff:

```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

---

## Documentation

| Doc | What it covers |
|---|---|
| [doc/LAUNCH.md](doc/LAUNCH.md) | From clean clone to first paying customer |
| [doc/UPSTREAM-POLICY.md](doc/UPSTREAM-POLICY.md) | Cherry-pick rubric for paperclip upstream commits |
| [doc/DEVELOPING.md](doc/DEVELOPING.md) | Detailed dev guide |
| [doc/SPEC-implementation.md](doc/SPEC-implementation.md) | Inherited V1 build contract |
| [doc/PRODUCT.md](doc/PRODUCT.md) | Paperclip product overview (vendor doc) |
| [docs/superpowers/specs/](docs/superpowers/specs/) | Per-sub-project design specs (assess, billing, chat substrate, etc.) |
| [.claude/commands/](.claude/commands/) | MAW slash commands — PM, Builder, Tester, TPM, Admin, `/workon`, `/upstream-digest` |
| [CLAUDE.md](CLAUDE.md) | Codebase entry point for AI coding assistants |

---

## License

MIT, same as upstream. See [LICENSE](LICENSE).

Built on [Paperclip](https://github.com/paperclipai/paperclip) — credit and thanks to the Paperclip team for the agent harness AgentDash is built on.
