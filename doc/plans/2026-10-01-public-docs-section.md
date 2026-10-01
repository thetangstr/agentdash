# Public documentation: a Docs / API / MCP section on www.agentdash.cloud

2026-10-01 · Yang · **Built 2026-10-01 (#908, #911, #913, #914, #925 merged); go-live is draft #928, waiting on four owner decisions** · Asked for by the owner: "a documentation/api/mcp section on our pub site; it should cover the entirety of how to use our platform."

**Recommendation.** Serve the docs from the app's own public shell at `www.agentdash.cloud/docs`, driven by the `docs/docs.json` navigation that already exists, with the guide renderer the product already ships. Generate the three references that cannot be kept current by hand — the MCP tool reference (from the zod tool definitions), the HTTP route index (from the route files), and an OpenAPI 3.1 contract for the public API (from the shared validators and types) — and put a drift check on each. The owner has decided the HTTP API is a product, so the API section is a versioned contract with a key-management page and a deprecation policy, not a description of internals. Rebrand and prune the inherited Mintlify tree before any of it is public. Four pull requests; nothing is public until the routing change in the last one.

## What exists today

- **The public site is the app.** Root `vercel.json` builds `ui/dist`; the marketing pages are routes in `ui/src/App.tsx` (`/`, `/demo`, `/mcp`, `/pricing`, …) under `ui/src/marketing/pages/`, plus `ui/src/pages/McpPage.tsx`. The last rule in `vercel.json` sends every unlisted path to `/find`, so `/docs` is unreachable until that pattern changes.
- **A Mintlify tree nobody serves.** `docs/docs.json` defines six tabs (Get Started, Guides, Deploy, Adapters, API Reference, CLI) over 59 pages, run only by `pnpm docs:dev`. No deploy workflow, no hosted URL. 61 of the 79 user-facing files say "Paperclip"; the GitHub links point at `paperclip-ai/paperclip`; the first page is `start/what-is-paperclip`. Five pages are listed twice or not at all.
- **In-app guides.** `ui/src/lib/guides.ts` bundles six of those files (`docs/guides/steward/*`, two board-operator pages) and renders them at `/:company/guides` through `MarkdownBody` (mermaid included), substituting `{{instanceUrl}}` per instance. The renderer, the slug routing and the loader tests exist; only the public mount is missing.
- **HTTP API.** 80 route files, ~599 endpoints (measured by counting `router.<method>(` calls; approximate). No OpenAPI. Request bodies are zod validators in `packages/shared`. `docs/api/` has 13 hand-written pages covering roughly a dozen of the 80 files. Auth is one middleware (`server/src/middleware/auth.ts`) with seven actor sources.
- **MCP.** `packages/mcp-server` serves four toolsets — `agent` (76 tools), `setup` (17), `assistant` (17: read, work, gated), `human` (6) — plus an 8-tool bridge set, over stdio or streamable HTTP (`POST /api/mcp`, `POST /api/mcp/assistant` with OAuth 2.1). Every tool is defined with a zod input schema and an inline description. Its README describes two toolsets with a `paperclip*` prefix that no longer exists.
- **CLI.** `agentdash-connect` (npm, 0.3.0) has a current 213-line README and per-version notes. It is the only package AgentDash publishes.
- **Release notes.** `releases/*.md` are already parsed into the in-app changelog by `ui/src/lib/release-notes.ts`.
- **Private material that must stay off the site:** `doc/customers/**`, `sites/mkthink-docs/**`, `deploy/**` (names a customer instance), `doc/{IT-REQUEST,IT-REQUEST-EMAIL,SOP-onsite,MCP-LAUNCH}.md`. Also off the site, decided 2026-10-01: `docs/api/agentdash-mk.md` — the `agentdash_mk` profile belongs to a client and is not public; the Concepts page says only that product profiles exist. `docs/deploy/ross-private-host.md` is treated the same way unless the owner says otherwise.

## The decision: where the docs live

Three ways to serve them. **Decided 2026-10-01: the first.**

1. **In the app shell at `/docs`** *(recommended)*. A `Docs` route family in `App.tsx` beside the marketing pages; the sidebar built from `docs/docs.json`; pages loaded lazily with `import.meta.glob("../../docs/**/*.{md,mdx}", { query: "?raw", import: "default" })` and rendered by the existing `MarkdownBody`. One repo, one deploy, one renderer, one navigation file. The in-app guides and the public docs become the same files, so a guide a steward reads inside their instance is the page a prospect reads on the site. Cost: a markdown renderer in the marketing bundle (already there for guides), client-side search to build (a static index over headings and first paragraphs; ~a day), no API playground.
2. **Mintlify hosting at `docs.agentdash.cloud`.** The config exists; Mintlify renders OpenAPI and ships search. Cost: a second vendor and deploy, a subdomain, the `{{instanceUrl}}` token has no meaning there, and the in-app guides stay a separate render path. Reasonable if the API playground matters more than one deploy.
3. **A static generator (Astro Starlight) under `/docs` via a Vercel rewrite.** Best search and theming; a third build and a routing seam between two apps for the sake of docs. Not worth it at this size.

Option 1 follows "build less, solve more": the product already renders these files. If the owner wants a hosted API playground later, the generated OpenAPI from phase 3 can be dropped into Mintlify or Scalar without redoing the content.

## Information architecture

Top-level nav, in reading order. Every page is a markdown file under `docs/`; the nav is `docs/docs.json` (kept, so `pnpm docs:dev` still previews locally).

| Section | Pages | Source today | Work |
|---|---|---|---|
| **Get started** | What AgentDash is · Start on AgentDash Cloud · Your first company and agent · Connect your terminal · (Self-host is a link to Deploy, not the main path) | `docs/start/*` (5) | Rebrand, merge `first-agent` into the nav, rewrite the opening page for AgentDash |
| **Concepts** | Companies · Agents, roles and autonomy · Stewardship · Issues, projects, goals · Approvals and Decisions · Mandates and directives · Heartbeats and runs · Workforce roles · Agent visibility · Product profiles | `docs/start/core-concepts.md`, `doc/SPEC.md`, `docs/guides/board-operator/agent-kinds-and-stewardship.md` | One page per concept, each citing the schema file it describes; most are new |
| **Guides** | Steward (4) · Board operator (13) · Agent developer (7) | `docs/guides/**` | Rebrand; fix the two duplicate nav entries; add the two unlisted pages or delete them |
| **Deploy** | Docker image · Mac mini (launchd) · VPS · Railway · Backups · OTA updates and rollback · Instance settings | `docs/deploy/*` (12), `doc/DOCKER.md`, `doc/DEPLOYMENT-MODES.md` | Prune to what AgentDash supports; `ross-private-host` reviewed or dropped |
| **Adapters** | One page per built-in adapter type (11) | `docs/adapters/*` (10) | Add the two unlisted (`hermes-local`, `gemini-local`), one missing |
| **API** | Overview and what is covered by the contract · API keys (board keys, agent keys, scopes; minting and revoking) · Authentication (the seven actor sources) · Conventions (ids, pagination, errors, visibility 404-not-403, rate limits) · **Reference, generated from OpenAPI, one page per resource** (companies, agents, issues, projects, goals, approvals, routines, costs, activity, dashboard, secrets, human control, bridge, health, MCP endpoints, OAuth) · Versioning and deprecation policy · Changelog (API-affecting lines from `releases/*.md`) · **Route index (generated)** for everything outside the contract | `docs/api/*` (13) + generated | Phase 3 |
| **MCP** | Connecting (stdio, HTTP, OAuth for assistants) · Toolsets · **Tool reference (generated, one page per toolset)** · Resources · Playbooks | `McpPage.tsx` steps, `packages/mcp-server` | Phase 2 |
| **CLI** | `agentdash-connect` · `agentdash-mcp` · `paperclipai` CLI | `packages/connect/README.md`, `docs/cli/*` | Lift the README into a page; keep one source |
| **Reference** | Release notes (from `releases/*.md`) · Agent configuration text (`/llms/*.txt`) · Environment variables · FAQ | exists | Wire the existing parser; audit `faq.mdx` for internal bug numbers |

## Generated references and drift checks

Hand-written references for 599 endpoints and 124 tools will be wrong within a week. Two generators, each with a CI check modelled on `scripts/ci/check-hermes-prompt-drift.mjs`:

- **MCP tool reference** — `scripts/docs/generate-mcp-reference.mjs` imports `buildToolSurface` from `packages/mcp-server/src/index.ts` for each of `setup | agent | assistant | human` plus the bridge set, and writes `docs/mcp/tools/<toolset>.md`: tool name, description (the inline string), and the input schema rendered from zod (`packages/mcp-server/src/schema.ts` already converts it to JSON Schema). Resources (`agentdash://*`) and the four playbook constants are emitted the same way. The check fails a PR whose generated output differs from what is committed.
- **HTTP route index** — `scripts/docs/generate-route-index.mjs` walks `server/src/routes/*.ts`, extracts `method + path` per `router.<method>(` call and the file's mount prefix from `server/src/app.ts`, and writes `docs/api/route-index.md` grouped by file, with a link to the hand-written page where one exists. This is the completeness backstop: every endpoint is at least listed. Count stated as measured in the page header.
- **OpenAPI 3.1 contract** — `docs/api/openapi.yaml`, committed and served at `/docs/api/openapi.yaml` and rendered in the docs by an embedded reference component (Scalar, `@scalar/api-reference`, bundled, no vendor account). Produced by `scripts/docs/generate-openapi.mjs` from three inputs that exist today: request bodies from the zod validators in `packages/shared/src/validators/*` (via `zod-to-openapi`), response shapes from the 50 type files in `packages/shared/src/types/*` (via `ts-json-schema-generator`), and the method+path list from the route-index generator. What no generator can know — which routes are *in* the contract, the one-line purpose of each, the error cases, examples — lives in one hand-maintained manifest, `docs/api/contract.json` (route → operationId, summary, request validator, response type, stability). Two drift checks: every contract route must exist in the route index (a renamed route fails CI), and every generated schema must match its validator or type (a changed field fails CI). A route that is not in the manifest is listed in the route index as *internal* and carries no promise.
- **Prerequisites to verify in PR 3, not assume:** `board_api_keys` exists as a table and the middleware accepts board keys, but whether a person can mint and revoke a key from the UI, and whether scopes narrower than "the whole board" exist, is to be read from `routes/access.ts` before the API-keys page is written. `middleware/rate-limit.ts` exists; its limits are stated on the Conventions page as measured from the code, not promised.

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

1. **PR 1 — the shell, nothing public.** *Done: #908.* `pages/Docs.tsx`, nav from `docs/docs.json`, lazy loader, search index, tests (route tests in the style of `guides-routes.test.tsx`: visit every page in the nav, assert the heading renders and no `{{` token survives). `vercel.json` untouched, so the section is reachable only in local builds and on instances. *Estimate: 2 days.*
2. **PR 2 — MCP and CLI.** *Done: #911.* Generator + drift check for the tool reference; `docs/mcp/*` pages for connecting, toolsets, resources, playbooks; `packages/mcp-server/README.md` rewritten to point at them; `agentdash-connect` README lifted into `docs/cli/`. *Estimate: 2 days.*
3. **PR 3a — API foundations.** *Done: #913.* Route-index generator + drift check; `contract.json` seeded with the resources named above; the OpenAPI generator and its drift checks; Scalar embedded at `/docs/api/reference`; Authentication rewritten from `middleware/auth.ts`; Conventions page; API-keys page after reading `routes/access.ts`. *Estimate: 5 days.*
   **PR 3b — API content.** *Done: #914.* One page per contract resource with purpose, examples and error cases; Human control and Bridge from `doc/HUMAN-CONTROL.md` and `routes/bridge.ts`; the versioning and deprecation policy (proposal: the contract is `v1`, additive changes ship freely, a removal or rename is announced in release notes one stable before it lands and the old shape is kept for 60 days); the API changelog wired to `releases/*.md`. *Estimate: 5 days.*
4. **PR 4 — content pass.** *Done: #925 (the go-live routing and product links were split into #928, a draft, so the owner controls the moment).* Rebrand sweep of `docs/start`, `docs/guides`, `docs/deploy`, `docs/adapters`; Concepts pages; prune the private and engagement-specific files; the forbidden-token scan; `vercel.json` allowlist; `/mcp` marketing page links into `/docs/mcp`. *Estimate: 3 days.*

Total: about 17 working days for one person — 10 for the docs, 7 more for the API contract. Estimate, not a measurement. Measured: the five content PRs were written, reviewed in a separate lane, and merged in one day (2026-10-01) by Claude Code executors on Opus with the owner deciding; each PR went through at least one review-and-fix round. PRs 2 and 3a are independent of each other once PR 1 is in; 3b follows 3a.

## Risks and what is left out

- **A stale page on a public site is worse than none.** The two generators and their drift checks are the answer for the reference halves; the prose halves rely on the content rules and review.
- **Publishing the whole `docs/` tree exposes inherited pages that describe Paperclip, not AgentDash.** PR 4 is a prune as much as a rebrand; a page that cannot be made true is deleted, not left.
- **Bundle size.** 128 markdown files lazily imported add nothing to the initial bundle; the search index is one JSON fetch. Measure in PR 1.
- **A published contract is a promise.** Every route in `contract.json` becomes something a customer may build on; the drift checks stop silent breakage, but a deliberate change still costs a deprecation cycle. Keep the first contract small — the resources listed above, not the 599 — and widen it when asked.
- **Not in scope:** SDK generation (the OpenAPI makes it possible later), versioned docs per release, translations, a comments/feedback widget. The Scalar reference includes a try-it panel, so a separate playground is not needed.

## Decisions

Recorded 2026-10-01 from the owner.

1. **Hosting: in-app at `/docs`.** Mintlify stays a local preview only.
2. **Get started leads with AgentDash Cloud.** Self-host is reached from Deploy.
3. **The `agentdash_mk` profile is a client's and not public.** Its API page leaves the nav; the forbidden-token scan covers the profile name in user-facing pages.
4. **The HTTP API is a product.** Decided 2026-10-01 over the proposal to treat MCP and webhooks as the only integration surface. Consequences: an OpenAPI 3.1 contract generated from the shared validators and types, a hand-maintained manifest naming what is in the contract, an API-keys page, a versioning and deprecation policy, and two more drift checks — PR 3 splits into 3a and 3b and the estimate rises by about seven days. The contract starts with the resources named in the API row and widens on request; everything else stays listed in the route index as internal.

## What building it exposed (recorded 2026-10-01)

- **Board API keys have no UI.** A person can mint one only through the CLI sign-in handshake (`routes/access.ts:2647-2778`), it expires in 30 days, has no scopes, and can only revoke itself. "API is a product" needs a key-management page — server and UI work outside this plan.
- **Stewardship is a per-workspace capability.** A default Cloud workspace shows My Agent as "Available on request", so Get started cannot promise a terminal connection without the operator switching it on.
- **Two pre-existing exposures in the main www bundle**, independent of the docs: a hard-coded client brief (`ui/src/components/UnprefixedBoardRedirect.tsx:49`) and the in-app changelog bundling `releases/*.md`. Owner decision pending.
- **Server bugs filed from the contract work:** #916, #917, #918, #919, #920, #921, #926, #927; test flake #910; MCP schema bug #912.
- **The generated references held.** The MCP reference is read from a running server over an in-memory transport; the route index, OpenAPI contract and changelog are regenerated in CI and fail on drift; a renamed route, a changed validator, or a route that refuses agents but is listed as agent-callable now fails the PR.
