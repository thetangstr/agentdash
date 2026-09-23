# Muse MCP spike — findings (GH #674, spec §6.6)

**Status: scaffold — founder run pending.** The stub server
(`tools/spikes/muse-mcp-stub/`) is built and locally verified; the founder
runs Meta Muse, Grok, and Claude.ai against it per
`tools/spikes/muse-mcp-stub/FOUNDER-RUNBOOK.md` and reports back on #674.
The tables below are filled from the run's `requests.log` + screenshots when
that lands.

## Stub under test

| Item | Value |
|---|---|
| MCP endpoint | `https://<STUB_HOST>/mcp` — Streamable HTTP, stateless |
| Spec | MCP 2025-11-25 authorization: PRM (RFC 9728) + `WWW-Authenticate` 401, AS metadata (RFC 8414), PKCE S256, `resource` (RFC 8707), DCR (`/register`), CIMD, static-bearer flag |
| Tools | `echo`, `whoami` (returns authenticated subject + registration path) |
| Evidence store | `requests.log` (JSONL, headers minus secrets, body, OAuth lifecycle events) |

## Per-client findings

### Meta Muse

| Cell | Result |
|---|---|
| Where connectors are added | _pending founder run_ |
| Registration | _pending_ |
| Discovery (PRM / WWW-Authenticate read) | _pending_ |
| Scopes requested | _pending_ |
| `resource` sent | _pending_ |
| Redirect URIs | _pending_ |
| Transport + protocol version | _pending_ |
| Annotations / elicitation honoured | _pending_ |
| Sentinel confirmation (form, deniable?) | _pending_ |
| Per-user server URL in directory | _pending_ |

Evidence: _link log excerpts + screenshots_

### Grok (control)

| Cell | Result |
|---|---|
| Where connectors are added | _pending_ |
| Registration | _pending_ |
| Discovery | _pending_ |
| Scopes requested | _pending_ |
| `resource` sent | _pending_ |
| Redirect URIs | _pending_ |
| Transport + protocol version | _pending_ |
| Annotations / elicitation | _pending_ |
| Confirmation UX | _pending_ |

### Claude.ai (reference control)

| Cell | Result |
|---|---|
| Where connectors are added | _pending_ |
| Registration | _pending_ |
| Discovery | _pending_ |
| Scopes requested | _pending_ |
| `resource` sent | _pending_ |
| Redirect URIs | _pending_ |
| Transport + protocol version | _pending_ |

## Outcome

_pending — one of:_

- **A. Custom connector URL with standard OAuth** — design stands; M2 implements exactly what Muse used.
- **B. Directory-only (reviewed listing)** — submit once M5 passes on Grok; Grok is the interim launch client; §6.5 single-URL front door becomes a follow-up.
- **C. Static API-key header only** — personal assistant key (§6.4) moves from M5 into M2 as Muse's primary path.
- **D. No remote MCP for third parties** — Grok is the launch client; re-check Muse monthly.

## Implied M2 changes

_pending — filled from the outcome (e.g. DCR required vs CIMD unused, scopes
Muse requests, redirect hosts to allow, whether the AS must accept
pre-registered client_ids)._
