# Public documentation: a Docs / API / MCP section on www.agentdash.cloud

2026-10-01 · Yang · **Draft for review** · Asked for by the owner: "a documentation/api/mcp section on our pub site; it should cover the entirety of how to use our platform."

**Recommendation.** Serve the docs from the app's own public shell at `www.agentdash.cloud/docs`, driven by the `docs/docs.json` navigation that already exists, with the guide renderer the product already ships. Generate the two references that cannot be kept current by hand — the MCP tool reference (from the zod tool definitions) and the HTTP route index (from the route files) — and put a drift check on each. Rebrand and prune the inherited Mintlify tree before any of it is public. Four pull requests; nothing is public until the routing change in the last one.

## What exists today

- **The public site is the app.** Root `vercel.json` builds `ui/dist`; the marketing pages are routes in `ui/src/App.tsx` (`/`, `/demo`, `/mcp`, `/pricing`, …) under `ui/src/marketing/pages/`, plus `ui/src/pages/McpPage.tsx`. The last rule in `vercel.json` sends every unlisted path to `/find`, so `/docs` is unreachable until that pattern changes.
- **A Mintlify tree nobody serves.** `docs/docs.json` defines six tabs (Get Started, Guides, Deploy, Adapters, API Reference, CLI) over 59 pages, run only by `pnpm docs:dev`. No deploy workflow, no hosted URL. 61 of the 79 user-facing files say "Paperclip"; the GitHub links point at `paperclip-ai/paperclip`; the first page is `start/what-is-paperclip`. Five pages are listed twice or not at all.
- **In-app guides.** `ui/src/lib/guides.ts` bundles six of those files (`docs/guides/steward/*`, two board-operator pages) and renders them at `/:company/guides` through `MarkdownBody` (mermaid included), substituting `{{instanceUrl}}` per instance. The renderer, the slug routing and the loader tests exist; only the public mount is missing.
- **HTTP API.** 80 route files, ~599 endpoints (measured by counting `router.<method>(` calls; approximate). No OpenAPI. Request bodies are zod validators in `packages/shared`. `docs/api/` has 13 hand-written pages covering roughly a dozen of the 80 files. Auth is one middleware (`server/src/middleware/auth.ts`) with seven actor sources.
- **MCP.** `packages/mcp-server` serves four toolsets — `agent` (76 tools), `setup` (17), `assistant` (17: read, work, gated), `human` (6) — plus an 8-tool bridge set, over stdio or streamable HTTP (`POST /api/mcp`, `POST /api/mcp/assistant` with OAuth 2.1). Every tool is defined with a zod input schema and an inline description. Its README describes two toolsets with a `paperclip*` prefix that no longer exists.
- **CLI.** `agentdash-connect` (npm, 0.3.0) has a current 213-line README and per-version notes. It is the only package AgentDash publishes.
- **Release notes.** `releases/*.md` are already parsed into the in-app changelog by `ui/src/lib/release-notes.ts`.
- **Private material that must stay off the site:** `doc/customers/**`, `sites/mkthink-docs/**`, `deploy/**` (names a customer instance), `doc/{IT-REQUEST,IT-REQUEST-EMAIL,SOP-onsite,MCP-LAUNCH}.md`. To review before publishing: `docs/deploy/ross-private-host.md` and `docs/api/agentdash-mk.md` (both tied to specific engagements or profiles).

## The decision: where the docs live

Three ways to serve them. The recommendation is the first.

1. **In the app shell at `/docs`** *(recommended)*. A `Docs` route family in `App.tsx` beside the marketing pages; the sidebar built from `docs/docs.json`; pages loaded lazily with `import.meta.glob("../../docs/**/*.{md,mdx}", { query: "?raw", import: "default" })` and rendered by the existing `MarkdownBody`. One repo, one deploy, one renderer, one navigation file. The in-app guides and the public docs become the same files, so a guide a steward reads inside their instance is the page a prospect reads on the site. Cost: a markdown renderer in the marketing bundle (already there for guides), client-side search to build (a static index over headings and first paragraphs; ~a day), no API playground.
2. **Mintlify hosting at `docs.agentdash.cloud`.** The config exists; Mintlify renders OpenAPI and ships search. Cost: a second vendor and deploy, a subdomain, the `{{instanceUrl}}` token has no meaning there, and the in-app guides stay a separate render path. Reasonable if the API playground matters more than one deploy.
3. **A static generator (Astro Starlight) under `/docs` via a Vercel rewrite.** Best search and theming; a third build and a routing seam between two apps for the sake of docs. Not worth it at this size.

Option 1 follows "build less, solve more": the product already renders these files. If the owner wants a hosted API playground later, the generated OpenAPI from phase 3 can be dropped into Mintlify or Scalar without redoing the content.

## Information architecture

Top-level nav, in reading order. Every page is a markdown file under `docs/`; the nav is `docs/docs.json` (kept, so `pnpm docs:dev` still previews locally).

| Section | Pages | Source today | Work |
|---|---|---|---|
| **Get started** | What AgentDash is · Install (hosted vs self-host) · Your first company and agent · Connect your terminal | `docs/start/*` (5) | Rebrand, merge `first-agent` into the nav, rewrite the opening page for AgentDash |
| **Concepts** | Companies · Agents, roles and autonomy · Stewardship · Issues, projects, goals · Approvals and Decisions · Mandates and directives · Heartbeats and runs · Workforce roles · Agent visibility · Product profiles | `docs/start/core-concepts.md`, `doc/SPEC.md`, `docs/guides/board-operator/agent-kinds-and-stewardship.md` | One page per concept, each citing the schema file it describes; most are new |
| **Guides** | Steward (4) · Board operator (13) · Agent developer (7) | `docs/guides/**` | Rebrand; fix the two duplicate nav entries; add the two unlisted pages or delete them |
| **Deploy** | Docker image · Mac mini (launchd) · VPS · Railway · Backups · OTA updates and rollback · Instance settings | `docs/deploy/*` (12), `doc/DOCKER.md`, `doc/DEPLOYMENT-MODES.md` | Prune to what AgentDash supports; `ross-private-host` reviewed or dropped |
| **Adapters** | One page per built-in adapter type (11) | `docs/adapters/*` (10) | Add the two unlisted (`hermes-local`, `gemini-local`), one missing |
| **API** | Overview · Authentication (the seven actor sources) · Errors and visibility (404-not-403) · Core resources (companies, agents, issues, projects, goals, approvals, routines, costs, activity, dashboard, secrets) · Human control · Bridge · Health · **Route index (generated)** | `docs/api/*` (13) + generated | Phase 3 |
| **MCP** | Connecting (stdio, HTTP, OAuth for assistants) · Toolsets · **Tool reference (generated, one page per toolset)** · Resources · Playbooks | `McpPage.tsx` steps, `packages/mcp-server` | Phase 2 |
| **CLI** | `agentdash-connect` · `agentdash-mcp` · `paperclipai` CLI | `packages/connect/README.md`, `docs/cli/*` | Lift the README into a page; keep one source |
| **Reference** | Release notes (from `releases/*.md`) · Agent configuration text (`/llms/*.txt`) · Environment variables · FAQ | exists | Wire the existing parser; audit `faq.mdx` for internal bug numbers |

## Generated references and drift checks

Hand-written references for 599 endpoints and 124 tools will be wrong within a week. Two generators, each with a CI check modelled on `scripts/ci/check-hermes-prompt-drift.mjs`:

- **MCP tool reference** — `scripts/docs/generate-mcp-reference.mjs` imports `buildToolSurface` from `packages/mcp-server/src/index.ts` for each of `setup | agent | assistant | human` plus the bridge set, and writes `docs/mcp/tools/<toolset>.md`: tool name, description (the inline string), and the input schema rendered from zod (`packages/mcp-server/src/schema.ts` already converts it to JSON Schema). Resources (`agentdash://*`) and the four playbook constants are emitted the same way. The check fails a PR whose generated output differs from what is committed.
- **HTTP route index** — `scripts/docs/generate-route-index.mjs` walks `server/src/routes/*.ts`, extracts `method + path` per `router.<method>(` call and the file's mount prefix from `server/src/app.ts`, and writes `docs/api/route-index.md` grouped by file, with a link to the hand-written page where one exists. This is the completeness backstop: every endpoint is at least listed. Count stated as measured in the page header.
- **OpenAPI** — *not* in scope for the first cut. The validators in `packages/shared` can feed `zod-to-openapi` for request bodies, but responses are untyped at the route layer, so a generated spec would be bodies-only. Phase 4 candidate, after the route index shows which families people actually read.

## Server and routing changes

- `vercel.json`: add `docs` to the allowlist in the final `/:path((?!api/|api$).*)` rule's exclusion list so `/docs/*` reaches the SPA. One line. Do it last.
- `ui/src/App.tsx`: `/docs` and `/docs/*` public routes rendering `pages/Docs.tsx`; the company-prefixed `/:company/guides/*` keeps working and links across.
- `ui/src/lib/guides.ts` → generalised to `docs.ts`: load the whole `docs/` tree (lazy), read `docs/docs.json` for nav and ordering, keep `{{instanceUrl}}` substitution (on the public site it resolves to `https://www.agentdash.cloud` or stays a literal placeholder; decide in review).
- `ui/src/lib/company-routes.ts`: `docs` is not a board route root; nothing to add. Confirm the prefix helpers never read `/docs` as a company code (the `company-routes` test covers this).
- Search: a build-time index (`scripts/docs/build-search-index.mjs` → `docs/.search.json`, headings + first paragraph) and a client-side matcher. Small; no vendor.

## Content rules (CI-enforced where possible)

- No "Paperclip" in user-facing pages except the one page that explains the upstream relationship. Extend the existing forbidden-token scan (`scripts/ci/check-hermes-pr-audit.mjs` has the pattern) to `docs/**` with an allowlist for that page.
- No customer names, instance hostnames, IPs, or engagement names. Same scan: a list of forbidden tokens kept outside the public tree.
- Every page carries the file it describes where a claim is about code (`packages/db/src/schema/agents.ts`, …), the way `doc/plans/2026-09-30-agent-visibility.md` does.
- Numbers in docs are labelled measured or estimated. The route index and tool reference say which commit generated them.

## Rollout

1. **PR 1 — the shell, nothing public.** `pages/Docs.tsx`, nav from `docs/docs.json`, lazy loader, search index, tests (route tests in the style of `guides-routes.test.tsx`: visit every page in the nav, assert the heading renders and no `{{` token survives). `vercel.json` untouched, so the section is reachable only in local builds and on instances. *Estimate: 2 days.*
2. **PR 2 — MCP and CLI.** Generator + drift check for the tool reference; `docs/mcp/*` pages for connecting, toolsets, resources, playbooks; `packages/mcp-server/README.md` rewritten to point at them; `agentdash-connect` README lifted into `docs/cli/`. *Estimate: 2 days.*
3. **PR 3 — API.** Route-index generator + drift check; Authentication rewritten from `middleware/auth.ts`; Errors-and-visibility page; the 13 existing API pages rebranded and checked against the index; Human control and Bridge pages (from `doc/HUMAN-CONTROL.md` and `routes/bridge.ts`). *Estimate: 3 days.*
4. **PR 4 — content pass and go-live.** Rebrand sweep of `docs/start`, `docs/guides`, `docs/deploy`, `docs/adapters`; Concepts pages; prune the private and engagement-specific files; the forbidden-token scan; `vercel.json` allowlist; `/mcp` marketing page links into `/docs/mcp`. *Estimate: 3 days.*

Total: about 10 working days for one person, most of it writing. Estimate, not a measurement. PRs 2 and 3 are independent of each other once PR 1 is in.

## Risks and what is left out

- **A stale page on a public site is worse than none.** The two generators and their drift checks are the answer for the reference halves; the prose halves rely on the content rules and review.
- **Publishing the whole `docs/` tree exposes inherited pages that describe Paperclip, not AgentDash.** PR 4 is a prune as much as a rebrand; a page that cannot be made true is deleted, not left.
- **Bundle size.** 128 markdown files lazily imported add nothing to the initial bundle; the search index is one JSON fetch. Measure in PR 1.
- **Not in scope:** an API playground, SDK generation, versioned docs per release, translations, a comments/feedback widget. Each can be added on top of the same files.

## Open questions for the owner

1. **Hosting:** in-app at `/docs` (recommended) or Mintlify at `docs.agentdash.cloud`?
2. **Audience emphasis:** hosted cloud first or self-host first in Get started? Today the marketing site sells hosted; the deploy docs are self-host.
3. **Is the `agentdash_mk` product profile public?** If not, `docs/api/agentdash-mk.md` is dropped from the nav and the Concepts page says only that profiles exist.
4. **Does a third party ever call the HTTP API directly?** If yes, OpenAPI moves up to phase 3; if the API is only for our own MCP and UI, the route index is enough.
