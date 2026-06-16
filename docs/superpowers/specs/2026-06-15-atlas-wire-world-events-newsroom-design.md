# Atlas Wire — a world-events newsroom on AgentDash

**Date:** 2026-06-15
**Status:** Design approved, pending spec review
**Environment:** the existing demo AgentDash install on the Mac mini (same instance as the Meridian Pay × Clockchain demo)
**Related:** `project_meridian_clockchain_demo`, `reference_mini_heartbeat_executes_agents`, `reference_control_plane_api`

---

## 1. Problem & goal

We want to start gathering real-world data for the Clockchain by continuously logging significant **world events** — wars, scientific discoveries, major sports finals, market moves, disasters, court rulings, central-bank decisions, and more — each anchored on-chain with a verifiable receipt and enriched with research-oriented "inflection point" metadata.

The vehicle is a new AgentDash company — a **news agency** — living in the same demo AgentDash environment on the Mac mini. It is staffed by ~19 agents (an editor-in-chief CoS plus 18 beat reporters), each owning a realm of world events. The system should sustain **~300 events/day** logged to the Clockchain, look like a real, lived-in company in the AgentDash UI, and produce data that gets better over time for downstream research.

### Success criteria

- A real AgentDash company ("Atlas Wire") exists on the mini with 19 agents, a CoS-led goal tree, and a populated activity feed.
- A scheduled ingestion pipeline produces **~300 real events/day**, each: (a) authored by the correct beat agent in AgentDash, (b) attested/logged on the Clockchain with a real receipt, (c) stored with core + beat-specific fields.
- The mini stays stable — **no heartbeat-driven adapter crash-loop** (the 2026-06-11 failure mode).
- All standard checks pass: `pnpm -r typecheck && pnpm test:run && pnpm build`, plus unit tests for the new pipeline.

---

## 2. Hard constraints (non-negotiable)

1. **Never crash-loop the mini.** The heartbeat scheduler executes *active* agents by spawning adapter subprocesses; many active agents + in-progress issues caused an EPIPE crash-loop on 2026-06-11. Therefore **all 19 news agents are created and kept `paused`**, and the pipeline acts *as* them through the control-plane API, never via the heartbeat. API writes are not heartbeat spawns — this is the core safety guarantee. The pipeline asserts on startup that no news agent is active and refuses to run otherwise.
2. **Never use `claude` / `claude_local`** for any LLM work — it burns API credits and blocks the user. The pipeline's structured-extraction step calls the **MiniMax** API directly (Anthropic-compatible endpoint), the same models powering the Meridian agents.
3. **All testing happens on the mini** (or in pure unit tests), never against localhost AgentDash with the claude adapter.
4. **Secrets from env only** — MiniMax key, Clockchain MCP token, AgentDash board key, and per-agent keys are read from the mini's environment; nothing committed.

---

## 3. Architecture

```
launchd timer on the mini  (NOT the AgentDash heartbeat scheduler)
  │  fires every N minutes; work trickled across the day → ~300 events/day
  ▼
news-ingest service   (server/src/services/news-ingest/)
  ├─ feeds.ts          beat → [RSS/Atom feed URLs]  (editable config, no code change)
  ├─ fetcher           pull + parse each beat's feeds (failure-isolated per feed)
  ├─ dedupe            skip already-seen source URLs (hash persisted in DB)
  ├─ extractor         heuristics + ONE MiniMax structured-extract call per event
  │                      → entities, geo, confidence, beat-specific inflection fields
  ├─ clockchain writer rate-limited; writes via the beat's assigned MCP tool
  │                      → ledgerId / eventHash / blockHeight (real receipt)
  └─ agentdash writer  POST issue + activity AS the beat agent (x-agent-key auth)
                         with receipt attached and full record stored
```

### Why this shape

- **Deterministic engine, real agents.** The agents are first-class AgentDash records (identity, goals, org, authored issues/activity/receipts). Only the *trigger* differs from a normal AgentDash agent: a cron, not the heartbeat. This is what keeps the mini safe while keeping the agents genuinely "part of AgentDash."
- **Inside AgentDash, not separate.** The engine lives in `server/src/services/news-ingest/` alongside other AgentDash services and writes through the control-plane API + Clockchain MCP. Nothing lives outside AgentDash.

---

## 4. Components

### 4.1 Company & org

- **Company:** "Atlas Wire" — provisioned via the existing `agentdash*` MCP company-provisioning + CoS onboarding tools (`packages/mcp-server`), the same path Meridian used.
- **Editor-in-Chief (CoS):** Atlas — owns the goal tree and runs the daily digest.
- **18 beat agents,** each with a distinct Clockchain tool:

| # | Agent (beat) | Primary Clockchain tool |
|---|---|---|
| — | Atlas — Editor-in-Chief (CoS) | `generate_compliance_report` (daily digest) |
| 1 | Armed Conflict & War | `attest_action` |
| 2 | Geopolitics & Diplomacy | `verify_cross_party` |
| 3 | Elections & Governance | `log_action` |
| 4 | Science & Research | `build_evidence_package` |
| 5 | Health & Medicine | `attest_action` |
| 6 | Space & Astronomy | `get_timestamp` |
| 7 | Climate & Environment | `log_action` |
| 8 | Technology & AI | `mint_identity` (per lab/model) |
| 9 | Markets & Finance (Wall St) | `tsa_attest` |
| 10 | Crypto & Web3 | `verify_receipt` |
| 11 | Energy & Commodities | `log_action` |
| 12 | Sports — Major Events | `attest_action` |
| 13 | Disasters & Humanitarian | `build_evidence_package` |
| 14 | Law & Justice | `generate_audit_trail` |
| 15 | Business & Corporate | `attest_action` |
| 16 | Culture & Entertainment | `log_action` |
| 17 | Migration & Society | `verify_cross_party` |
| 18 | Macro & Central Banks | `tsa_checkpoint` |

All beat agents are created **paused**.

### 4.2 Goals (CoS-led tree)

- Company vision: "a verifiable public ledger of significant world events."
- Per-desk goal under the vision, e.g. "Armed Conflict: log every conflict inflection point (outbreak / escalation / ceasefire / resolution) with a court-grade receipt within the hour."

### 4.3 Event schema

**Core (every event):**
`eventType` (beat) · `title` · `summary` · `sourceUrl` · `sourceOutlet` · `occurredAt` · `ingestedAt` · `clockchainTime` (oracle `get_time` at write) · `ledgerId` · `eventHash` · `blockHeight` · `entities` (people/orgs/places) · `geo` (country/region) · `confidence`

**Beat-specific inflection fields:**
- **Wars/conflict:** `phase` (outbreak / escalation / ceasefire / resolution), `parties`, `casualtyEstimate`, `territoryChange`
- **Science:** `field`, `discoveryType` (paper / breakthrough / replication / retraction), `institution`, `doi`
- **Markets/macro:** `instrument`, `direction`, `magnitude` (%/$), `catalyst`
- **Sports:** `event`, `stage` (final / record / upset), `result`
- **Generic fallback:** `magnitude`, `noveltyScore`, `relatedTo` (links to prior event ids — the "inflection chain")

Extraction: cheap heuristics (regex/keyword) plus **one** MiniMax structured-extract call per event that returns the typed fields. The **core hash** (canonicalized core fields) is what gets attested on the Clockchain; the full record is stored on the AgentDash issue.

### 4.4 Sources

RSS/Atom-first. A `feeds.ts` config maps each beat to a curated set of official feeds (Reuters, AP, BBC, Al Jazeera, Nature, arXiv, ScienceDaily, SEC EDGAR, Fed, ESPN, etc.). Direct article-scraping for enrichment is an explicit **phase 2**, not day one.

### 4.5 Scheduling

A **launchd timer** on the mini fires the pipeline every N minutes (target cadence chosen so the day's work trickles to ~300 events without bursts). Explicitly **not** the AgentDash heartbeat.

---

## 5. Error handling & safety rails

- **Active-agent guard:** pipeline refuses to run if any Atlas Wire agent is `active` (protects the mini).
- **Clockchain rate limiting:** a queue with a small concurrency cap so 300/day never hammers the GCP MCP or testnet.
- **Idempotency:** keyed on source-URL hash; a re-run never double-logs.
- **Feed-failure isolation:** one dead/slow feed fails that feed only, not the beat or the run.
- **Backoff + caps:** per-run event cap and per-feed timeout so a runaway source can't blow the budget.

---

## 6. Seed / backfill

A one-time, idempotent backfill of the last ~5–7 days (where feeds expose history) so the company looks lived-in on day one — mirroring Meridian's backdated receipts — after which the cron carries it forward. Backfill is dry-run-checkable before it writes.

---

## 7. Testing

- `pnpm -r typecheck && pnpm test:run && pnpm build` (project gate).
- Unit tests: feed parser, dedupe, extractor (with a mocked MiniMax response), core-hash canonicalization, active-agent guard.
- **Dry-run mode:** fetch + extract + format with **no** Clockchain or AgentDash writes — validates the full pipeline on the mini without polluting data or touching the chain.
- Live smoke on the mini: a single-beat, low-cap run writing a handful of real events end-to-end (agent author + receipt + UI) before enabling the full schedule.

---

## 8. Phasing

1. **Phase 0 — company & org:** provision Atlas Wire, 19 agents (paused), goals. Verify in UI.
2. **Phase 1 — pipeline (core fields):** feeds → dedupe → core-field extract → Clockchain → AgentDash, with dry-run + unit tests. Single-beat live smoke.
3. **Phase 2 — beat inflection fields + MiniMax extraction:** add typed per-beat fields.
4. **Phase 3 — schedule + backfill:** launchd timer at target cadence; one-time backfill; daily Atlas digest.
5. **Phase 4 (later) — article-scraping enrichment** on top of RSS.

---

## 9. Out of scope (YAGNI)

- Real-time/streaming ingestion (daily-trickle cron is enough).
- A public-facing news website (this feeds the Clockchain + AgentDash; surfacing it externally is a separate project).
- Heartbeat-driven LLM agents (explicitly avoided for mini safety).
- Article full-text scraping on day one (phase 4).
